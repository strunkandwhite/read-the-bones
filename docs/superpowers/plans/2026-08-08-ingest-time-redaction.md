# Ingest-Time Privacy Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop storing opted-out players' picks and deck cards at all, so privacy is a property of the data rather than something ten read paths must each remember to mask.

**Architecture:** A single reconcile-and-filter pass at the parse → ingest boundary, shared by the CLI sync and the cron sync, backed by the existing `privacy_opt_outs` table. Once no rows exist for an opted-out seat, every read-time mask is deleted. The pod sheet keeps its current appearance by rendering `[REDACTED]` cells structurally from draft metadata plus a seat-level `redactedSeats` flag.

**Tech Stack:** TypeScript, Next.js 16, libSQL/Turso, vitest, Zustand, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-08-ingest-time-redaction-design.md`

## Global Constraints

- **Seat indexing is not uniform.** `parsePickRows` emits `pick.seat` **0-indexed**; `pick_events.seat` and `privacy_opt_outs.seat` are **1-indexed**. Both insert paths convert with `pick.seat + 1` (`index.ts:190`, `incremental.ts:301`). Every comparison against an opted-out seat set must state which basis it is in.
- **Never hardcode pod size or draft length.** Across the ten affected drafts `num_seats` is 8-12, `picks_per_player` is 40-45, `double_pick_after_round` is 20-25.
- **`.opt-outs.json` is gitignored and never reaches Vercel.** The ingest filter reads `privacy_opt_outs` from the DB. The JSON file is CLI-only input.
- **Git:** always `git -C /Users/arpanet/code/read-the-bones <cmd>`. Never `cd && git`. No branch names containing periods.
- **Do not commit or branch until the concurrent `mobile-viewport-and-queue-handle` session has merged.** Then branch from `master`: `git -C <repo> checkout master && git -C <repo> pull && git -C <repo> checkout -b ingest-time-redaction`.
- **Run `pnpm precommit` on the host, not in the sandbox** — `knip` has darwin-only bindings and the husky pre-push hook runs it.
- **Never run `pnpm dev` in the sandbox while the host runs it** — they share `.next` and corrupt the Turbopack cache.
- **There is one database.** Local dev and production both use Turso `read-the-bones`. Any script you run locally mutates production data immediately, while the *deployed* code is whatever was last shipped.
- **The rollout is two deploys, and the order is not negotiable:**
  1. Tasks 1, 2, 3, 5, 6 → **Deploy A**. Ingest filter and display flag ship; read-time masks stay in place.
  2. Run the data migration (Task 6, Steps 8-10). Only safe *after* Deploy A.
  3. Tasks 7, 8 → **Deploy B**. Masks come out.

  Running the migration before Deploy A does not work: `getActiveDrafts` (`lock.ts:114`) syncs every draft with `phase IN ('setup','drafting','playing')` and a sheet — currently `hardened-academic` and `ledger-shredder` — and the Vercel cron fires every 10 minutes. Until the filtered ingest is deployed, that cron re-inserts the deleted rows straight from the sheet, silently undoing the migration.
- Task order matters for safety: the data must be redacted **before** read-time masks are removed (Tasks 7-8). Do not reorder.

---

### Task 1: Redaction module

The shared primitive both sync paths use. Pure filter + a reconcile pass, in one small module so neither sync path grows its own copy.

**Files:**
- Create: `src/core/db/ingest/redaction.ts`
- Modify: `src/core/db/queries/helpers.ts:64-76` — make `getOptedOutSeats` query directly instead of delegating to `fetchOptOuts`
- Test: `src/core/db/ingest/redaction.test.ts`

**Interfaces:**
- Consumes: `getOptedOutSeats(client, draftId)` from `src/core/db/queries/helpers.ts` — returns `Promise<Set<number>>` of **1-indexed** seats.
- Produces:
  - `filterRedactedPicks(picks: CardPick[], optedOutSeats: Set<number>): CardPick[]` — pure; `picks[].seat` is 0-indexed, `optedOutSeats` is 1-indexed.
  - `reconcileRedactedRows(client: Client, draftId: string): Promise<{ picksDeleted: number; deckCardsDeleted: number }>`

- [ ] **Step 1: Write the failing tests**

Create `src/core/db/ingest/redaction.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterRedactedPicks, reconcileRedactedRows } from "./redaction";
import type { CardPick } from "../../types";

function pick(seat: number, pickPosition: number, cardName: string): CardPick {
  return { cardName, pickPosition, copyNumber: 1, wasPicked: true, draftId: "d1", seat, color: "" };
}

describe("filterRedactedPicks", () => {
  it("drops picks whose 1-indexed seat is opted out", () => {
    // seat 4 (0-indexed) is seat 5 (1-indexed)
    const picks = [pick(3, 4, "Bolt"), pick(4, 5, "Swords"), pick(5, 6, "Ragavan")];
    const result = filterRedactedPicks(picks, new Set([5]));
    expect(result.map((p) => p.cardName)).toEqual(["Bolt", "Ragavan"]);
  });

  it("returns the input unchanged when nothing is opted out", () => {
    const picks = [pick(0, 1, "Bolt"), pick(1, 2, "Swords")];
    expect(filterRedactedPicks(picks, new Set())).toHaveLength(2);
  });

  it("drops every pick when the only drafter is opted out", () => {
    expect(filterRedactedPicks([pick(0, 1, "Bolt")], new Set([1]))).toEqual([]);
  });

  it("does not confuse 0-indexed seat 5 with 1-indexed seat 5", () => {
    // 0-indexed seat 5 is 1-indexed seat 6 — must survive an opt-out on seat 5
    const result = filterRedactedPicks([pick(5, 1, "Bolt")], new Set([5]));
    expect(result).toHaveLength(1);
  });
});

describe("reconcileRedactedRows", () => {
  let mockClient: { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn(), batch: vi.fn() };
  });

  it("deletes pick_events and deck_cards for opted-out seats and reports counts", async () => {
    mockClient.execute
      .mockResolvedValueOnce({ rows: [{ seat: 5 }] })                 // getOptedOutSeats
      .mockResolvedValueOnce({ rowsAffected: 45 })                    // pick_events delete
      .mockResolvedValueOnce({ rowsAffected: 44 });                   // deck_cards delete

    const result = await reconcileRedactedRows(mockClient as never, "d1");

    expect(result).toEqual({ picksDeleted: 45, deckCardsDeleted: 44 });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("DELETE FROM pick_events") }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("DELETE FROM deck_cards") }),
    );
  });

  it("issues no deletes when the draft has no opt-outs", async () => {
    mockClient.execute.mockResolvedValueOnce({ rows: [] });
    const result = await reconcileRedactedRows(mockClient as never, "d1");
    expect(result).toEqual({ picksDeleted: 0, deckCardsDeleted: 0 });
    expect(mockClient.execute).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/core/db/ingest/redaction.test.ts`
Expected: FAIL — `Failed to resolve import "./redaction"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/db/ingest/redaction.ts`:

```typescript
/**
 * Ingest-time privacy redaction.
 *
 * An opted-out player's picks and deck cards are never stored. This module is
 * the single place that enforces it, shared by the CLI sync and the cron sync.
 *
 * Redaction used to happen at read time, in each query module. That left the
 * rows in the database and made the guarantee unverifiable — it held only as
 * long as every read path remembered to mask. Enforcing it here makes it a
 * property of the data: no pick_events or deck_cards row may exist for a seat
 * in privacy_opt_outs.
 */

import type { Client } from "@libsql/client";
import type { CardPick } from "../../types";
import { getOptedOutSeats, placeholders } from "../queries/helpers";

/**
 * Drop picks belonging to opted-out seats.
 *
 * `picks[].seat` is 0-indexed as it comes off parsePickRows; `optedOutSeats`
 * holds the 1-indexed seat numbers stored in privacy_opt_outs. The conversion
 * happens here so callers never have to think about it.
 */
export function filterRedactedPicks(
  picks: CardPick[],
  optedOutSeats: Set<number>,
): CardPick[] {
  if (optedOutSeats.size === 0) return picks;
  return picks.filter((pick) => !optedOutSeats.has(pick.seat + 1));
}

/**
 * Delete any stored rows belonging to opted-out seats.
 *
 * Run before ingesting, so the pipeline is self-healing: a draft whose picks
 * landed before its opt-outs were known gets cleaned up on the next sync
 * rather than keeping the rows forever (the incremental path only ever
 * inserts). This is also what makes the one-time migration nothing more than
 * the first run of the new pipeline.
 */
export async function reconcileRedactedRows(
  client: Client,
  draftId: string,
): Promise<{ picksDeleted: number; deckCardsDeleted: number }> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) {
    return { picksDeleted: 0, deckCardsDeleted: 0 };
  }

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  const picksResult = await client.execute({
    sql: `DELETE FROM pick_events WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });
  const deckCardsResult = await client.execute({
    sql: `DELETE FROM deck_cards WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });

  return {
    picksDeleted: picksResult.rowsAffected ?? 0,
    deckCardsDeleted: deckCardsResult.rowsAffected ?? 0,
  };
}
```

- [ ] **Step 4: Make `getOptedOutSeats` query directly**

`getOptedOutSeats` currently delegates to `fetchOptOuts`, whose SQL uses an `IN (...)` clause. The sync test harnesses route their mock client **by SQL shape** — `syncActiveDraft.test.ts:60` treats any statement containing `IN (` as the card-name lookup — so leaving the delegation in place makes Task 2's tests silently receive card rows where they expect opt-out rows. Cutting the delegation now removes the collision instead of working around it.

Replace the body in `src/core/db/queries/helpers.ts`:

```typescript
/**
 * Get opted-out seats for a single draft.
 *
 * Consumed by the ingest filter and by the /live route's display flag. Query
 * modules do not call this — redaction happens at ingest.
 */
export async function getOptedOutSeats(client: Client, draftId: string): Promise<Set<number>> {
  const result = await client.execute({
    sql: `SELECT seat FROM privacy_opt_outs WHERE draft_id = ?`,
    args: [draftId],
  });
  return new Set(result.rows.map((row) => row.seat as number));
}
```

Leave `fetchOptOuts` in place for now — the aggregate modules still call it until Task 8.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/core/db/ingest/redaction.test.ts src/core/db/queries/`
Expected: PASS, 6 new tests, and the existing query tests still green.

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. `CardPick` is defined and exported at `src/core/types.ts:51`; its own doc comment records the indexing rule this module encapsulates ("Seat number (0-indexed in parsed data). The database stores 1-indexed seats").

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/ingest/redaction.ts src/core/db/ingest/redaction.test.ts src/core/db/queries/helpers.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Add ingest-time redaction primitives

Redaction at read time left the rows in the database, so the guarantee held
only as long as every read path remembered to mask. Enforce it at ingest
instead."
```

---

### Task 2: Wire redaction into the cron sync

The cron path is incremental and has a trap the CLI path does not: filtering parsed picks while redacted rows are still in the DB makes those positions look like sheet deletions, which trips divergence and halts the sync.

**Files:**
- Modify: `src/core/db/sync/syncActiveDraft.ts:81-100` (the picks block)
- Test: `src/core/db/sync/__tests__/syncActiveDraft.test.ts`

**Interfaces:**
- Consumes: `filterRedactedPicks`, `reconcileRedactedRows` (Task 1); `getOptedOutSeats`.
- Produces: no new exports. `SyncActiveDraftResult` is unchanged.

**Critical ordering — read before implementing.** `incrementalIngest` calls `detectRemovedPicks(csvPositions, dbPicks.keys())` (`incremental.ts:359-367`) and returns `diverged` when the DB holds a position the sheet does not. If we filter the parsed picks while the DB still holds the redacted seat's rows, every one of those positions reads as removed and the whole draft goes `diverged` — no picks, no matches, no phase advance. So **`reconcileRedactedRows` must run BEFORE `incrementalIngest`**, not after. With the rows gone first, neither side has the positions and divergence is never triggered.

Note also that `syncActiveDraft` deliberately never calls `insertOptOuts` — it cannot, since `.opt-outs.json` is not deployed. It relies on whatever the CLI last wrote to `privacy_opt_outs`.

- [ ] **Step 1: Write the failing test**

Work inside the existing `src/core/db/sync/__tests__/syncActiveDraft.test.ts`. Only `../../../sheets` is mocked there (line 8) — `incrementalIngest` runs for real against a mock client routed by SQL shape, so assert on what the client received rather than on a mocked ingest.

First extend the `phaseClient` factory (line 42) with an opt-out branch and an `optedOutSeats` option, placed **above** the `IN (` branch:

```typescript
function phaseClient(opts: {
  phase: string;
  dbPicks?: Array<{ pick_n: number; seat: number; card_id: number; name: string }>;
  optedOutSeats?: number[];
}) {
  return {
    execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
      if (sql.includes("privacy_opt_outs")) {
        return Promise.resolve({ rows: (opts.optedOutSeats ?? []).map((seat) => ({ seat })) });
      }
      // ...existing branches unchanged, starting with pool_hash
```

Then add the two tests. The default `sheet({})` fixture has drafters Alice and Bob at 0-indexed seats 0 and 1, i.e. 1-indexed seats 1 and 2, so opting out seat 2 redacts Bob's Counterspell:

```typescript
it("deletes redacted rows before ingesting and never inserts a redacted pick", async () => {
  mockFetch.mockResolvedValue(sheet({}));
  const client = phaseClient({ phase: "drafting", optedOutSeats: [2] });

  await syncActiveDraft(client as any, draft, "api-key");

  const sqls = client.execute.mock.calls.map(([p]: any[]) => p.sql as string);
  const deleteIdx = sqls.findIndex((s) => s.includes("DELETE FROM pick_events"));
  const dbPicksIdx = sqls.findIndex((s) => s.includes("JOIN cards"));
  expect(deleteIdx).toBeGreaterThanOrEqual(0);
  // Deleting after the ingest read would let detectRemovedPicks see the
  // redacted positions as sheet deletions and flag the draft diverged.
  expect(deleteIdx).toBeLessThan(dbPicksIdx);

  const insertedSeats = client.batch.mock.calls
    .flatMap(([stmts]: any[]) => stmts ?? [])
    .filter((s: any) => s.sql.includes("INSERT OR IGNORE INTO pick_events"))
    .map((s: any) => s.args[2] as number);
  expect(insertedSeats).not.toContain(2);
  expect(insertedSeats).toContain(1);
});

it("still advances the phase when a redacted seat's picks are filtered out", async () => {
  // isComplete is computed from the full sheet, so filtering the picks must
  // not strand the draft in `drafting` forever.
  mockFetch.mockResolvedValue(sheet({}));
  const client = phaseClient({ phase: "drafting", optedOutSeats: [2] });

  const result = await syncActiveDraft(client as any, draft, "api-key");

  expect(result.phaseSet).toBe("playing");
  expect(result.diverged).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/core/db/sync/__tests__/syncActiveDraft.test.ts`
Expected: FAIL — no `DELETE FROM pick_events` statement is issued (`deleteIdx` is -1), and seat 2 appears in the inserted seats.

- [ ] **Step 3: Implement**

In `src/core/db/sync/syncActiveDraft.ts`, add the imports:

```typescript
import { filterRedactedPicks, reconcileRedactedRows } from "../ingest/redaction";
import { getOptedOutSeats } from "../queries/helpers";
```

Then, immediately before the `incrementalIngest` call, insert:

```typescript
  // Delete any stored rows for opted-out seats BEFORE ingesting. Order is
  // load-bearing: incrementalIngest flags divergence when the DB holds a
  // position the parsed picks do not, so filtering while the rows are still
  // present would read as sheet deletions and halt the sync.
  await reconcileRedactedRows(client, draft.draftId);
  const optedOutSeats = await getOptedOutSeats(client, draft.draftId);
  const redactedPicks = {
    ...parsedPicks,
    picks: filterRedactedPicks(parsedPicks.picks, optedOutSeats),
  };
```

Pass `redactedPicks` to `incrementalIngest` in place of `parsedPicks`.

**Leave every other use of `parsedPicks` alone** — `parsedPicks.isComplete`, `parsedPicks.numDrafters`, and `parsedPicks.drafterNames` must stay computed from the full sheet. `isComplete` drives `drafting → playing` (`syncActiveDraft.ts:139-152`); filtering it would strand the draft in `drafting` forever, and `drafterNames` is what `parseMatchRows` maps match-tab names against.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/core/db/sync/__tests__/syncActiveDraft.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/sync/syncActiveDraft.ts src/core/db/sync/__tests__/syncActiveDraft.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Redact opted-out picks in the cron sync

Reconcile before ingest, not after: incrementalIngest reads a filtered pick
set as sheet deletions and would flag the whole draft diverged."
```

---

### Task 3: Wire redaction into the CLI sync

**Files:**
- Modify: `src/core/db/sync/index.ts:178-200` (picks domain) and `:251-254` (opt-out block)
- Test: `src/core/db/sync/__tests__/sync.test.ts` — the existing syncDraft suite

**Interfaces:**
- Consumes: `filterRedactedPicks`, `reconcileRedactedRows` (Task 1).
- Produces: no new exports.

The CLI path does a full replace (`deleteDomainData` then `batchInsertPicks`), so it has no divergence trap. It has the opposite problem: `insertOptOuts` runs at line 253, *after* the picks are inserted at line 197. On the first-ever sync of a draft, `privacy_opt_outs` is empty while the picks go in. Fix by doing both — filter with the table as it stands, then reconcile after `insertOptOuts` has updated it. Together they are correct in a single run.

- [ ] **Step 1: Write the failing test**

```typescript
it("filters opted-out picks before insert and reconciles after opt-outs are written", async () => {
  mockGetOptedOutSeats.mockResolvedValue(new Set([2]));

  await syncDraft(mockClient as never, "d1", rawSheetData, cardCache, scryfallCache, new Set(["bob"]), {});

  const inserted = mockBatchInsertPicks.mock.calls[0][1];
  expect(inserted.every((p: { seat: number }) => p.seat !== 2)).toBe(true);

  // insertOptOuts runs after the insert, so a first-ever sync needs the
  // reconcile pass afterwards to catch a newly-recorded opt-out
  expect(mockInsertOptOuts).toHaveBeenCalledBefore(mockReconcileRedactedRows);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/core/db/sync/__tests__/`
Expected: FAIL — picks for seat 2 are present in the insert batch.

- [ ] **Step 3: Implement**

Add imports to `src/core/db/sync/index.ts`:

```typescript
import { filterRedactedPicks, reconcileRedactedRows } from "../ingest/redaction";
import { getOptedOutSeats } from "../queries/helpers";
```

Inside the `if (result.picksAction === "replace")` block, replace the `for (const pick of pickedCards)` loop header so it iterates the filtered set:

```typescript
      const optedOutSeats = await getOptedOutSeats(client, draftId);
      const visiblePicks = filterRedactedPicks(pickedCards, optedOutSeats);

      const pickInserts: PickInsert[] = [];
      for (const pick of visiblePicks) {
```

Leave `newPicksHash` computed from the unfiltered `pickedCards` — the hash tracks the sheet's state, and filtering it would make an edit to a redacted cell invisible to the change detector.

Then immediately after the existing opt-out block:

```typescript
    // Handle opt-outs
    if (parsedPicks.drafterNames.length > 0) {
      await insertOptOuts(client, draftId, parsedPicks.drafterNames, optOutNames);
    }

    // insertOptOuts may have just learned about a seat whose picks were
    // inserted above (first sync of a draft, or a name newly added to
    // .opt-outs.json). Reconcile now so a single run leaves no redacted rows.
    await reconcileRedactedRows(client, draftId);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/core/db/sync/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/sync/index.ts src/core/db/sync/__tests__/
git -C /Users/arpanet/code/read-the-bones commit -m "Redact opted-out picks in the CLI sync

Filter before insert and reconcile after insertOptOuts, so a draft whose
opt-outs are recorded for the first time is clean after one run."
```

---

### Task 4: Migration script (written here, run later)

> **Do not run this script in this task.** It deletes production rows, and until Deploy A ships the filtered ingest, the 10-minute Vercel cron re-inserts them from the sheet for any draft still in the sync window. It is executed in Task 6, Steps 8-10, after Deploy A.

**Files:**
- Create: `scripts/redact-opted-out.ts`
- Modify: `package.json` (add `"redact:opted-out": "tsx scripts/redact-opted-out.ts"` beside the other script entries)

**Interfaces:**
- Consumes: `reconcileRedactedRows` (Task 1), `getClient` from `src/core/db/client.ts`.
- Produces: a CLI entry point; no importable exports.

- [ ] **Step 1: Write the script**

```typescript
/**
 * One-time migration: delete stored picks and deck cards for every opted-out
 * seat. Idempotent — it is the same reconcile pass the sync pipeline runs, so
 * it can be re-run safely and reports zero on a clean database.
 */

import { getClient } from "../src/core/db/client";
import { reconcileRedactedRows } from "../src/core/db/ingest/redaction";

async function main() {
  const client = await getClient();

  const drafts = await client.execute(
    "SELECT DISTINCT draft_id FROM privacy_opt_outs ORDER BY draft_id",
  );

  let totalPicks = 0;
  let totalDeckCards = 0;

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;
    const { picksDeleted, deckCardsDeleted } = await reconcileRedactedRows(client, draftId);
    totalPicks += picksDeleted;
    totalDeckCards += deckCardsDeleted;
    console.log(`  ${draftId}: ${picksDeleted} picks, ${deckCardsDeleted} deck cards`);
  }

  console.log(`\nDeleted ${totalPicks} picks and ${totalDeckCards} deck cards across ${drafts.rows.length} drafts.`);

  const leftover = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM pick_events pe
         JOIN privacy_opt_outs p ON p.draft_id = pe.draft_id AND p.seat = pe.seat) AS picks,
      (SELECT COUNT(*) FROM deck_cards dc
         JOIN privacy_opt_outs p ON p.draft_id = dc.draft_id AND p.seat = dc.seat) AS deck_cards
  `);
  const { picks, deck_cards } = leftover.rows[0];
  console.log(`Verification — remaining redacted rows: ${picks} picks, ${deck_cards} deck cards`);
  if (Number(picks) !== 0 || Number(deck_cards) !== 0) {
    console.error("FAILED: redacted rows remain");
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Verify it compiles without running it**

Run: `pnpm typecheck`
Expected: no errors. Do **not** run `pnpm redact:opted-out` yet — see the note at the top of this task.

- [ ] **Step 3: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/redact-opted-out.ts package.json
git -C /Users/arpanet/code/read-the-bones commit -m "Add one-time migration deleting stored redacted rows"
```

---

### Task 5: Enforce the decklist match threshold

`matchDecksToSeats` warns below `SEAT_MATCH_SCORE_THRESHOLD` but assigns anyway (`scripts/decklists.ts:164-179`), and later assignments overwrite earlier ones for the same seat. With the opted-out seat's picks now gone it never appears in `seatPicks` at all, so its orphaned decklist would be assigned to whichever real seat it happens to overlap most — overwriting that player's deck.

**Files:**
- Modify: `scripts/decklists.ts:144-181`
- Test: `scripts/decklists.test.ts` (create if absent; export `matchDecksToSeats` for testing)

**Interfaces:**
- Consumes: nothing new.
- Produces: `matchDecksToSeats` becomes an exported function with unchanged signature `(decklists: DecklistEntry[], seatPicks: Map<number, Set<string>>) => Map<number, DecklistEntry>`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { matchDecksToSeats } from "./decklists";

const entry = (id: string, cards: string[]) => ({ sealeddeckId: id, pool: new Set(cards), deck: [], sideboard: [] });

describe("matchDecksToSeats", () => {
  const seatPicks = new Map([
    [1, new Set(["bolt", "swords", "ragavan", "brainstorm"])],
    [2, new Set(["counterspell", "ponder", "preordain", "opt"])],
  ]);

  it("assigns a decklist to the seat it overlaps", () => {
    const result = matchDecksToSeats([entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"])], seatPicks);
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("skips a decklist that matches no seat above the threshold", () => {
    // an opted-out player's list: their seat has no picks, so it is absent
    // from seatPicks and this overlaps nobody
    const result = matchDecksToSeats([entry("zzz", ["llanowar elves", "giant growth"])], seatPicks);
    expect(result.size).toBe(0);
  });

  it("never overwrites a good assignment with a sub-threshold one", () => {
    const result = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"]), entry("zzz", ["bolt"])],
      seatPicks,
    );
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("never produces a seat -1 assignment", () => {
    const result = matchDecksToSeats([entry("zzz", ["nothing at all"])], seatPicks);
    expect(result.has(-1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run scripts/decklists.test.ts`
Expected: FAIL — sub-threshold lists are assigned; `size` is 1 not 0.

- [ ] **Step 3: Implement**

Export the function and replace the warn-only block:

```typescript
/** Match decklists to seats by card overlap */
export function matchDecksToSeats(
```

```typescript
    if (bestScore < SEAT_MATCH_SCORE_THRESHOLD) {
      console.warn(
        `  WARNING: Skipping ${decklist.sealeddeckId} — best match ${(bestScore * 100).toFixed(1)}% (seat ${bestSeat}) is below the ${SEAT_MATCH_SCORE_THRESHOLD * 100}% threshold. An opted-out player's decklist is expected here; anything else means the pool did not match any seat.`,
      );
      continue;
    }
```

Everything below it — the overwrite log and `assignments.set(bestSeat, decklist)` — stays as is. Skipping before the assignment also removes the `bestSeat === -1` case, which previously wrote a seat -1 entry whenever every score was 0.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run scripts/decklists.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify against real data before trusting it**

Run: `pnpm decklists`
Expected: warnings only for opted-out players' lists. If a legitimate decklist is now being skipped, that is a pre-existing sub-threshold match — investigate before proceeding rather than lowering the threshold.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/decklists.ts scripts/decklists.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Skip sub-threshold decklists instead of assigning them anyway

The threshold only warned, so an unmatched list — now including every
opted-out player's — would overwrite whichever seat it least-badly matched."
```

---

### Task 6: Pod sheet renders redacted cells structurally

With the rows gone, the opted-out seat's column would be blank. It must keep reading `[REDACTED]`, exactly as today. The board matrix is generated from draft metadata by `buildPickMatrix(numSeats, picksPerPlayer, doublePickAfterRound)`, so every cell exists whether or not a pick row does.

**Files:**
- Modify: `src/app/api/drafts/[id]/live/route.ts:78-128`
- Modify: `src/app/components/draft-board/DraftBoardMatrix.tsx:140-190`
- Modify: `src/app/components/draft-board/DraftBoardCell.tsx:19-50`
- Modify: `src/app/stores/draftStore.ts:34` — the `BoardData` interface gains `redactedSeats: number[]`; also update the two construction sites at `:356` and `:405`
- Test: `src/app/api/drafts/[id]/live/route.test.ts` (exists); **create** `src/app/components/draft-board/DraftBoardCell.test.tsx` — `@testing-library/react` ^16.3.2 is already a devDependency, and `CollapsibleSection.test.tsx` in the same directory is a working example of the house pattern

**Interfaces:**
- Consumes: `getOptedOutSeats` (already imported in the route at line 8).
- Produces: `/live` response gains `redactedSeats: number[]` (1-indexed, sorted ascending, always present — `[]` when none). `DraftBoardCell` gains prop `isRedacted: boolean`.

- [ ] **Step 1: Write the failing tests**

Route test:

```typescript
it("returns redactedSeats for a draft with opt-outs", async () => {
  mockGetOptedOutSeats.mockResolvedValue(new Set([5]));
  const res = await GET(makeRequest(), { params: Promise.resolve({ id: "d1" }) });
  expect((await res.json()).redactedSeats).toEqual([5]);
});

it("returns an empty array when nothing is redacted", async () => {
  mockGetOptedOutSeats.mockResolvedValue(new Set());
  const res = await GET(makeRequest(), { params: Promise.resolve({ id: "d1" }) });
  expect((await res.json()).redactedSeats).toEqual([]);
});
```

Cell test:

```typescript
it("renders [REDACTED] for a redacted seat's completed pick", () => {
  render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={3} latestPickN={10} />);
  expect(screen.getByText("[REDACTED]")).toBeInTheDocument();
});

it("leaves a redacted seat's future picks blank", () => {
  render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={30} latestPickN={10} />);
  expect(screen.queryByText("[REDACTED]")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/app/api/drafts/\[id\]/live/route.test.ts src/app/components/draft-board/`
Expected: FAIL — `redactedSeats` undefined; `isRedacted` is not a prop.

- [ ] **Step 3: Implement the route change**

In `src/app/api/drafts/[id]/live/route.ts`, `optedOutSeats` is already fetched at line 78. Add to the response object:

```typescript
      redactedSeats: [...optedOutSeats].sort((a, b) => a - b),
```

Do **not** add it to `getLiveStateSig` — opt-outs change only via a CLI sync, and a stale sig here would at worst delay the flag by one poll.

- [ ] **Step 4: Implement the cell change**

In `DraftBoardCell.tsx`, extend the props and the `CellContent` branch. A redacted cell has no card name, so it renders the literal marker and no color gradient:

```typescript
  const showRedacted = isRedacted && pickN <= latestPickN;
  const displayName = showRedacted ? "[REDACTED]" : (optimisticCardName ?? cardName);
```

Guard the editability branch too — a redacted cell must never become a click-to-pick target even though its `cardName` is null:

```typescript
    if (isEditable && !showRedacted && !isEditing && cardName === null && optimisticCardName === null) {
```

In `DraftBoardMatrix.tsx`, pass `isRedacted={redactedSeats.includes(seat)}` and `latestPickN={board.latestPickN}` down to each cell, reading `redactedSeats` off the board payload with `?? []` so an older cached response cannot crash the render.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/app/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/api/drafts/\[id\]/live/route.ts src/app/components/draft-board/ src/app/stores/liveStore.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Render redacted pod-sheet cells from a seat-level flag

The picks are gone from the database, so the cells are generated from draft
metadata instead of from pick rows."
```

- [ ] **Step 7: Deploy A**

Run `pnpm precommit` **on the host**, then:

Run: `vercel --prod`

This is the deploy that makes the migration safe. Until the filtered ingest is live, the 10-minute cron re-inserts anything the migration deletes for `hardened-academic` and `ledger-shredder`. Read-time masks are still in place at this point, so nothing is exposed by shipping here.

- [ ] **Step 8: Capture the before-state**

```bash
turso db shell read-the-bones "SELECT (SELECT COUNT(*) FROM pick_events pe JOIN privacy_opt_outs p ON p.draft_id=pe.draft_id AND p.seat=pe.seat) AS picks, (SELECT COUNT(*) FROM deck_cards dc JOIN privacy_opt_outs p ON p.draft_id=dc.draft_id AND p.seat=dc.seat) AS deck_cards;"
```

Expected: roughly 412 picks and 298 deck cards — record what it actually reports rather than asserting the number. It will already be **lower** than that if a cron tick has run since Deploy A: the reconcile pass migrates the two drafts still in the sync window by itself. That is the design working, not a problem.

- [ ] **Step 9: Run the migration**

Run: `pnpm redact:opted-out`
Expected: per-draft lines for 10 drafts, then `remaining redacted rows: 0 picks, 0 deck cards`.

The script exists for the eight `complete` drafts. Those never enter the cron window (`lock.ts:114` selects only `setup`, `drafting`, `playing`), so nothing else will ever clean them.

- [ ] **Step 10: Confirm collateral is intact**

```bash
turso db shell read-the-bones "SELECT (SELECT COUNT(*) FROM match_events) AS matches, (SELECT COUNT(*) FROM privacy_opt_outs) AS opt_outs, (SELECT COUNT(*) FROM cube_snapshot_cards) AS cube_cards;"
```

Expected: `opt_outs` still 10, `matches` and `cube_cards` unchanged from before the run. Matches are deliberately preserved — the other seats' OMW%/OGW% are computed from the opted-out seat's record.

- [ ] **Step 11: Confirm the cron does not resurrect the rows**

Wait for one cron tick (10 minutes), then re-run the Step 8 query.

Expected: still `0 | 0`. A non-zero result means the filter is not actually live — check that Deploy A succeeded before continuing, because Tasks 7-8 remove the masks that are currently the only thing protecting this data.

---

### Task 7: Delete read-time masking from the query layer

Only start this once Tasks 1-4 are done and the migration has run. Removing the masks first would expose the data.

**Files:**
- Modify: `src/core/db/queries/picks.ts` — `getPicks:35-105`, `getStandings:275-405`, `getRecentPicks:430-453`, `getPicksWithCardDetails:474-516`
- Modify: `src/core/db/queries/pool.ts` — `getDraftPool:125-268`
- Modify: `src/core/db/queries/decklists.ts` — `getDeck:29-68`
- Modify: `src/app/api/drafts/[id]/live/route.ts:78-88` (keep the `getOptedOutSeats` call for `redactedSeats`; drop the now-unused parameter threading)
- Test: delete `queries.test.ts:763-788`, `:1309-1325`, `:1849-1949`; delete `queries.decklist.test.ts:48-56`

**Interfaces:**
- Produces: `PicksResult.picks[].seat` becomes `number`; `StandingsEntry.seat` becomes `number`; `PoolCard.drafted_by_seat` becomes `number | null`; `DeckResult.seat` becomes `number`. `redacted_seats` is removed from `PicksResult`, `StandingsResult`, and `DraftPoolResult`. The `optedOutSeats?: Set<number>` parameter is removed from `GetPicksParams`, `GetDraftPoolParams`, `GetDeckParams`, `getStandings`, `getRecentPicks`, and `getPicksWithCardDetails`.

- [ ] **Step 1: Delete the obsolete assertions**

Remove the four test blocks listed above outright. They assert a masking behavior that no longer exists; there is nothing left to rewrite them into.

Run: `pnpm vitest run src/core/db/`
Expected: PASS — the remaining tests must be green *before* the source edits, proving the deletions were surgical.

- [ ] **Step 2: Strip masking from `picks.ts`**

In `getPicks`, delete the `optedOutSeats` lookup, the early-return block at lines 39-46, the `redactedSeatsInResult` set, and the ternary at line 92 — `seat` becomes `row.seat as number`. In `getStandings`, delete the `resolvedOptedOutSeats` lookup and the whole redaction pass at lines 388-396, returning `entries` directly. In `getRecentPicks` and `getPicksWithCardDetails`, delete the `isRedacted` branches so card name, oracle id, colors, and mana cost are always the real values.

- [ ] **Step 3: Strip masking from `pool.ts` and `decklists.ts`**

In `getDraftPool`, delete the `optedOutSeats` lookup, the `isRedacted` check at line 208, `redactedSeatsInResult`, and both `redacted_seats` spreads; `drafted_by_seat` becomes `includeDraftResults ? draftedBySeat : null`. In `getDeck`, delete the entire early-return block at lines 32-39.

- [ ] **Step 4: Typecheck and fix fallout**

Run: `pnpm typecheck`
Expected: errors anywhere a consumer still narrows against `"[REDACTED]"`. Remove those narrowings — the union member is gone. Check `src/app/components/` and `src/app/stores/` for comparisons against the literal.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/ src/app/api/drafts/\[id\]/live/route.ts src/core/db/queries.test.ts src/core/db/queries.decklist.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Remove read-time redaction from the query layer

The rows no longer exist, so the three masking strategies have nothing left
to mask."
```

---

### Task 8: Delete aggregate opt-out exclusions

**Files:**
- Modify: `src/core/db/queries/stats/pickStats.ts:186-210`, `src/core/db/queries/stats/worth.ts:255-265`, `src/core/db/queries/stats/rankedAvailable.ts:320-340`, `src/core/db/queries/playStats.ts:70-80`, `src/core/db/queries/winStats.ts:85-95` and `:160-170`, `src/core/db/queries/winningDecks.ts:70-80`
- Modify: `src/core/db/queries/helpers.ts:47-76` — delete `fetchOptOuts`, keep `getOptedOutSeats`
- Test: `src/core/db/queries/stats/*.test.ts` — remove opt-out fixtures

**Interfaces:**
- Produces: `fetchOptOuts` no longer exists. `getOptedOutSeats` (already made standalone in Task 1) survives, consumed only by `redaction.ts` and the `/live` route.

- [ ] **Step 1: Delete each call site**

In each file listed above, remove the `fetchOptOuts` import, the `optedOut` variable, and the `if (optedOut.has(...)) continue;` guard (or the equivalent filter). In `pickStats.ts` this also collapses the `Promise.all` at line 186 from three members to two. Remove the `optedOutByDraft` parameter from `playStats` and `winStats` param types and from their callers.

- [ ] **Step 2: Delete `fetchOptOuts`**

Remove the function from `helpers.ts`.

Run: `pnpm knip` **on the host**
Expected: no new unused exports. If `placeholders` is now unused in a file, remove that import too.

- [ ] **Step 3: Confirm the numbers held**

Run: `pnpm test`
Expected: PASS. The stats fixtures must produce identical values — `pickScore` already treated an opted-out seat's absent picks as the unpicked case (`pickScore.ts:66-80`), so removing a filter over rows that no longer exist is a no-op. **A changed expected value here means something is wrong; do not update the fixture to match.**

- [ ] **Step 4: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/
git -C /Users/arpanet/code/read-the-bones commit -m "Remove aggregate opt-out exclusions

These filtered rows that no longer exist. Drops fetchOptOuts entirely."
```

---

### Task 9: Verification and rollout

**Files:** none modified.

- [ ] **Step 1: Confirm the invariant**

```bash
turso db shell read-the-bones "SELECT (SELECT COUNT(*) FROM pick_events pe JOIN privacy_opt_outs p ON p.draft_id=pe.draft_id AND p.seat=pe.seat) AS picks, (SELECT COUNT(*) FROM deck_cards dc JOIN privacy_opt_outs p ON p.draft_id=dc.draft_id AND p.seat=dc.seat) AS deck_cards;"
```

Expected: `0 | 0`. The migration already ran in Task 6; this re-checks it survived the intervening work, and in particular that no cron tick has reintroduced rows.

- [ ] **Step 2: Confirm no masking remains**

```bash
grep -rn "REDACTED" src/ scripts/ --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Expected: hits only in `DraftBoardCell.tsx` (the rendered literal) and its test. Anything under `src/core/db/queries/` means Task 7 or 8 is incomplete.

- [ ] **Step 3: Full quality gate — on the host**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, tests, and e2e all green. `knip` will fail in the sandbox regardless of correctness — its bindings are darwin-only.

- [ ] **Step 4: Re-pin the LODO validation**

Run: `pnpm worth:validate`

Read the printed ρ — the script always exits 0, so exit status is never evidence of a pass. It is expected to move slightly, since `getCards`' main-table P# changes for drafts containing an opted-out seat. Record the new value in the commit message and update the dated comment above `GATE_MARGIN`.

- [ ] **Step 5: Deploy B**

Run: `vercel --prod`

The second and final deploy. Required — the main page is statically prerendered, so the changed P# values are not visible until a rebuild, and every P# changes.

- [ ] **Step 6: Verify the deployed pod sheet**

Open the deployed site, select `hardened-academic`, and open the pod view. Seat 5's column must show `[REDACTED]` in every cell up to the latest pick, and blank cells beyond it. Their cards appear un-taken in the card table — that is the accepted trade, not a bug.

---

## Notes on what deliberately does not change

- **`match_events` is untouched.** The other seats' OMW%/OGW% are computed from the opted-out seat's record; dropping it would silently change their standings.
- **`privacy_opt_outs` stays.** It is the ingest filter's input, the source of `redactedSeats`, and the only thing distinguishing an opted-out seat from one that drafted nothing.
- **Availability queries become wrong.** `getAvailableCards`, `rankedAvailable`, and `search?available_only=1` count `pick_events` directly, so cards an opted-out player took now read as available. Accepted: these are reached only through the local RTB MCP server.
- **`cards` and `cube_snapshot_cards` are untouched.** The pool listing comes from the cube, not from picks.
- **The guarantee still rests on name matching.** Opt-outs are resolved by comparing `.opt-outs.json` entries against drafter name cells. `normalizeDrafterName` — which strips the `◈` decoration the sheet wraps around whoever is on the clock — landed only on 2026-08-08 in `2da5e28`, fixing that match silently failing. A missed match now means picks are *ingested* rather than merely exposed for one sync. The reconcile pass (Task 1) is what makes such a failure self-correcting on a later run, which is the whole reason it deletes rather than only skipping. Do not "simplify" it into a plain skip.
