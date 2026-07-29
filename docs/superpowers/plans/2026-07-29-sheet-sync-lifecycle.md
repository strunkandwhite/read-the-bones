# Sheet Sync Reconciliation & Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Sheets→Turso sync self-healing: correct completion detection, reconcile post-hoc pick edits, and keep syncing matches after drafting ends via the `playing` phase.

**Architecture:** Three coordinated changes: (1) `parseSheetRows` declares a draft complete only when *every* pick cell is filled (not just the first drafter's cell in the ✪ row); (2) the incremental cron path (`incremental.ts`) becomes a full reconciler — it hash-compares picks, inserts missing positions, and updates positions whose card changed in the sheet; (3) the draft lifecycle gains a sync-driven `drafting → playing → complete` flow: picks-done drafts move to `playing` (still cron-synced, so matches and pick corrections keep flowing), and become `complete` when the full round robin is recorded or 60 days after the draft date.

**Tech Stack:** TypeScript, Next.js API routes, Turso (`@libsql/client`), vitest with mock-client pattern.

## Background (read this first)

Production evidence gathered 2026-07-29 (all verified against Turso and the live Google Sheets):

1. **Premature completion.** `isDraftComplete` (`src/core/parseSheetRows.ts:43`) checks only `row[2]` — the *first drafter's column* — of the ✪ marker row. When seat 1 finished their final picks ahead of the table, sync marked the draft `complete`. All five 2026-07-17 drafts (mockingbird, goose-mother, yorion, baleful-strix, ledger-shredder) are short: 432–434 of 450 picks in `pick_events`, while their sheets now hold all 450. Goose Mother: seat 1 has 45 picks, seats 2–10 have 43 each.
2. **Completed drafts never sync again.** The cron path (`getActiveDrafts` in `src/core/db/sync/lock.ts`) selects only `setup`/`drafting`. So the missing tail picks, all match results, and any post-hoc pick edits are permanently invisible.
3. **Post-hoc edits invisible to incremental sync.** `incrementalIngest` only inserts *missing positions*. Mockingbird seat 5 has **Thundering Falls at both pick 279 and pick 342**; the sheet says round 35 = **Fiery Islet** (someone corrected an accidental duplicate after that position had synced).
4. **Matches.** `match_events` has zero rows for all five July drafts; their Matches tabs have real results and player names that match the Draft tab exactly.
5. Latent bug: `insertNewPicks` resolves card names by exact match only and silently skips unresolved names — the fuzzy resolver `resolveCardNameToId` (DFC/alias/Scryfall fallbacks) exists in the same file but is not used by the insert path.

Phase model today (`src/core/draftPhases.ts`): `setup → drafting → playing → complete`; sync writes `complete` directly from `drafting`; `playing` is admin-only and never happens organically for sheet drafts. Stats already treat `playing` like `complete` (`isCompletedForStats`), the match-entry API and MatchMatrix UI already accept `playing`, so moving picks-done drafts to `playing` is safe for the app.

Design decision (confirmed with Jack): a `playing` draft auto-completes when all n·(n−1)/2 matches are recorded **or** the draft is older than 60 days; `pnpm draft:admin set-phase` remains as manual override.

## Global Constraints

- `pnpm precommit` must pass before push (typecheck → lint zero-warnings → knip → vitest → e2e). Knip means: deleted functions must be fully removed, never just unexported.
- All git commands use `git -C /Users/arpanet/dev/read-the-bones ...`. Never `cd X && git ...`.
- Commit messages: why-focused, 1–2 sentences, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No new dependencies. No schema migrations (all needed columns exist).
- Tests use the existing mock-client pattern (see `src/core/__tests__/sync.test.ts:26-53` and `src/core/db/sync/__tests__/sync.test.ts:11-79`).
- Run tests with `npx vitest run <path>` (or `pnpm test` for the full suite).

## File Structure

- Modify: `src/core/draftPhases.ts` — add `expectedMatchCount`, `isMatchesComplete`, `computeSyncTargetPhase`; extend `isSyncPhaseTransitionLegal`; rewrite the lifecycle header comment.
- Create: `src/core/draftPhases.test.ts` — unit tests for all lifecycle predicates.
- Modify: `src/core/parseSheetRows.ts` — delete `isDraftComplete`; compute `isComplete` from cell counts.
- Modify: `src/core/parseSheetRows.test.ts` — replace ✪-based completion tests.
- Modify: `src/core/db/sync/incremental.ts` — reconciliation: `getDbPicks`, `detectRemovedPicks`, `detectChangedPicks`, `applyChangedPicks`, fuzzy fallback in `insertNewPicks`, hash-gated `incrementalIngest`, `setDraftPhase`. Delete `getDbPickPositions`, `detectDivergence`, `markDraftComplete`.
- Modify: `src/core/__tests__/sync.test.ts` — update for the new incremental API.
- Modify: `src/core/db/sync/syncActiveDraft.ts` — pass stored hash into ingest; decide phase after matches sync.
- Create: `src/core/db/sync/__tests__/syncActiveDraft.test.ts` — cron-path phase decision tests.
- Modify: `src/core/db/sync/lock.ts` — `getActiveDrafts` includes `playing`; add `completeAgedPlayingDrafts`.
- Modify: `src/app/api/sync/route.ts` — call `completeAgedPlayingDrafts`; aggregate `picksUpdated`.
- Modify: `src/core/db/sync/index.ts` — CLI `syncDraft` uses `computeSyncTargetPhase`.
- Modify: `src/core/db/sync/__tests__/sync.test.ts` — completion tests now expect `playing` without matches, `complete` with full round robin.
- Modify: `CLAUDE.md` — document the new lifecycle.

---

### Task 1: Lifecycle predicates in draftPhases

**Files:**
- Modify: `src/core/draftPhases.ts`
- Create: `src/core/draftPhases.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 4, 5, 6):
  - `isMatchesComplete(matchCount: number, numSeats: number): boolean` — true at n·(n−1)/2 recorded matches (the round-robin count is an internal helper, not exported — a test-only export would trip knip)
  - `computeSyncTargetPhase(picksComplete: boolean, matchesComplete: boolean): "drafting" | "playing" | "complete"`
  - `isSyncPhaseTransitionLegal(currentPhase: string, targetPhase: string): boolean` — now also allows `setup|drafting|playing → playing`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/draftPhases.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  isMatchesComplete,
  computeSyncTargetPhase,
  isSyncPhaseTransitionLegal,
} from "./draftPhases";

describe("isMatchesComplete", () => {
  it("is complete when every round-robin match is recorded", () => {
    expect(isMatchesComplete(45, 10)).toBe(true); // 10 seats → 45 matches
    expect(isMatchesComplete(28, 8)).toBe(true); // 8 seats → 28 matches
    expect(isMatchesComplete(1, 2)).toBe(true); // 2 seats → 1 match
  });

  it("is incomplete while matches are missing", () => {
    expect(isMatchesComplete(44, 10)).toBe(false);
    expect(isMatchesComplete(0, 10)).toBe(false);
  });

  it("tolerates extra matches (double round robin)", () => {
    expect(isMatchesComplete(66, 12)).toBe(true);
  });

  it("is never complete with fewer than 2 seats", () => {
    expect(isMatchesComplete(0, 1)).toBe(false);
    expect(isMatchesComplete(0, 0)).toBe(false);
  });
});

describe("computeSyncTargetPhase", () => {
  it("targets drafting while picks are unfinished", () => {
    expect(computeSyncTargetPhase(false, false)).toBe("drafting");
    // matches can exist before picks finish (partial early entry) — still drafting
    expect(computeSyncTargetPhase(false, true)).toBe("drafting");
  });

  it("targets playing when picks are done but matches are not", () => {
    expect(computeSyncTargetPhase(true, false)).toBe("playing");
  });

  it("targets complete when picks and matches are both done", () => {
    expect(computeSyncTargetPhase(true, true)).toBe("complete");
  });
});

describe("isSyncPhaseTransitionLegal", () => {
  it("always allows advancing to complete", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "complete")).toBe(true);
    expect(isSyncPhaseTransitionLegal("playing", "complete")).toBe(true);
    expect(isSyncPhaseTransitionLegal("complete", "complete")).toBe(true);
  });

  it("allows moving into playing from setup, drafting, or playing", () => {
    expect(isSyncPhaseTransitionLegal("setup", "playing")).toBe(true);
    expect(isSyncPhaseTransitionLegal("drafting", "playing")).toBe(true);
    expect(isSyncPhaseTransitionLegal("playing", "playing")).toBe(true);
  });

  it("never demotes complete back to playing or drafting", () => {
    expect(isSyncPhaseTransitionLegal("complete", "playing")).toBe(false);
    expect(isSyncPhaseTransitionLegal("complete", "drafting")).toBe(false);
  });

  it("never demotes playing back to drafting", () => {
    expect(isSyncPhaseTransitionLegal("playing", "drafting")).toBe(false);
  });

  it("allows drafting from setup or drafting only", () => {
    expect(isSyncPhaseTransitionLegal("setup", "drafting")).toBe(true);
    expect(isSyncPhaseTransitionLegal("drafting", "drafting")).toBe(true);
  });

  it("rejects unknown target phases", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "setup")).toBe(false);
    expect(isSyncPhaseTransitionLegal("drafting", "bogus")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/draftPhases.test.ts`
Expected: FAIL — `expectedMatchCount`, `isMatchesComplete`, `computeSyncTargetPhase` are not exported; two `isSyncPhaseTransitionLegal` cases fail (`playing → playing` currently returns false).

- [ ] **Step 3: Implement**

In `src/core/draftPhases.ts`, replace the file header comment (lines 1–19) with:

```typescript
/**
 * Draft-phase lifecycle constants and predicates.
 *
 * A draft moves through these phases:
 *   setup → drafting → playing → complete
 *
 * For sheet drafts the sync process drives the lifecycle:
 *   drafting → playing   (every pick cell in the sheet is filled)
 *   playing  → complete  (full round robin recorded, or the 60-day age
 *                         backstop in completeAgedPlayingDrafts fires)
 *
 * 'playing' drafts keep syncing on the cron so late match entry and
 * post-hoc pick corrections in the sheet still reach the database.
 *
 * For stats purposes, drafts in 'playing' (drafting finished, matches ongoing)
 * count the same as 'complete' — both have all picks locked in.
 * Using 'complete' alone in stats queries omits live-match drafts and causes
 * Pick Score and pick history to disagree with the main card table.
 *
 * Sync must NEVER demote a phase (complete → playing, playing → drafting):
 * an admin may have advanced the phase manually, and demotion would clobber
 * that intent. pnpm draft:admin set-phase remains the manual override.
 */
```

Then replace `isSyncPhaseTransitionLegal` (keep `STATS_COMPLETE_PHASES`, `isCompletedForStats`, `statsPhaseFilter` unchanged) and add the new helpers:

```typescript
/** Number of matches in a full single round robin for a pod of numSeats. */
function expectedMatchCount(numSeats: number): number {
  return (numSeats * (numSeats - 1)) / 2;
}

/**
 * True when every round-robin match has been recorded. Extra matches
 * (double round robin) also count as complete. Never true for pods of
 * fewer than 2 seats — there is nothing meaningful to complete.
 */
export function isMatchesComplete(matchCount: number, numSeats: number): boolean {
  return numSeats >= 2 && matchCount >= expectedMatchCount(numSeats);
}

/**
 * The phase the sync process wants a sheet draft to be in, given what the
 * sheet currently shows. Matches entered before picks finish do not advance
 * the phase — picks completing is the gate into playing.
 */
export function computeSyncTargetPhase(
  picksComplete: boolean,
  matchesComplete: boolean,
): "drafting" | "playing" | "complete" {
  if (picksComplete && matchesComplete) return "complete";
  if (picksComplete) return "playing";
  return "drafting";
}

/**
 * Returns true when sync is allowed to write the given target phase.
 * Forward progress only — never demote a phase (see file header).
 */
export function isSyncPhaseTransitionLegal(
  currentPhase: string,
  targetPhase: string,
): boolean {
  if (targetPhase === "complete") return true;
  if (targetPhase === "playing") {
    return (
      currentPhase === "setup" ||
      currentPhase === "drafting" ||
      currentPhase === "playing"
    );
  }
  if (targetPhase === "drafting") {
    return currentPhase === "setup" || currentPhase === "drafting";
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/draftPhases.test.ts src/core/db/sync/__tests__/sync.test.ts`
Expected: PASS (the CLI syncDraft tests still pass — `isSyncPhaseTransitionLegal` changes are strictly additive).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/draftPhases.ts src/core/draftPhases.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Add sync-driven playing-phase lifecycle predicates

Picks-done sheet drafts will move to 'playing' instead of 'complete' so the
cron keeps syncing late matches and pick corrections.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: All-cells completion rule in parseSheetRows

**Files:**
- Modify: `src/core/parseSheetRows.ts`
- Modify: `src/core/parseSheetRows.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ParsedPicks.isComplete` now means "every pick cell in every round row is filled" (`picks.length === numDrafters * maxRound`). `isDraftComplete` is **deleted** (it was only called from `parsePickRows`; knip will flag it if left exported). The empty-input defaults change from `isComplete: true` to `isComplete: false`.

**Why the default flips:** today an empty/missing Draft tab reports `isComplete: true`, which lets `syncDraft` mark a brand-new draft `complete`. Under the new lifecycle that would immediately advance an empty draft to `playing`. `false` is the truthful value; a missing Draft tab must never advance any phase.

- [ ] **Step 1: Write the failing tests**

In `src/core/parseSheetRows.test.ts`:

1. Remove `isDraftComplete` from the import list (line 6) and delete the entire `describe("isDraftComplete", ...)` block (starts at line 91).
2. Replace the three existing `isComplete` tests inside the `parsePickRows` describe (lines 369–395, the tests titled "should return isComplete based on ✪ marker", "should return isComplete true when ✪ row has picks", "should return isComplete true when no ✪ marker") with:

```typescript
describe("completion detection (all cells filled)", () => {
  function rows(pickRows: string[][]): string[][] {
    return [
      [], // row 0
      [], // row 1
      ["", "", "Alice", "Bob", "↩"], // row 2: drafter names
      ...pickRows,
    ];
  }

  it("is complete when every drafter column in every round row is filled", () => {
    const { isComplete } = parsePickRows(
      rows([
        ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ["2", "↩", "Dark Ritual", "Swords to Plowshares", "B", "W"],
      ]),
      "test-draft",
    );
    expect(isComplete).toBe(true);
  });

  it("is incomplete when any cell in an earlier round is empty", () => {
    const { isComplete } = parsePickRows(
      rows([
        ["1", "→", "Lightning Bolt", "", "R", ""],
        ["2", "↩", "Dark Ritual", "Swords to Plowshares", "B", "W"],
      ]),
      "test-draft",
    );
    expect(isComplete).toBe(false);
  });

  it("is incomplete when only the first drafter finished the last round", () => {
    // Regression: goose-mother was marked complete when seat 1 filled the
    // final row while seats 2-10 were still drafting.
    const { isComplete } = parsePickRows(
      rows([
        ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ["2", "↩", "Dark Ritual", "", "B", ""],
      ]),
      "test-draft",
    );
    expect(isComplete).toBe(false);
  });

  it("is incomplete for sheets with no pick rows", () => {
    const { isComplete } = parsePickRows(rows([]), "test-draft");
    expect(isComplete).toBe(false);
  });

  it("is incomplete for empty or headers-only input", () => {
    expect(parsePickRows([], "test-draft").isComplete).toBe(false);
    expect(parsePickRows([[], [], []], "test-draft").isComplete).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/parseSheetRows.test.ts`
Expected: FAIL — the empty-input cases return `true`, and the "only the first drafter finished" case returns `true`.

- [ ] **Step 3: Implement**

In `src/core/parseSheetRows.ts`:

1. Delete the `isDraftComplete` function entirely (lines 37–55, including its doc comment). Keep `isArrow` — it is still used for drafter-row parsing.
2. In both early-return branches of `parsePickRows` (the `rows.length < 4` branch and the `numDrafters === 0` branch), change `isComplete: true` to `isComplete: false`.
3. Delete the line `const isComplete = isDraftComplete(rows);` (currently line 173, just above the copy-number tracker).
4. After the pick-row loop, immediately before the final `return`, add:

```typescript
  // A draft is complete only when every drafter column in every round row is
  // filled. Anything keyed off a single cell (the old ✪-marker check) marks
  // the draft complete as soon as the first drafter finishes, stranding the
  // other seats' final picks outside the sync window.
  const isComplete = maxRound > 0 && picks.length === numDrafters * maxRound;
```

5. Update the `ParsedPicks` interface doc: on the `isComplete` field add the comment `/** True only when every pick cell in every round row is filled. */`.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS. (The `syncDraft` completion fixtures fill every cell of their single numbered round row, so they are still "complete" under the new rule; the ✪ row has a non-numeric column A and was never parsed as picks. The full run is deliberate — the flipped empty-input default could surface in any consumer of `ParsedPicks.isComplete`; if another test asserts the old `true` default for empty input, update that assertion to `false`.)

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: clean — `isDraftComplete` has no remaining references.

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/parseSheetRows.ts src/core/parseSheetRows.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Declare a draft complete only when every pick cell is filled

The ✪-row check read a single drafter's cell, so a draft completed as soon as
seat 1 finished — stranding the other seats' final picks outside the sync
window (goose-mother and the four other 2026-07-17 drafts).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Pick reconciliation in the incremental path

**Files:**
- Modify: `src/core/db/sync/incremental.ts`
- Modify: `src/core/db/sync/syncActiveDraft.ts` (call-site only in this task)
- Modify: `src/core/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `hashPicks`, `updateDomainHashes`, `getDomainHashes` from `src/core/db/sync/domains.ts`; `resolveCardNameToId` (unchanged, same file).
- Produces (used by Task 4):
  - `interface DbPick { seat: number; cardId: number; cardName: string }` — module-internal, NOT exported (a test-only import would trip knip); tests build structurally-compatible object literals
  - `getDbPicks(client: Client, draftId: string): Promise<Map<number, DbPick>>` — replaces `getDbPickPositions` (deleted)
  - `detectRemovedPicks(csvPositions: ReadonlySet<number>, dbPositions: Iterable<number>): number[]` — replaces `detectDivergence` (deleted)
  - `interface PickChange { pick: CardPick; dbCardId: number; dbSeat: number }` — also module-internal, not exported
  - `detectChangedPicks(sheetPicks: CardPick[], dbPicks: ReadonlyMap<number, DbPick>): PickChange[]`
  - `applyChangedPicks(client: Client, draftId: string, changes: PickChange[]): Promise<{ updated: number; unresolved: number }>`
  - `insertNewPicks(client: Client, draftId: string, newPicks: CardPick[]): Promise<{ inserted: number; unresolved: number }>` — **return type changed** from `number`; now falls back to `resolveCardNameToId` for names the exact-match batch query misses
  - `incrementalIngest(client: Client, draftId: string, parsedPicks: ParsedPicks, storedPicksHash: string | null): Promise<{ status: "no_change" | "updated" | "completed" | "diverged"; picksInserted: number; picksUpdated: number }>` — **new 4th parameter, new `picksUpdated` field**
  - `detectNewPicks` unchanged. `markDraftComplete` unchanged in this task (Task 4 replaces it).

- [ ] **Step 1: Write the failing tests**

In `src/core/__tests__/sync.test.ts`:

1. Update the import block (lines 7–15) to:

```typescript
import {
  detectNewPicks,
  detectRemovedPicks,
  detectChangedPicks,
  getDbPicks,
  resolveCardNameToId,
  insertNewPicks,
  applyChangedPicks,
  markDraftComplete,
  incrementalIngest,
} from "../db/sync/incremental";
```

2. Replace `describe("detectDivergence", ...)` (lines 94–106) with:

```typescript
describe("detectRemovedPicks", () => {
  it("returns DB positions missing from the sheet", () => {
    expect(detectRemovedPicks(new Set([1, 2]), [1, 2, 3, 5])).toEqual([3, 5]);
  });

  it("returns empty when the sheet covers every DB position", () => {
    expect(detectRemovedPicks(new Set([1, 2, 3]), [1, 2])).toEqual([]);
  });
});
```

3. Replace `describe("getDbPickPositions", ...)` (lines 108–128) with:

```typescript
describe("getDbPicks", () => {
  it("returns empty map when no picks exist", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await getDbPicks(client as any, "draft-1")).toEqual(new Map());
  });

  it("returns stored picks keyed by position with seat, card id, and name", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" },
          { pick_n: 2, seat: 2, card_id: 20, name: "Counterspell" },
        ],
      }),
    };
    const result = await getDbPicks(client as any, "draft-1");
    expect(result.get(1)).toEqual({ seat: 1, cardId: 10, cardName: "Lightning Bolt" });
    expect(result.get(2)).toEqual({ seat: 2, cardId: 20, cardName: "Counterspell" });
  });
});

describe("detectChangedPicks", () => {
  // Structurally matches the module-internal DbPick shape
  const db = (seat: number, cardId: number, cardName: string) => ({
    seat,
    cardId,
    cardName,
  });

  it("flags a position whose card name changed in the sheet", () => {
    const changes = detectChangedPicks(
      [pick("Fiery Islet", 342, 4)],
      new Map([[342, db(5, 99, "Thundering Falls")]]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].pick.cardName).toBe("Fiery Islet");
    expect(changes[0].dbCardId).toBe(99);
  });

  it("does not flag unchanged picks (case-insensitive)", () => {
    expect(
      detectChangedPicks(
        [pick("lightning bolt", 1, 0)],
        new Map([[1, db(1, 10, "Lightning Bolt")]]),
      ),
    ).toEqual([]);
  });

  it("does not flag a front-face name against a stored DFC name", () => {
    expect(
      detectChangedPicks(
        [pick("Brazen Borrower", 1, 0)],
        new Map([[1, db(1, 10, "Brazen Borrower // Petty Theft")]]),
      ),
    ).toEqual([]);
  });

  it("flags a seat change even when the card matches", () => {
    const changes = detectChangedPicks(
      [pick("Lightning Bolt", 1, 3)], // sheet drafter index 3 → stored seat 4, DB has seat 1
      new Map([[1, db(1, 10, "Lightning Bolt")]]),
    );
    expect(changes).toHaveLength(1);
  });

  it("ignores positions not in the database", () => {
    expect(detectChangedPicks([pick("Lightning Bolt", 7, 0)], new Map())).toEqual([]);
  });
});

describe("applyChangedPicks", () => {
  it("updates card_id and seat when the resolved card differs", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Fiery Islet", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 1, unresolved: 0 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events"),
    );
    expect(updateCall![0].sql).toContain("SET card_id = ?, seat = ?");
    expect(updateCall![0].args).toEqual([55, 5, "draft-1", 342]);
  });

  it("is a no-op when the sheet name resolves to the stored card (alias)", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 99 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Fiery Islet", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 0, unresolved: 0 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events"),
    );
    expect(updateCall).toBeUndefined();
  });

  it("counts unresolvable names without updating", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Not A Real Card", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 0, unresolved: 1 });
  });
});
```

4. In `describe("insertNewPicks", ...)` (lines 189–246), update the existing assertions for the new return type, and extend the not-found test to cover the fuzzy fallback:
   - `expect(await insertNewPicks(client as any, "d", []))` → `.toEqual({ inserted: 0, unresolved: 0 })`
   - In "batch-resolves card names and inserts picks", the return assertion becomes `expect(result).toEqual({ inserted: 2, unresolved: 0 })` (adjust to that test's pick count).
   - Replace the test "skips picks whose card names are not found" with:

```typescript
  it("falls back to fuzzy resolution, and counts picks unresolved when that also fails", async () => {
    // Exact-match batch query returns only Lightning Bolt; "Mystery Card"
    // must go through resolveCardNameToId (whose Scryfall fallback is mocked
    // to return null), landing in unresolved.
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("IN (")) {
          return Promise.resolve({ rows: [{ card_id: 1, name: "Lightning Bolt" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await insertNewPicks(client as any, "test-draft", [
      pick("Lightning Bolt", 1, 0),
      pick("Mystery Card", 2, 1),
    ]);
    expect(result).toEqual({ inserted: 1, unresolved: 1 });
    expect(client.batch.mock.calls[0][0]).toHaveLength(1);
  });

  it("inserts via the fuzzy resolver when the exact batch query misses", async () => {
    // Batch query misses, but the per-name exact lookup inside
    // resolveCardNameToId hits — e.g. stored DFC name "Front // Back".
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("IN (")) return Promise.resolve({ rows: [] });
        if (sql.includes("LIKE LOWER(? || ' // %')")) {
          return Promise.resolve({ rows: [{ card_id: 42 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await insertNewPicks(client as any, "test-draft", [
      pick("Brazen Borrower", 1, 0),
    ]);
    expect(result).toEqual({ inserted: 1, unresolved: 0 });
    expect(client.batch.mock.calls[0][0][0].args).toEqual(["test-draft", 1, 1, 42]);
  });
```

5. Rewrite `describe("incrementalIngest", ...)` (lines 262–387). Every call gains the 4th argument. Replace the block with:

```typescript
describe("incrementalIngest", () => {
  function parsed(picks: CardPick[], isComplete = false) {
    return {
      picks,
      numDrafters: 2,
      drafterNames: ["Alice", "Bob"],
      isComplete,
      doublePickStartsAfterRound: null,
      picksPerPlayer: 1,
    };
  }

  // Routes the mock client by SQL shape: stored picks, exact-name batch
  // resolution, and a call log for inserts/updates/hash writes.
  function reconcilingClient(opts: {
    dbPicks: Array<{ pick_n: number; seat: number; card_id: number; name: string }>;
    cards: Array<{ card_id: number; name: string }>;
  }) {
    return {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("JOIN cards")) return Promise.resolve({ rows: opts.dbPicks });
        if (sql.includes("IN (")) return Promise.resolve({ rows: opts.cards });
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
  }

  it("returns no_change without touching the DB when the picks hash matches", async () => {
    const { hashPicks } = await import("../db/sync/domains");
    const picks = [pick("Lightning Bolt", 1, 0)];
    const client = reconcilingClient({ dbPicks: [], cards: [] });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed(picks),
      hashPicks(picks),
    );
    expect(result).toEqual({ status: "no_change", picksInserted: 0, picksUpdated: 0 });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("returns no_change when the sheet has no picks", async () => {
    const client = reconcilingClient({ dbPicks: [], cards: [] });
    const result = await incrementalIngest(client as any, "test-draft", parsed([]), null);
    expect(result.status).toBe("no_change");
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("returns diverged when the DB has positions the sheet lost", async () => {
    const client = reconcilingClient({
      dbPicks: [
        { pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_id: 20, name: "Counterspell" },
      ],
      cards: [],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0)]),
      null,
    );
    expect(result.status).toBe("diverged");
    expect(client.batch).not.toHaveBeenCalled();
  });

  it("inserts missing picks and updates the stored picks hash", async () => {
    const client = reconcilingClient({
      dbPicks: [{ pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" }],
      cards: [{ card_id: 20, name: "Counterspell" }],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)]),
      "stale-hash",
    );
    expect(result).toEqual({ status: "updated", picksInserted: 1, picksUpdated: 0 });
    const hashWrite = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("picks_hash"),
    );
    expect(hashWrite).toBeDefined();
  });

  it("updates a position whose card changed in the sheet", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("JOIN cards")) {
          return Promise.resolve({
            rows: [{ pick_n: 342, seat: 5, card_id: 99, name: "Thundering Falls" }],
          });
        }
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Fiery Islet", 342, 4)]),
      "stale-hash",
    );
    expect(result).toEqual({ status: "updated", picksInserted: 0, picksUpdated: 1 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events"),
    );
    expect(updateCall![0].args).toEqual([55, 5, "test-draft", 342]);
  });

  it("does not persist the picks hash while any pick is unresolved", async () => {
    const client = reconcilingClient({
      dbPicks: [],
      cards: [], // nothing resolves; Scryfall fallback mocked to null
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Mystery Card", 1, 0)]),
      "stale-hash",
    );
    expect(result.picksInserted).toBe(0);
    const hashWrite = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("picks_hash"),
    );
    expect(hashWrite).toBeUndefined();
  });

  it("marks the draft complete when the parsed sheet is complete", async () => {
    const client = reconcilingClient({
      dbPicks: [],
      cards: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)], true),
      null,
    );
    expect(result.status).toBe("completed");
    const phaseCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE drafts SET phase"),
    );
    expect(phaseCall).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/sync.test.ts`
Expected: FAIL — `detectRemovedPicks`, `detectChangedPicks`, `getDbPicks`, `applyChangedPicks` don't exist; `insertNewPicks` returns a number; `incrementalIngest` has the wrong arity.

- [ ] **Step 3: Implement in `src/core/db/sync/incremental.ts`**

Keep `detectNewPicks`, `resolveCardNameToId`, `resolveViaScryfall`, `markDraftComplete`, and `SCRYFALL_RATE_LIMIT_MS` unchanged. Add one combined import (one statement — a duplicate import would trip lint):

```typescript
import { hashPicks, updateDomainHashes } from "./domains";
```

Delete `detectDivergence` and `getDbPickPositions`. Add (note `DbPick` is intentionally NOT exported):

```typescript
/** A stored pick row, keyed by pick position in getDbPicks' result. */
interface DbPick {
  seat: number;
  cardId: number;
  cardName: string;
}

/**
 * Load all stored picks for a draft, keyed by pick position, including the
 * canonical card name so reconciliation can compare against sheet names
 * without resolving every position.
 */
export async function getDbPicks(
  client: Client,
  draftId: string,
): Promise<Map<number, DbPick>> {
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, pe.card_id, c.name
          FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?`,
    args: [draftId],
  });
  return new Map(
    result.rows.map((row) => [
      row.pick_n as number,
      {
        seat: row.seat as number,
        cardId: row.card_id as number,
        cardName: row.name as string,
      },
    ]),
  );
}

/**
 * DB positions that no longer exist in the sheet. Non-empty means picks were
 * removed or renumbered — a destructive change the incremental path must not
 * attempt; a CLI full sync (pnpm sync <draft-id>) is required.
 */
export function detectRemovedPicks(
  csvPositions: ReadonlySet<number>,
  dbPositions: Iterable<number>,
): number[] {
  return [...dbPositions].filter((n) => !csvPositions.has(n));
}

/**
 * Cheap name equivalence between a sheet pick and a stored canonical name:
 * exact (case-insensitive), or either face of a stored "Front // Back" DFC.
 * Anything else is a change *candidate* — applyChangedPicks resolves it
 * properly before touching the row, so alias spellings are not false updates.
 */
function namesMatch(sheetName: string, dbName: string): boolean {
  const s = sheetName.toLowerCase();
  const d = dbName.toLowerCase();
  return d === s || d.startsWith(`${s} // `) || d.endsWith(` // ${s}`);
}

interface PickChange {
  pick: CardPick;
  dbCardId: number;
  dbSeat: number;
}

/**
 * Positions present in both the sheet and the DB whose card or seat differ.
 * This is how a post-hoc sheet edit (e.g. correcting a duplicate pick) is
 * detected — the old insert-only path was blind to them.
 */
export function detectChangedPicks(
  sheetPicks: CardPick[],
  dbPicks: ReadonlyMap<number, DbPick>,
): PickChange[] {
  const changes: PickChange[] = [];
  for (const pick of sheetPicks) {
    const db = dbPicks.get(pick.pickPosition);
    if (!db) continue;
    const sheetSeat = pick.seat + 1; // 0-indexed → 1-indexed
    if (namesMatch(pick.cardName, db.cardName) && sheetSeat === db.seat) continue;
    changes.push({ pick, dbCardId: db.cardId, dbSeat: db.seat });
  }
  return changes;
}

/**
 * Resolve each change candidate and update the stored row when the card
 * actually differs. A candidate whose sheet name resolves to the stored
 * card_id is an alias spelling, not a change — skipped silently.
 */
export async function applyChangedPicks(
  client: Client,
  draftId: string,
  changes: PickChange[],
): Promise<{ updated: number; unresolved: number }> {
  let updated = 0;
  let unresolved = 0;
  for (const { pick, dbCardId, dbSeat } of changes) {
    const cardId = await resolveCardNameToId(client, pick.cardName);
    if (cardId === null) {
      console.warn(
        `[sync] Cannot resolve changed pick "${pick.cardName}" at position ${pick.pickPosition} for draft ${draftId}`,
      );
      unresolved++;
      continue;
    }
    const seat = pick.seat + 1;
    if (cardId === dbCardId && seat === dbSeat) continue;
    await client.execute({
      sql: "UPDATE pick_events SET card_id = ?, seat = ? WHERE draft_id = ? AND pick_n = ?",
      args: [cardId, seat, draftId, pick.pickPosition],
    });
    console.log(
      `[sync] Pick ${pick.pickPosition} in ${draftId} changed: card_id ${dbCardId} → ${cardId} ("${pick.cardName}")`,
    );
    updated++;
  }
  return { updated, unresolved };
}
```

Replace `insertNewPicks` with (same doc comment, new body — note the fuzzy fallback and return type):

```typescript
/**
 * Insert new picks into pick_events for an active draft.
 * Card names are batch-resolved by exact match first; misses fall back to
 * resolveCardNameToId (DFC faces, aliases, Scryfall). Picks that still fail
 * to resolve are counted so the caller can keep the picks hash stale and
 * retry on the next run.
 */
export async function insertNewPicks(
  client: Client,
  draftId: string,
  newPicks: CardPick[],
): Promise<{ inserted: number; unresolved: number }> {
  if (newPicks.length === 0) return { inserted: 0, unresolved: 0 };

  // Batch-resolve all card names in a single query
  const uniqueNames = [
    ...new Set(newPicks.map((p) => normalizeCardName(p.cardName))),
  ];
  const result = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE LOWER(name) IN (${placeholders(uniqueNames.length)})`,
    args: uniqueNames.map((n) => n.toLowerCase()),
  });
  const nameToId = new Map<string, number>();
  for (const row of result.rows) {
    nameToId.set((row.name as string).toLowerCase(), row.card_id as number);
  }

  let unresolved = 0;
  const statements: Array<{ sql: string; args: (string | number)[] }> = [];
  for (const pick of newPicks) {
    const normalized = normalizeCardName(pick.cardName).toLowerCase();
    let cardId = nameToId.get(normalized);
    if (cardId === undefined) {
      const fuzzy = await resolveCardNameToId(client, pick.cardName);
      if (fuzzy === null) {
        console.warn(
          `[sync] Warning: Card "${pick.cardName}" not found for draft ${draftId}, skipping pick ${pick.pickPosition}`,
        );
        unresolved++;
        continue;
      }
      cardId = fuzzy;
      nameToId.set(normalized, fuzzy);
    }
    // pick.seat is 0-indexed from parsePickRows, convert to 1-indexed
    statements.push({
      sql: "INSERT OR IGNORE INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
      args: [draftId, pick.pickPosition, pick.seat + 1, cardId],
    });
  }

  if (statements.length > 0) {
    await client.batch(statements);
  }

  return { inserted: statements.length, unresolved };
}
```

Replace `incrementalIngest` with:

```typescript
/**
 * Reconcile a single active draft's picks against the sheet.
 *
 * Short-circuits on the stored picks hash, then:
 *   - diverged: the DB holds positions the sheet lost → CLI full sync needed
 *   - inserts positions missing from the DB
 *   - updates positions whose card (or seat) changed in the sheet
 *
 * The picks hash is persisted only when every sheet pick is reflected in the
 * DB — an unresolved card name keeps the hash stale so the next run retries.
 */
export async function incrementalIngest(
  client: Client,
  draftId: string,
  parsedPicks: ParsedPicks,
  storedPicksHash: string | null,
): Promise<{
  status: "no_change" | "updated" | "completed" | "diverged";
  picksInserted: number;
  picksUpdated: number;
}> {
  const { picks, isComplete } = parsedPicks;
  if (picks.length === 0) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }

  const newHash = hashPicks(picks.filter((p) => p.wasPicked));
  if (newHash === storedPicksHash) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }

  const dbPicks = await getDbPicks(client, draftId);

  const csvPositions = new Set(picks.map((p) => p.pickPosition));
  const removed = detectRemovedPicks(csvPositions, dbPicks.keys());
  if (removed.length > 0) {
    console.warn(
      `[sync] Divergence detected for draft ${draftId}: DB positions [${removed.join(", ")}] are missing from the sheet. Skipping — run pnpm sync to resolve.`,
    );
    return { status: "diverged", picksInserted: 0, picksUpdated: 0 };
  }

  const newPicks = detectNewPicks(picks, new Set(dbPicks.keys()));
  const { inserted, unresolved: insertUnresolved } = await insertNewPicks(
    client,
    draftId,
    newPicks,
  );
  if (inserted > 0) {
    console.log(`[sync] Inserted ${inserted} new picks for draft ${draftId}`);
  }

  const changes = detectChangedPicks(picks, dbPicks);
  const { updated, unresolved: changeUnresolved } = await applyChangedPicks(
    client,
    draftId,
    changes,
  );

  if (insertUnresolved === 0 && changeUnresolved === 0) {
    await updateDomainHashes(client, draftId, { picksHash: newHash });
  }

  if (isComplete) {
    await markDraftComplete(client, draftId);
    console.log(`[sync] Draft ${draftId} marked as complete`);
    return { status: "completed", picksInserted: inserted, picksUpdated: updated };
  }

  if (inserted === 0 && updated === 0) {
    return { status: "no_change", picksInserted: 0, picksUpdated: 0 };
  }
  return { status: "updated", picksInserted: inserted, picksUpdated: updated };
}
```

Update the module header comment (lines 1–10) to describe reconciliation:

```typescript
/**
 * Incremental pick reconciliation for active Sheets-based drafts.
 *
 * Used exclusively by the serverless cron path (GET /api/sync → syncActiveDraft).
 * The CLI path (scripts/sync.ts → syncAll → syncDraft) does full-domain hash-replace
 * and does NOT go through this module — it owns the complete pool/picks/matches pipeline.
 *
 * Reconciliation = insert positions the DB is missing + update positions whose
 * card changed in the sheet (post-hoc edits). Removed/renumbered positions are
 * a divergence the cron refuses to touch — those need a CLI full sync.
 */
```

- [ ] **Step 4: Update the call site in `src/core/db/sync/syncActiveDraft.ts`**

Add `getDomainHashes` to the existing `./domains` import, fetch stored hashes once before ingest, and pass the picks hash. Replace lines 72–84 with:

```typescript
  // Parse rows and reconcile picks (inserts + post-hoc edit updates)
  const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
  const stored = await getDomainHashes(client, draft.draftId);
  const ingestResult = await incrementalIngest(
    client,
    draft.draftId,
    parsedPicks,
    stored?.picksHash ?? null,
  );

  result.picksInserted = ingestResult.picksInserted;
  result.picksUpdated = ingestResult.picksUpdated;
  result.status = ingestResult.status;

  if (ingestResult.status === "diverged") {
    console.warn(
      `[sync] Draft ${draft.draftId} has diverged data — run pnpm sync to fix`,
    );
    result.diverged = true;
  }
```

In the matches block, delete the line `const stored = await getDomainHashes(client, draft.draftId);` and keep using the `stored` from above. Add `picksUpdated: number;` to `SyncActiveDraftResult` and `picksUpdated: 0,` to the result initializer. Remove `getDomainHashes` from the second import if it was imported twice.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/sync.test.ts && pnpm typecheck`
Expected: PASS, clean typecheck.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/db/sync/incremental.ts src/core/db/sync/syncActiveDraft.ts src/core/__tests__/sync.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Reconcile changed picks in incremental sync, not just missing ones

Post-hoc sheet edits (mockingbird's duplicate Thundering Falls → Fiery Islet)
were invisible to the insert-only path. Also route unresolved names through
the fuzzy resolver instead of silently dropping the pick.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Cron-path phase decision (drafting → playing → complete)

**Files:**
- Modify: `src/core/db/sync/incremental.ts` (remove phase writing)
- Modify: `src/core/db/sync/syncActiveDraft.ts` (own the phase decision)
- Modify: `src/core/__tests__/sync.test.ts`
- Create: `src/core/db/sync/__tests__/syncActiveDraft.test.ts`

**Interfaces:**
- Consumes: `computeSyncTargetPhase`, `isMatchesComplete`, `isSyncPhaseTransitionLegal` from Task 1; `incrementalIngest` from Task 3.
- Produces:
  - `setDraftPhase(client: Client, draftId: string, phase: "drafting" | "playing" | "complete"): Promise<void>` in `incremental.ts` — replaces `markDraftComplete` (deleted)
  - `incrementalIngest` return status narrows to `"no_change" | "updated" | "diverged"` and it no longer writes phase; the `isComplete` branch is removed
  - `SyncActiveDraftResult` gains `phaseSet: "drafting" | "playing" | "complete" | null`; `status` value `"completed"` now means "transitioned to complete"

- [ ] **Step 1: Write the failing tests**

1. In `src/core/__tests__/sync.test.ts`:
   - Change the import of `markDraftComplete` to `setDraftPhase`; replace `describe("markDraftComplete", ...)` with:

```typescript
describe("setDraftPhase", () => {
  it("writes the given phase for the draft", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    await setDraftPhase(client as any, "test-draft", "playing");
    expect(client.execute).toHaveBeenCalledWith({
      sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
      args: ["playing", "test-draft"],
    });
  });
});
```

   - In the `incrementalIngest` describe, replace the "marks the draft complete when the parsed sheet is complete" test with:

```typescript
  it("does not write any phase — the caller owns the lifecycle decision", async () => {
    const client = reconcilingClient({
      dbPicks: [],
      cards: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)], true),
      null,
    );
    expect(result.status).toBe("updated");
    const phaseCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE drafts SET phase"),
    );
    expect(phaseCall).toBeUndefined();
  });
```

2. Create `src/core/db/sync/__tests__/syncActiveDraft.test.ts`:

```typescript
// Phase-decision tests for the cron sync path. Sheet fetching is mocked;
// the mock client is routed by SQL shape like the other sync tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncActiveDraft } from "../syncActiveDraft";
import { fetchDraftTabsRaw } from "../../../sheets";
import type { DraftSheetRawData } from "../../../sheets";

vi.mock("../../../sheets", () => ({
  fetchDraftTabsRaw: vi.fn(),
}));

const mockFetch = vi.mocked(fetchDraftTabsRaw);

function sheet(opts: {
  bobPicked?: boolean;
  matches?: Array<[string, number, string, number]>;
}): DraftSheetRawData {
  return {
    pool: null,
    picks: [
      [],
      [],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Lightning Bolt", opts.bobPicked === false ? "" : "Counterspell", "R", "U"],
    ],
    matches: opts.matches
      ? [
          [],
          [],
          [],
          ...opts.matches.map(([p1, w1, p2, w2]) => [
            "",
            p1,
            String(w1),
            "VS",
            String(w2),
            p2,
          ]),
        ]
      : null,
  };
}

function phaseClient(opts: {
  phase: string;
  dbPicks?: Array<{ pick_n: number; seat: number; card_id: number; name: string }>;
}) {
  return {
    execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
      if (sql.includes("pool_hash")) {
        return Promise.resolve({
          rows: [
            {
              pool_hash: null,
              picks_hash: null,
              matches_hash: null,
              phase: opts.phase,
            },
          ],
        });
      }
      if (sql.includes("JOIN cards")) {
        return Promise.resolve({ rows: opts.dbPicks ?? [] });
      }
      if (sql.includes("IN (")) {
        return Promise.resolve({
          rows: [
            { card_id: 1, name: "Lightning Bolt" },
            { card_id: 2, name: "Counterspell" },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
}

function phaseWrites(client: { execute: ReturnType<typeof vi.fn> }): string[] {
  return client.execute.mock.calls
    .filter(([p]: any[]) => p.sql.includes("UPDATE drafts SET phase"))
    .map(([p]: any[]) => p.args[0] as string);
}

const draft = { draftId: "test-draft", sheetId: "sheet-1" };

describe("syncActiveDraft phase decisions", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("moves a drafting draft with all picks done but no matches to playing", async () => {
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({ phase: "drafting" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual(["playing"]);
    expect(result.phaseSet).toBe("playing");
  });

  it("moves a playing draft to complete when the full round robin is recorded", async () => {
    // 2 drafters → expectedMatchCount = 1
    mockFetch.mockResolvedValue(sheet({ matches: [["Alice", 2, "Bob", 1]] }));
    const client = phaseClient({ phase: "playing" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual(["complete"]);
    expect(result.status).toBe("completed");
  });

  it("keeps a playing draft in playing while matches are missing", async () => {
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({
      phase: "playing",
      dbPicks: [
        { pick_n: 1, seat: 1, card_id: 1, name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_id: 2, name: "Counterspell" },
      ],
    });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual([]);
    expect(result.phaseSet).toBeNull();
  });

  it("keeps an unfinished draft in drafting", async () => {
    mockFetch.mockResolvedValue(sheet({ bobPicked: false }));
    const client = phaseClient({ phase: "drafting" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual([]);
    expect(result.phaseSet).toBeNull();
  });

  it("still syncs picks and matches for a complete draft but never demotes it", async () => {
    mockFetch.mockResolvedValue(sheet({ matches: [["Alice", 2, "Bob", 1]] }));
    const client = phaseClient({ phase: "complete" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    // target is 'complete' and it already is — no redundant write
    expect(phaseWrites(client)).toEqual([]);
    expect(result.picksInserted).toBe(2);
    expect(result.matchesReplaced).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/sync.test.ts src/core/db/sync/__tests__/syncActiveDraft.test.ts`
Expected: FAIL — `setDraftPhase` doesn't exist, `phaseSet` doesn't exist, phase decision not implemented.

- [ ] **Step 3: Implement**

In `src/core/db/sync/incremental.ts`:

1. Replace `markDraftComplete` with:

```typescript
/**
 * Write a draft's phase. Callers are responsible for checking
 * isSyncPhaseTransitionLegal first — this is a raw write.
 */
export async function setDraftPhase(
  client: Client,
  draftId: string,
  phase: "drafting" | "playing" | "complete",
): Promise<void> {
  await client.execute({
    sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
    args: [phase, draftId],
  });
}
```

2. In `incrementalIngest`: remove `isComplete` from the destructuring, delete the whole `if (isComplete) { ... }` block, and narrow the return status type to `"no_change" | "updated" | "diverged"` (both in the signature and the doc comment).

In `src/core/db/sync/syncActiveDraft.ts`, replace the full file body after the imports region so it reads:

```typescript
import type { Client } from "@libsql/client";
import { fetchDraftTabsRaw } from "../../sheets";
import { parsePickRows, parseMatchRows } from "../../parseSheetRows";
import { incrementalIngest, setDraftPhase } from "./incremental";
import {
  hashMatches,
  getDomainHashes,
  compareDomainHash,
  updateDomainHashes,
} from "./domains";
import {
  batchInsertMatches,
  buildMatchInserts,
  deleteDomainData,
} from "./batch";
import {
  computeSyncTargetPhase,
  isMatchesComplete,
  isSyncPhaseTransitionLegal,
} from "../../draftPhases";

export interface SyncActiveDraftResult {
  draftId: string;
  picksInserted: number;
  picksUpdated: number;
  matchesReplaced: number;
  status: "no_change" | "updated" | "completed" | "diverged";
  diverged: boolean;
  /** Phase written this run, or null when no transition happened. */
  phaseSet: "drafting" | "playing" | "complete" | null;
}

/**
 * Sync a single active draft for the cron path.
 *
 * 1. Fetch sheet tabs from Google Sheets
 * 2. Reconcile picks (insert missing positions, update post-hoc edits)
 * 3. Sync matches via hash-compare → delete + replace if changed
 * 4. Advance the phase: drafting → playing when all picks are in,
 *    playing → complete when the full round robin is recorded.
 *
 * This is the INCREMENTAL path. It intentionally omits pool sync, cube
 * snapshot rebuild, opt-out sync, and Scryfall backfill — those are
 * full-domain operations only the CLI sync performs.
 *
 * Throws on unrecoverable errors (e.g. Sheets API failure); the caller is
 * responsible for per-draft try/catch to continue syncing other drafts.
 */
export async function syncActiveDraft(
  client: Client,
  draft: { draftId: string; sheetId: string },
  apiKey: string,
): Promise<SyncActiveDraftResult> {
  const result: SyncActiveDraftResult = {
    draftId: draft.draftId,
    picksInserted: 0,
    picksUpdated: 0,
    matchesReplaced: 0,
    status: "no_change",
    diverged: false,
    phaseSet: null,
  };

  const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

  if (!sheetData.picks) {
    console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
    return result;
  }

  // Reconcile picks (inserts + post-hoc edit updates)
  const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
  const stored = await getDomainHashes(client, draft.draftId);
  const ingestResult = await incrementalIngest(
    client,
    draft.draftId,
    parsedPicks,
    stored?.picksHash ?? null,
  );

  result.picksInserted = ingestResult.picksInserted;
  result.picksUpdated = ingestResult.picksUpdated;
  result.status = ingestResult.status;

  if (ingestResult.status === "diverged") {
    console.warn(
      `[sync] Draft ${draft.draftId} has diverged data — run pnpm sync to fix`,
    );
    result.diverged = true;
  }

  // Sync matches via hash-compare + replace
  // Uses buildMatchInserts (shared with CLI syncDraft) for the 0→1 seat mapping.
  const matches = parseMatchRows(sheetData.matches, parsedPicks.drafterNames);
  if (matches.length > 0) {
    const newMatchesHash = hashMatches(matches);
    const storedMatchesHash = stored?.matchesHash ?? null;

    if (compareDomainHash(newMatchesHash, storedMatchesHash) === "replace") {
      await deleteDomainData(client, draft.draftId, "matches");

      const matchInserts = buildMatchInserts(draft.draftId, matches);
      await batchInsertMatches(client, matchInserts);
      await updateDomainHashes(client, draft.draftId, {
        matchesHash: newMatchesHash,
      });

      result.matchesReplaced = matchInserts.length;
      console.log(
        `[sync] Replaced ${matchInserts.length} matches for draft ${draft.draftId}`,
      );

      if (result.status === "no_change") {
        result.status = "updated";
      }
    }
  }

  // Advance the phase when the sheet state calls for it. Divergence skips
  // this — a draft whose picks can't be trusted shouldn't change phase.
  if (!result.diverged) {
    const currentPhase = stored?.currentPhase ?? "drafting";
    const targetPhase = computeSyncTargetPhase(
      parsedPicks.isComplete,
      isMatchesComplete(matches.length, parsedPicks.numDrafters),
    );
    if (
      targetPhase !== currentPhase &&
      isSyncPhaseTransitionLegal(currentPhase, targetPhase)
    ) {
      await setDraftPhase(client, draft.draftId, targetPhase);
      result.phaseSet = targetPhase;
      console.log(`[sync] Draft ${draft.draftId} phase → ${targetPhase}`);
      if (targetPhase === "complete") {
        result.status = "completed";
      }
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/__tests__/sync.test.ts src/core/db/sync/__tests__/syncActiveDraft.test.ts && pnpm typecheck`
Expected: PASS. If `pnpm knip` complains that `setDraftPhase` is only used internally, it is also consumed by `syncActiveDraft.ts` — that import satisfies it.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/db/sync/incremental.ts src/core/db/sync/syncActiveDraft.ts src/core/__tests__/sync.test.ts src/core/db/sync/__tests__/syncActiveDraft.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Advance sheet drafts drafting → playing → complete from the cron path

Picks-done drafts used to jump straight to 'complete' and fall out of the
sync window before matches were entered — no July draft has a single match
row. 'playing' keeps them syncing until the round robin is recorded.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CLI syncDraft uses the same phase decision

**Files:**
- Modify: `src/core/db/sync/index.ts`
- Modify: `src/core/db/sync/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `computeSyncTargetPhase`, `isMatchesComplete` from Task 1.
- Produces: `SyncDraftResult.markedComplete` now means "target phase was complete" (picks *and* matches done).

- [ ] **Step 1: Update the tests**

In `src/core/db/sync/__tests__/sync.test.ts`:

1. Test "marks draft as complete when picks indicate completion" (line ~359): the fixture has complete picks and `matches: null`, so the target is now `playing`. Rename it to `"moves a draft to playing when picks are done but matches are not"` and change the assertions to:

```typescript
      expect(result.markedComplete).toBe(false);
      const completionUpdate = executeCalls.find(
        (c: any[]) => (c[0].sql as string).includes("UPDATE drafts SET phase"),
      );
      expect(completionUpdate).toBeDefined();
      expect(completionUpdate![0].args[0]).toBe("playing");
```

2. Add a sibling test in the same describe:

```typescript
    it("marks a draft complete when picks are done and the round robin is full", async () => {
      const picksRows = [
        [],
        [],
        ["", "", "Alice", "Bob", "↩"],
        ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
      ];
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: picksRows,
        matches: buildMatchRows([["Alice", 2, "Bob", 1]]), // 2 drafters → full RR
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      const result = await syncDraft(
        client as any, "test-draft", rawData, cache, emptyScryfallCache, emptyOptOuts,
      );

      expect(result.markedComplete).toBe(true);
      const executeCalls = client.execute.mock.calls;
      const completionUpdate = executeCalls.find(
        (c: any[]) => (c[0].sql as string).includes("UPDATE drafts SET phase"),
      );
      expect(completionUpdate![0].args[0]).toBe("complete");
    });
```

3. Test "DOES mark a 'playing' draft as 'complete' when picks are finished" (line ~507): add matches to its fixture — change `matches: null` to `matches: buildMatchRows([["Alice", 2, "Bob", 0]])`. Assertions stay.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/db/sync/__tests__/sync.test.ts`
Expected: FAIL — syncDraft still writes `complete` on picks-done alone.

- [ ] **Step 3: Implement**

In `src/core/db/sync/index.ts`:

1. Change the `draftPhases` import to:

```typescript
import {
  computeSyncTargetPhase,
  isMatchesComplete,
  isSyncPhaseTransitionLegal,
} from "../../draftPhases";
```

2. Replace the completion block (lines 248–258, "Detect and update completion...") with:

```typescript
    // Advance the phase: playing when picks are done, complete when the full
    // round robin is also recorded. Only when the transition is legal — never
    // demote a draft an admin has manually advanced.
    const targetPhase = computeSyncTargetPhase(
      parsedPicks.isComplete,
      isMatchesComplete(matches.length, parsedPicks.numDrafters),
    );
    result.markedComplete = targetPhase === "complete";
    if (isSyncPhaseTransitionLegal(currentPhase ?? "drafting", targetPhase)) {
      await client.execute({
        sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
        args: [targetPhase, draftId],
      });
    }
```

3. In the `dryRun` early return (line ~157), change `result.markedComplete = parsedPicks.isComplete;` to:

```typescript
      result.markedComplete =
        computeSyncTargetPhase(
          parsedPicks.isComplete,
          isMatchesComplete(matches.length, parsedPicks.numDrafters),
        ) === "complete";
```

4. Update the file header comment (lines 1–17): note that both paths share the lifecycle predicates in `draftPhases.ts` and that picks-done drafts land in `playing`, not `complete`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/db/sync/__tests__/sync.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/db/sync/index.ts src/core/db/sync/__tests__/sync.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "CLI sync shares the playing-phase lifecycle with the cron path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Cron scope — sync playing drafts, 60-day age backstop

**Files:**
- Modify: `src/core/db/sync/lock.ts`
- Modify: `src/app/api/sync/route.ts`
- Modify: `src/core/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `getActiveDrafts` now selects `phase IN ('setup', 'drafting', 'playing')`
  - `completeAgedPlayingDrafts(client: Client): Promise<number>` — moves sheet drafts `playing → complete` when `draft_date` is more than 60 days old; returns rows affected
  - `PLAYING_SYNC_WINDOW_DAYS = 60` (module constant, not exported)

- [ ] **Step 1: Write the failing tests**

In `src/core/__tests__/sync.test.ts`, add `completeAgedPlayingDrafts` to the `../db/sync/lock` import. If the file already contains a `describe("getActiveDrafts", ...)` block asserting the old two-phase SQL, replace it with the version below; otherwise add both blocks after `describe("getSyncStatus", ...)`:

```typescript
describe("getActiveDrafts", () => {
  it("selects setup, drafting, and playing sheet drafts", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ draft_id: "d1", sheet_id: "s1" }],
      }),
    };
    const result = await getActiveDrafts(client as any);
    expect(result).toEqual([{ draftId: "d1", sheetId: "s1" }]);
    const sql = client.execute.mock.calls[0][0].sql as string;
    expect(sql).toContain("'playing'");
    expect(sql).toContain("sheet_id IS NOT NULL");
  });
});

describe("completeAgedPlayingDrafts", () => {
  it("completes sheet drafts stuck in playing past the age window", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 2 }),
    };
    const count = await completeAgedPlayingDrafts(client as any);
    expect(count).toBe(2);
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("SET phase = 'complete'");
    expect(call.sql).toContain("phase = 'playing'");
    expect(call.sql).toContain("sheet_id IS NOT NULL");
    expect(call.args).toEqual(["-60 days"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/__tests__/sync.test.ts`
Expected: FAIL — `completeAgedPlayingDrafts` not exported; `getActiveDrafts` SQL lacks `'playing'`.

- [ ] **Step 3: Implement**

In `src/core/db/sync/lock.ts`:

1. Update `getActiveDrafts` (doc comment and SQL):

```typescript
/**
 * Get active draft IDs (phase in setup/drafting/playing) with their sheet_ids.
 * Used by the cron sync route to determine which drafts to sync. 'playing'
 * drafts stay in the window so late match entry and post-hoc pick edits
 * keep syncing; completeAgedPlayingDrafts caps how long that lasts.
 */
export async function getActiveDrafts(
  client: Client,
): Promise<Array<{ draftId: string; sheetId: string }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, sheet_id FROM drafts WHERE phase IN ('setup', 'drafting', 'playing') AND sheet_id IS NOT NULL`,
    args: [],
  });
  return result.rows.map((row) => ({
    draftId: row.draft_id as string,
    sheetId: row.sheet_id as string,
  }));
}
```

2. Add below it:

```typescript
/** How long a playing sheet draft keeps syncing before it is force-completed. */
const PLAYING_SYNC_WINDOW_DAYS = 60;

/**
 * Age backstop for the playing phase: pods that never record their full
 * round robin would otherwise sync forever. Only sheet drafts — live
 * (in-app) drafts manage their own lifecycle.
 */
export async function completeAgedPlayingDrafts(client: Client): Promise<number> {
  const result = await client.execute({
    sql: `UPDATE drafts SET phase = 'complete'
          WHERE phase = 'playing' AND sheet_id IS NOT NULL
            AND draft_date < date('now', ?)`,
    args: [`-${PLAYING_SYNC_WINDOW_DAYS} days`],
  });
  return result.rowsAffected;
}
```

3. Leave `getActiveDraftInfo` (setup/drafting only) unchanged — it feeds the UI's live-draft indicator, which should not light up for pods that are merely playing out matches.

In `src/app/api/sync/route.ts`:

1. Add `completeAgedPlayingDrafts` to the `@/core/db/sync/lock` import.
2. At the top of `runSync`, before `getActiveDrafts`:

```typescript
  const client = await getClient();

  // Age backstop first so long-stale playing drafts drop out of this run
  await completeAgedPlayingDrafts(client);
```

3. Aggregate pick updates: add `let totalPicksUpdated = 0;` beside the other totals, `totalPicksUpdated += result.picksUpdated;` in the loop, include `totalPicksUpdated > 0` in the completed-status condition, and add `picksUpdated: totalPicksUpdated` to both JSON responses.

- [ ] **Step 4: Run tests and full typecheck**

Run: `npx vitest run src/core/__tests__/sync.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/db/sync/lock.ts src/app/api/sync/route.ts src/core/__tests__/sync.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Cron syncs playing drafts, with a 60-day age backstop to complete

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation + full gate

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

1. In "Key Features", replace the "Active draft sync" bullet with:

```markdown
- **Active draft sync:** Drafts linked to a Google Sheet (`sheetId` in metadata) are synced by a Vercel cron job calling `GET /api/sync` every 10 minutes (authenticated via `CRON_SECRET`). The cron covers phases `setup`, `drafting`, and `playing`: it inserts missing picks, updates picks whose sheet cell was edited after the fact, and hash-syncs match results. When every pick cell is filled the draft moves `drafting → playing`; when the full round robin (n·(n−1)/2 matches) is recorded — or 60 days after the draft date — it moves `playing → complete` and leaves the sync window. `pnpm draft:admin set-phase` overrides at any time; there is no manual "Sync Now" button — use `pnpm sync <name>` from the CLI for on-demand full syncs.
```

2. In the "Sync" paragraph under Key Commands, append: `The cron path only reconciles picks and matches; pool/cube changes always need the CLI sync.`

- [ ] **Step 2: Run the full precommit gate**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, unit tests, and e2e all pass. Fix anything that fails before committing (knip is the likely tripwire if any deleted helper was left exported).

- [ ] **Step 3: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add CLAUDE.md
git -C /Users/arpanet/dev/read-the-bones commit -m "Document the sheet-draft sync lifecycle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Production repair — the five 2026-07-17 drafts

Manual runbook, run after the code above is merged to master and pushed. Requires `.env` (or exported env vars) with `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `GOOGLE_SHEETS_API_KEY` — the repo tracks only `.env.example`.

Draft IDs: `mockingbird`, `goose-mother`, `yorion`, `baleful-strix`, `ledger-shredder`. All are `phase = 'complete'` with 432–434/450 picks and 0 match rows.

- [ ] **Step 1: Reopen the drafts as playing**

`complete → playing` is (correctly) an illegal sync transition, so use the admin override:

```bash
pnpm draft:admin set-phase mockingbird --phase playing
pnpm draft:admin set-phase goose-mother --phase playing
pnpm draft:admin set-phase yorion --phase playing
pnpm draft:admin set-phase baleful-strix --phase playing
pnpm draft:admin set-phase ledger-shredder --phase playing
```

- [ ] **Step 2: Dry-run one draft, then full-sync all five**

```bash
pnpm sync mockingbird --dry-run -v
```
Expected: `picks:replace` (450 picks), `matches:replace`.

```bash
pnpm sync mockingbird && pnpm sync goose-mother && pnpm sync yorion && pnpm sync baleful-strix && pnpm sync ledger-shredder
```
Expected per draft: `replaced picks(450)`, `matches(<n>)` where n = rows currently filled in that sheet's Matches tab. Drafts whose round robin is already fully recorded will also print `→ marked complete`; the rest stay `playing` and the cron maintains them.

- [ ] **Step 3: Verify in Turso**

```bash
turso db shell read-the-bones "SELECT d.draft_id, d.phase, COUNT(pe.pick_n) AS picks, (SELECT COUNT(*) FROM match_events m WHERE m.draft_id = d.draft_id) AS matches FROM drafts d LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id WHERE d.draft_date = '2026-07-17' GROUP BY d.draft_id"
```
Expected: `picks = 450` for all five; `matches > 0` for any sheet with filled match rows; phase `playing` (or `complete` where the round robin is done).

```bash
turso db shell read-the-bones "SELECT pe.pick_n, c.name FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id WHERE pe.draft_id = 'mockingbird' AND pe.seat = 5 AND pe.pick_n IN (279, 342)"
```
Expected: 279 = Thundering Falls, 342 = **Fiery Islet** (the reported discrepancy, fixed).

- [ ] **Step 4: Redeploy**

The main page is statically prerendered; new Turso data is invisible until a rebuild:

```bash
vercel --prod
```

- [ ] **Step 5: Confirm the cron picks the drafts up**

After the next cron tick (≤10 min), `GET /api/sync-status` should show a fresh `lastSyncedAt`, and any match rows entered in the sheets afterward should appear in `match_events` within 10 minutes.
