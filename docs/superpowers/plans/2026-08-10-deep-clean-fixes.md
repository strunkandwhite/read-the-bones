# Deep Clean Fixes (2026-08-10 audit) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Critical and approved Important findings from the deep-clean audit of the 2026-08-06..09 commit window (`01c2661~1..HEAD`, 97 commits).

**Architecture:** Four independent themes, executed in order. (1) Privacy hardening — the ingest-time redaction redesign concentrated enforcement onto a few single points of failure that need to fail loudly and share one definition of "redacted tables". (2) Two correctness bugs — a fourth turn derivation that survived the `34c21ea` unification, and a store that resets standings but not the board on draft switch. (3) One modeling decision — session recency ordinals become a property of the world (all stats-phase drafts) rather than of the query, matching what `worth.ts` already does. (4) Documentation accuracy.

**Tech Stack:** TypeScript, Next.js 16, Turso/libsql, Zustand, vitest, Playwright.

**Baseline:** written against `13f5cfe`, re-verified against `16f1ac0` after the `autopick-cascade-parity` and `turso-read-reduction` branches merged. Those merges changed three things this plan depends on:

1. `processPick.ts` now has **three** `COUNT(*)` pick-count sites, not two — `481f37f` added an auto-pick-on-drafting-entry path. Task 6 covers all three.
2. `insertPickEvent` now takes a `source: PickSource` argument and stamps `created_at`. Task 6 does not change it, but code read alongside it will look different from the audit.
3. `computeIngestionHash` is now order-independent (`29032d9`), which resolved one of the audit's Minor findings. Removed from the deferred list.

`/api/cards/win-stats` is new and memoized on a `deck_hashes` + `match_events` fingerprint (`a724ca8`) rather than the ingestion hash. That is precisely the fix shape the deferred I4 needs for the worth table — reuse it when I4 is picked up.

## Global Constraints

- Always use `git -C /Users/arpanet/code/read-the-bones <cmd>`. Never combine `cd` and `git` — it triggers a permission prompt.
- Run `pnpm precommit` (typecheck → lint → knip → vitest → playwright) after each task's commit. It must pass before starting the next task.
- `pnpm lint` runs with `--max-warnings 0`. Zero warnings allowed.
- Commit messages: focus on *why*, 1-2 sentences, and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Comments state invariants, never the history of the change. Do not write comments that only make sense relative to this plan or a PR. This is a hard project convention (see global CLAUDE.md).
- Do not use em dashes in new user-facing copy.
- One commit per task. Do not batch tasks.
- Do not modify anything under `docs/superpowers/plans/` other than this file — plans are historical records. Task 10 modifies a *spec*, which is in scope.

## File Structure

| File | Change | Task |
|---|---|---|
| `scripts/redact-opted-out.ts` | Adopt shared flag guard; delete hand-mirrored preview queries | 1, 3 |
| `scripts/lib/cliFlags.ts` | Generalize docstring (no longer decklist-specific) | 1 |
| `src/core/optOuts.ts` | Fail loudly on malformed JSON; drop stale docstrings | 2 |
| `src/core/db/ingest/redaction.ts` | `REDACTED_TABLES` constant; `countRedactedRows`; return seat set | 3, 13 |
| `scripts/decklists.ts` | Explicit opted-out seat guard before write | 4 |
| `src/core/db/sync/syncActiveDraft.ts` | Skip never-CLI-synced drafts; single opt-out lookup; batch deletes | 5, 13 |
| `src/core/processPick.ts` | Derive pick number from `MAX(pick_n)` | 6 |
| `src/app/stores/draftStore.ts` | Clear `board`/`liveDraftStatus` on draft switch | 7 |
| `src/core/db/queries/stats/pickStats.ts` | Ordinals over unfiltered stats drafts | 8 |
| `src/core/db/queries/stats/rankedAvailable.ts` | Ordinals over unfiltered stats drafts | 8 |
| `src/core/getCards.ts` | Ordinals over all completed drafts | 8 |
| `README.md`, `CLAUDE.md` | Factual corrections and completeness | 9, 11 |
| `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md` | Remove false git-backup claim | 10 |
| `src/core/db/queries/picks.ts` | Parallelize `getLiveStateSig` | 12 |
| `src/core/cardTypes.ts` (new) | Single land/creature predicate | 14 |

---

## Task 1: Reject unrecognized flags in the redaction migration script

The one script whose only action is `DELETE` is the one that never adopted the flag guard written in the same window for exactly this hazard. `process.argv.includes("--dry-run")` means `--dryrun` runs a live destructive pass against the production database.

**Files:**
- Modify: `scripts/redact-opted-out.ts:56-58`
- Modify: `scripts/lib/cliFlags.ts:1-7` (docstring only)
- Test: `scripts/redact-opted-out.test.ts` (create)

**Interfaces:**
- Consumes: `assertRecognizedFlags(args: string[], recognized: Set<string>): void` from `scripts/lib/cliFlags.ts`.
- Produces: `parseRedactArgs(argv: string[]): { dryRun: boolean }`, exported for test.

- [ ] **Step 1: Write the failing test**

Create `scripts/redact-opted-out.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRedactArgs } from "./redact-opted-out";

describe("parseRedactArgs", () => {
  it("recognizes --dry-run", () => {
    expect(parseRedactArgs(["--dry-run"])).toEqual({ dryRun: true });
  });

  it("defaults to a live run with no flags", () => {
    expect(parseRedactArgs([])).toEqual({ dryRun: false });
  });

  // A mistyped rehearsal flag must not be indistinguishable from an
  // authorized destructive run against the production database.
  it("rejects a misspelled dry-run flag instead of deleting", () => {
    expect(() => parseRedactArgs(["--dryrun"])).toThrow(/Unrecognized flag: --dryrun/);
    expect(() => parseRedactArgs(["--dry_run"])).toThrow(/Unrecognized flag/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/redact-opted-out.test.ts`
Expected: FAIL — `parseRedactArgs` is not exported.

- [ ] **Step 3: Implement**

In `scripts/redact-opted-out.ts`, add to the imports:

```ts
import { assertRecognizedFlags } from "./lib/cliFlags";
```

Add above `main()`:

```ts
const RECOGNIZED_FLAGS = new Set(["--dry-run"]);

export function parseRedactArgs(argv: string[]): { dryRun: boolean } {
  assertRecognizedFlags(argv, RECOGNIZED_FLAGS);
  return { dryRun: argv.includes("--dry-run") };
}
```

Replace the body line `const dryRun = process.argv.includes("--dry-run");` with:

```ts
  const { dryRun } = parseRedactArgs(process.argv.slice(2));
```

Then check whether `main()` runs on import in this file. If it is called unconditionally at module scope, guard it the way `scripts/import-recovered-decks.ts` does at its bottom, so importing the module from a test does not execute a database migration. Copy that file's `invokedDirectly` pattern verbatim, including its `realpathSync` handling.

In `scripts/lib/cliFlags.ts`, the docstring says "shared by the scripts that write decklists". Widen the first line to cover any destructive script:

```ts
/**
 * Flag validation shared by the scripts that write or delete stored data.
 *
 * They all treat "no flags given" as "do the real thing", so a typo like
 * `--dryrun` silently becomes a destructive pass against the one production
 * database. Rejecting unknown `--` arguments is what keeps a mistyped
 * rehearsal from being indistinguishable from an authorized run.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/redact-opted-out.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add scripts/redact-opted-out.ts scripts/redact-opted-out.test.ts scripts/lib/cliFlags.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Guard the redaction migration's flags so a typo cannot delete for real

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Fail loudly when `.opt-outs.json` is malformed

`loadOptOutNames` catches every error and returns an empty set, so a malformed file is indistinguishable from "nobody opted out". Before the redesign that was survivable because every query re-masked at read time; now this file is the only enforcement input, and a trailing comma turns a full sync into an unredacted ingest with no output.

A *missing* file must keep returning an empty set — that is the normal case for a checkout without opt-outs, and for the serverless cron environment where the file is never deployed. Only a present-but-unreadable file is fatal.

**Files:**
- Modify: `src/core/optOuts.ts:1-39`
- Test: `src/core/optOuts.test.ts`

**Interfaces:**
- Produces: `loadOptOutNames(): Set<string>` — unchanged signature, now throws on a present-but-invalid file.

- [ ] **Step 1: Write the failing test**

Read `src/core/optOuts.test.ts` first to match its existing mocking style (the repo uses `memfs`; follow whatever that file already does rather than introducing a second approach). Add:

```ts
  it("returns an empty set when the file is absent", () => {
    // No file written. A checkout without opt-outs, and the serverless cron
    // environment, both hit this path legitimately.
    expect(loadOptOutNames()).toEqual(new Set());
  });

  it("throws rather than silently reporting no opt-outs on malformed JSON", () => {
    writeOptOutsFile('["Player One",]');
    expect(() => loadOptOutNames()).toThrow(/\.opt-outs\.json/);
  });

  it("throws when the file parses but is not an array of strings", () => {
    writeOptOutsFile('{"names": ["Player One"]}');
    expect(() => loadOptOutNames()).toThrow(/\.opt-outs\.json/);
  });
```

Implement `writeOptOutsFile` as a local helper matching the file's existing fs-mocking approach.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/optOuts.test.ts`
Expected: FAIL — the malformed cases currently return an empty set instead of throwing.

- [ ] **Step 3: Implement**

Replace `loadOptOutNames` in `src/core/optOuts.ts`:

```ts
/**
 * Load opt-out player names from .opt-outs.json.
 * Returns a Set of lowercase names for case-insensitive matching.
 *
 * An absent file means no opt-outs: that is the normal state of a checkout
 * without any, and the file is gitignored so it never reaches the serverless
 * environment. A file that exists but cannot be read as an array of names
 * throws instead, because this is the only input enforcing the opt-out
 * promise and an empty result is indistinguishable from success.
 */
export function loadOptOutNames(): Set<string> {
  if (!existsSync(OPT_OUTS_PATH)) {
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(OPT_OUTS_PATH, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${OPT_OUTS_PATH}: ${detail}`);
  }

  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new Error(
      `${OPT_OUTS_PATH} must be a JSON array of player names, e.g. ["Player One"]`,
    );
  }

  return new Set(parsed.map((name) => name.toLowerCase()));
}
```

Also fix the two stale docstrings in this file (audit finding: `isOptedOut` advertises a role it lost):
- The module docstring at the top claims use by "local draft tools (to redact opted-out players when reading CSVs directly)". The CSV pipeline is gone. Replace with: `Shared opt-out name loading from .opt-outs.json, the sole input recording which seats are excluded at ingest.`
- `isOptedOut`'s `@public Used by API routes for privacy filtering` is false — no route imports it since read-time redaction was removed. Check whether any non-test file imports `isOptedOut`. If nothing does, delete the function and its tests; if something does, correct the tag to name the real caller.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/optOuts.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/optOuts.ts src/core/optOuts.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Fail on an unreadable opt-outs file instead of reporting no opt-outs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: One definition of which tables hold redactable rows

The table list is enumerated three times: `reconcileRedactedRows`'s DELETEs, `previewRedactedRows`'s hand-mirrored COUNTs (its comment concedes the coupling), and the migration's post-run verification JOIN. `deck_hashes` was added to all three in a follow-up commit, which is the drift this shape invites. The failure mode is a privacy check reporting clean while data leaks.

**Files:**
- Modify: `src/core/db/ingest/redaction.ts`
- Modify: `scripts/redact-opted-out.ts:20-54` (delete `previewRedactedRows`)
- Test: `src/core/db/ingest/redaction.test.ts`

**Interfaces:**
- Produces: `export const REDACTED_TABLES = ["pick_events", "deck_cards", "deck_hashes"] as const;`
- Produces: `countRedactedRows(client: Client, draftId: string): Promise<RedactionCounts>`
- Produces: `type RedactionCounts = { picks: number; deckCards: number; deckHashes: number }`
- Note: `reconcileRedactedRows` currently returns `{ picksDeleted, deckCardsDeleted, deckHashesDeleted }`. Keep that shape — callers in `sync/index.ts` and `syncActiveDraft.ts` depend on it. Task 13 changes its signature; do not change it here.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db/ingest/redaction.test.ts` (follow the existing memdb setup in that file):

```ts
describe("countRedactedRows", () => {
  it("counts exactly the rows reconcileRedactedRows would delete", async () => {
    const client = await makeTestDb();
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: 2 });

    const counted = await countRedactedRows(client, "d1");
    const deleted = await reconcileRedactedRows(client, "d1");

    expect(counted).toEqual({
      picks: deleted.picksDeleted,
      deckCards: deleted.deckCardsDeleted,
      deckHashes: deleted.deckHashesDeleted,
    });
    // The seeding must produce a non-trivial case, or this asserts 0 === 0.
    expect(counted.picks).toBeGreaterThan(0);
    expect(counted.deckHashes).toBeGreaterThan(0);
  });

  it("counts nothing when the draft has no opted-out seats", async () => {
    const client = await makeTestDb();
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: null });
    expect(await countRedactedRows(client, "d1")).toEqual({
      picks: 0, deckCards: 0, deckHashes: 0,
    });
  });
});
```

Write `seedDraftWithOptedOutSeat` as a local helper (or reuse an existing one in that file) inserting rows into all three tables for both an opted-out and a retained seat, so the counts discriminate.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db/ingest/redaction.test.ts`
Expected: FAIL — `countRedactedRows` is not exported.

- [ ] **Step 3: Implement**

In `src/core/db/ingest/redaction.ts`, add above `reconcileRedactedRows`:

```ts
/**
 * Every table holding rows that belong to a single seat and must not survive
 * an opt-out. The delete pass, the dry-run counts and any verification query
 * all derive from this list, so adding a fourth table is one edit rather than
 * three that can silently disagree.
 */
export const REDACTED_TABLES = ["pick_events", "deck_cards", "deck_hashes"] as const;

export type RedactionCounts = { picks: number; deckCards: number; deckHashes: number };

const EMPTY_COUNTS: RedactionCounts = { picks: 0, deckCards: 0, deckHashes: 0 };

/**
 * Read-only count of what reconcileRedactedRows would delete for a draft.
 */
export async function countRedactedRows(
  client: Client,
  draftId: string,
): Promise<RedactionCounts> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) return EMPTY_COUNTS;

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  const results = await Promise.all(
    REDACTED_TABLES.map((table) =>
      client.execute({
        sql: `SELECT COUNT(*) AS n FROM ${table} WHERE draft_id = ? AND seat IN (${ph})`,
        args: [draftId, ...seats],
      }),
    ),
  );

  const [picks, deckCards, deckHashes] = results.map((r) => Number(r.rows[0].n));
  return { picks, deckCards, deckHashes };
}
```

`REDACTED_TABLES` is a fixed literal tuple, not user input, so interpolating it into SQL introduces no injection surface. Add that as a one-line comment above the `sql:` template.

Rewrite `reconcileRedactedRows`'s three DELETEs to iterate `REDACTED_TABLES` in the same order, preserving the existing return shape and the existing comment explaining why `deck_hashes` travels with `deck_cards`.

In `scripts/redact-opted-out.ts`: delete `previewRedactedRows` entirely, import `countRedactedRows` from `../src/core/db/ingest/redaction`, and update the dry-run branch to use the new field names (`picks`, `deckCards`, `deckHashes`). If the file has a post-run verification query that enumerates tables, rewrite it to iterate `REDACTED_TABLES` too. Remove the now-unused `placeholders` / `getOptedOutSeats` imports if nothing else in the file uses them.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/db/ingest/redaction.test.ts scripts/redact-opted-out.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/db/ingest/redaction.ts src/core/db/ingest/redaction.test.ts scripts/redact-opted-out.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Derive the redaction dry run from the same table list it deletes from

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Guard the decklist write path against opted-out seats

`scripts/decklists.ts` writes `deck_cards` and `deck_hashes` and never reads `privacy_opt_outs`. Its only protection is emergent: an opted-out seat has no picks, so it cannot clear the recall/precision gates. That holds only while `pick_events` is already clean. A run against a draft whose opt-out is recorded but not yet reconciled would assign and write a deck for that seat. The sibling importer has a real by-construction guard; this one should have an explicit one.

**Files:**
- Modify: `scripts/decklists.ts` (write path, around the batch at `:604-697`)
- Test: `scripts/decklists.test.ts`

**Interfaces:**
- Consumes: `getOptedOutSeats(client, draftId): Promise<Set<number>>` from `src/core/db/queries/helpers`.
- Produces: `assertSeatNotOptedOut(seat: number, optedOutSeats: Set<number>, draftId: string): void` — throws; exported for test.

- [ ] **Step 1: Write the failing test**

Add to `scripts/decklists.test.ts`:

```ts
import { assertSeatNotOptedOut } from "./decklists";

describe("assertSeatNotOptedOut", () => {
  it("refuses to write a deck for a seat that opted out", () => {
    expect(() => assertSeatNotOptedOut(2, new Set([2]), "tarkir")).toThrow(
      /seat 2 .*opted out/i,
    );
  });

  it("allows a seat that did not opt out", () => {
    expect(() => assertSeatNotOptedOut(3, new Set([2]), "tarkir")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run scripts/decklists.test.ts`
Expected: FAIL — `assertSeatNotOptedOut` is not exported.

- [ ] **Step 3: Implement**

Add to `scripts/decklists.ts`:

```ts
/**
 * A seat in privacy_opt_outs must never gain stored deck rows. The matcher
 * cannot reach one today because an opted-out seat has no picks to match
 * against, but that is a consequence of the pick rows already being clean
 * rather than a property of this script. Assert it locally so the guarantee
 * does not depend on another module's invariant holding.
 */
export function assertSeatNotOptedOut(
  seat: number,
  optedOutSeats: Set<number>,
  draftId: string,
): void {
  if (optedOutSeats.has(seat)) {
    throw new Error(
      `Refusing to write a deck for seat ${seat} of ${draftId}: the seat opted out`,
    );
  }
}
```

In `main()`, fetch the opted-out seats once per draft alongside the existing per-draft reads, then call `assertSeatNotOptedOut(seat, optedOutSeats, draftId)` immediately before the write batch is built for each seat — inside the real-write path *and* the dry-run reporting path, so a dry run surfaces the same refusal rather than promising a write that would throw.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run scripts/decklists.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add scripts/decklists.ts scripts/decklists.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Make the decklist writer refuse opted-out seats directly

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Do not let the cron ingest a draft before its first CLI sync

The cron never records opt-outs (`.opt-outs.json` is gitignored and never deployed), and reconciliation only deletes seats already recorded. A Sheets draft created with `pnpm draft:create` is picked up within a minute, so its first-ever sync writes an opted-out seat's picks unredacted and serves them until the operator's first CLI sync heals it.

The cron cannot do the pool/cube work anyway — that always needs the CLI (see CLAUDE.md) — so a draft with no recorded domain hashes has not been through the CLI yet and should be skipped rather than partially ingested.

**Files:**
- Modify: `src/core/db/sync/syncActiveDraft.ts` (after `getDomainHashes`, around `:91-98`)
- Test: `src/core/db/sync/__tests__/syncActiveDraft.test.ts`

**Interfaces:**
- Consumes: `getDomainHashes(client, draftId)` — already called at `syncActiveDraft.ts:92`; returns null/undefined for a never-synced draft.
- Produces: the existing result object gains status `"awaiting_cli_sync"`. Check the declared union type for `result.status` and add the member there.

- [ ] **Step 1: Write the failing test**

Add to `src/core/db/sync/__tests__/syncActiveDraft.test.ts`, following that file's existing mocking style:

```ts
  it("skips a draft that has never been synced from the CLI", async () => {
    // No domain hashes recorded => draft:create ran but pnpm sync has not.
    // Opt-outs are only recorded by the CLI, so ingesting here would write an
    // opted-out seat's picks before anything knows to exclude them.
    const client = makeClientWithNoDomainHashes();
    const insertSpy = spyOnPickInserts(client);

    const result = await syncActiveDraft(client, draftWithSheet, apiKey);

    expect(result.status).toBe("awaiting_cli_sync");
    expect(result.picksInserted).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });
```

Build the helpers to match the file's existing conventions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db/sync/__tests__/syncActiveDraft.test.ts`
Expected: FAIL — the draft is ingested and status is not `awaiting_cli_sync`.

- [ ] **Step 3: Implement**

In `syncActiveDraft.ts`, immediately after `const stored = await getDomainHashes(client, draft.draftId);` and before `reconcileRedactedRows`:

```ts
  // Opt-outs are recorded only by the CLI sync, which reads the gitignored
  // .opt-outs.json that never reaches this environment. Ingesting a draft the
  // CLI has not yet seen would store an opted-out seat's picks before anything
  // knows to exclude them, so wait for that first run. The pool and cube also
  // only ever land via the CLI, so there is no useful work to do here yet.
  if (!stored) {
    result.status = "awaiting_cli_sync";
    return result;
  }
```

Add `"awaiting_cli_sync"` to the status union type. Then check every consumer of that status — `src/app/api/sync/route.ts` and anything aggregating per-draft results — and make sure a skipped draft is reported rather than counted as a failure or a success. Grep for the other status values to find them all.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/db/sync/__tests__/syncActiveDraft.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/db/sync/syncActiveDraft.ts src/core/db/sync/__tests__/syncActiveDraft.test.ts src/app/api/sync/route.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Hold cron ingest until the CLI has synced a draft once and recorded opt-outs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Derive the next pick number from `MAX(pick_n)`, not `COUNT(*)`

`34c21ea` unified the double-pick *boundary* across server, query layer and client, but the pick-count argument still comes from two different queries. `processPick.ts` uses `SELECT COUNT(*)` at two sites; `getLiveStateSig` and `getLatestPickNumber` use `COALESCE(MAX(pick_n), 0)`, and the latter is what the board, `isMyTurn` and the desire column read.

These agree only while `pick_n` is gap-free. `95412dd` already established gaps are live (redaction deletes rows) and fixed the `.length` sites. `pnpm draft:admin undo-pick --pick <n>` deletes any pick, not just the last. After one such deletion the board says seat X, the server insists on seat Y, and `insertPickEvent`'s `NOT EXISTS` guard makes every subsequent pick fail permanently, because `COUNT+1` names an occupied `pick_n`.

**Files:**
- Modify: `src/core/processPick.ts` — **three** sites, currently at `:262`, `:439`, `:486`. Find them with `grep -n "COUNT(\*) as cnt FROM pick_events" src/core/processPick.ts`; ignore the `COUNT(*) as cnt` at `:149`, which counts copies of a card, not picks in the draft.
- Test: `src/core/processPick.test.ts`

**Note on the third site:** it lives in the auto-pick-on-drafting-entry path added by `481f37f`, which returns an `empty` result object instead of throwing. Apply the same substitution; do not convert its early returns into throws.

**Interfaces:**
- Consumes: `getLatestPickNumber(client, draftId): Promise<number>` from `src/core/db/queries/picks.ts:370`. The audit flagged this as dead (only its own test calls it); this task revives it as the single source. Do not delete it.
- Produces: no signature changes.

- [ ] **Step 1: Write the failing test**

Add to `src/core/processPick.test.ts`, following the file's existing db-fixture style:

```ts
  // pick_n gaps are real: ingest-time redaction deletes an opted-out seat's
  // rows, and draft:admin undo-pick removes any pick, not only the last. The
  // turn must follow the highest pick taken, which is what the board and the
  // live route both read.
  it("derives the turn from the highest pick number when a gap exists", async () => {
    const client = await seedLiveDraft({ numSeats: 4, picksPerPlayer: 6, doublePickAfterRound: null });
    await takePicks(client, "d1", 10);          // pick_n 1..10
    await client.execute({ sql: "DELETE FROM pick_events WHERE draft_id = ? AND pick_n = ?", args: ["d1", 4] });

    // 10 picks taken, one hole => the next pick is 11, not 10.
    const expectedSeat = getNextPick(10, 4, 6, null)!.seat;
    const result = await processPick(client, {
      draftId: "d1", seat: expectedSeat, cardId: freshCardId, cardName: freshCardName,
    });

    expect(result.picks[0].pickN).toBe(11);
  });

  it("rejects the seat that a gap-blind count would have named", async () => {
    const client = await seedLiveDraft({ numSeats: 4, picksPerPlayer: 6, doublePickAfterRound: null });
    await takePicks(client, "d1", 10);
    await client.execute({ sql: "DELETE FROM pick_events WHERE draft_id = ? AND pick_n = ?", args: ["d1", 4] });

    const wrongSeat = getNextPick(9, 4, 6, null)!.seat;   // what COUNT(*) would give
    const rightSeat = getNextPick(10, 4, 6, null)!.seat;
    expect(wrongSeat).not.toBe(rightSeat);                // the test is discriminating

    await expect(
      processPick(client, { draftId: "d1", seat: wrongSeat, cardId: freshCardId, cardName: freshCardName }),
    ).rejects.toThrow(ValidationError);
  });
```

Reuse the file's existing seeding helpers rather than inventing new ones; adapt the names above to whatever it already provides. The `expect(wrongSeat).not.toBe(rightSeat)` line is load-bearing — without it the second test can pass vacuously if the two seats happen to coincide. If they do coincide for these parameters, change the deleted `pick_n` or the seat count until they differ.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/processPick.test.ts`
Expected: FAIL — with `COUNT(*)` the first test produces `pickN` 10 and the second accepts the wrong seat.

- [ ] **Step 3: Implement**

In `src/core/processPick.ts`, import `getLatestPickNumber` from `./db/queries/picks`, then at **all three** sites replace:

```ts
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
```

with:

```ts
  // The highest pick taken, not how many rows exist: redaction and
  // undo-pick both leave gaps in pick_n, and a count would then name an
  // occupied slot and collide with insertPickEvent's uniqueness guard
  // forever. The board and the live route derive the turn the same way.
  const currentCount = await getLatestPickNumber(client, draftId);
```

One site uses `input.draftId` rather than `draftId` — keep each site's own variable. Rename the local from `currentCount` to `latestPickN` at all three and update every derived expression (`const pickN = currentCount + 1`, `const pickN = currentCount + picks.length + 1`, and whatever the third site derives) to match; the old name now describes something the value is not.

Check the import direction: `src/core/processPick.ts` importing from `src/core/db/queries/picks.ts` must not create a cycle. If `picks.ts` imports from `processPick.ts`, move `getLatestPickNumber` into a module both can depend on instead, and note the move in the commit message.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/processPick.test.ts src/core/db/queries/picks.liveDraft.test.ts`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/processPick.ts src/core/processPick.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Derive the turn from the highest pick so a gap cannot deadlock the draft

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Clear board state when the active draft changes

The `activeDraft` subscription stops polling and resets standings — its own comment says "so the previous draft's data isn't shown while loading" — but leaves `board` and `liveDraftStatus` holding the previous draft's payload. In that window `cardStore` derives `effectiveTakenCards` from the stale `board.picks`, which feeds `seatCardList`, which triggers `debouncedSyncDeckWithPicks`, which rebuilds against the wrong draft's picks and PUTs the result to the new draft's `deck-state`. The route validates `draftId` and `seat` but not that the cards belong to that draft's cube.

**Files:**
- Modify: `src/app/stores/draftStore.ts:731-741`
- Test: `src/app/stores/draftStore.test.ts`

**Interfaces:** No signature changes.

- [ ] **Step 1: Write the failing test**

Add to `src/app/stores/draftStore.test.ts`:

```ts
  it("drops the previous draft's board when the active draft changes", () => {
    useDraftStore.setState({ activeDraft: "draft-a", board: boardFixture("draft-a") });
    expect(useDraftStore.getState().board).not.toBeNull();

    useDraftStore.setState({ activeDraft: "draft-b" });

    // Consumers derive taken cards and the local-deck mode from board, and a
    // deck save triggered in this window would write draft-a's cards to
    // draft-b's seat.
    expect(useDraftStore.getState().board).toBeNull();
    expect(useDraftStore.getState().liveDraftStatus).toBeNull();
  });
```

Match the file's existing fixture helpers for `boardFixture`. If the subscription is registered as a side effect of importing the module, ensure the test imports it the same way the existing subscription tests in this file do.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/stores/draftStore.test.ts`
Expected: FAIL — `board` still holds draft-a's payload.

- [ ] **Step 3: Implement**

In the `activeDraft` subscription, extend the existing `setState` call and widen its comment:

```ts
    // Drop everything scoped to the draft we just left. Consumers derive taken
    // cards, local-deck mode and the pick matrix from board, and a deck save
    // triggered from stale picks would write the previous draft's cards to
    // this draft's seat.
    useDraftStore.setState({
      board: null,
      liveDraftStatus: null,
      standings: [],
      standingsMatches: [],
      standingsLoading: false,
      pendingMatch: null,
    });
```

Then verify every reader tolerates `null`. `board` is typed `BoardData | null` and initialised `null`, so types cover it, but check the consumers the audit named: `cardStore.ts:233` (`effectiveTakenCards`), `live/localDeck.ts:14` (`getLocalDeckMode`), `selectors.ts:25` (`useLocalDeckMode`), and `DraftBoardModal` / `DraftBoardMatrix` / `CardTable`'s desire column. Any that render a default when board is absent are fine; any that assume the previous shape need a guard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/stores/ && pnpm test:e2e`
Expected: PASS. The e2e run matters here — seat and draft switching are covered by `spectator.spec.ts` and `sheet-draft-deck-builder.spec.ts`, which exercise exactly this transition.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/app/stores/draftStore.ts src/app/stores/draftStore.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Clear the board on draft switch so a stale deck save cannot cross drafts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Number sessions against all stats-phase drafts everywhere

**Decision (settled with the user): a session's recency is a property of the world, not of the query.** The half-life models "the group has drafted N more times since, so this observation says less about how they value the card now", and that stays true whether or not those drafts are in the current view.

`sessionsAgoByDraft` assigns *dense* ordinals over the distinct dates it is handed. Because `pickScore`'s weight depends only on differences, a uniform shift cancels exactly — so the four call sites agree in every case **except** when the set omits an interior session, which collapses the gap and re-weights everything older than the hole while leaving newer observations untouched.

`worth.ts:133` already does this correctly: ordinals over the full set, *then* filter. Bring the other three in line. This is a no-op in every case except the interior-gap one, where it produces the correct answer.

**Files:**
- Modify: `src/core/db/queries/stats/pickStats.ts:126-160`
- Modify: `src/core/db/queries/stats/rankedAvailable.ts:352-362` and its `Promise.all` at `:271`
- Modify: `src/core/getCards.ts:508-515`
- Modify: `src/core/draftSessions.ts` (docstring)
- Test: `src/core/db/queries/stats/cardStats.test.ts`, `rankedAvailable.test.ts`, `getCards.test.ts`

**Interfaces:**
- `sessionsAgoByDraft(drafts: Array<{draftId: string; draftDate: string}>): Map<string, number>` — signature unchanged. Only the argument each caller passes changes.

- [ ] **Step 1: Write the failing test**

The discriminating case is a card present in sessions 0 and 2 while an interior session 1 is filtered out. Add to `src/core/db/queries/stats/cardStats.test.ts` (memdb style, as that file already uses):

```ts
  // Session ordinals describe how much drafting has happened since, so they
  // must not renumber when a filter removes an interior session. A collapsed
  // gap silently re-weights every older observation against the newest one.
  it("keeps the real session gap when a filter excludes an interior session", async () => {
    const client = await makeTestDb();
    await seedDraft(client, { draftId: "aug", date: "2026-08-01", name: "aug pod" });
    await seedDraft(client, { draftId: "jul", date: "2026-07-01", name: "jul pod" });
    await seedDraft(client, { draftId: "jun", date: "2026-06-01", name: "jun pod" });
    await seedPick(client, { draftId: "aug", cardName: "Bolt", pickN: 1 });
    await seedPick(client, { draftId: "jun", cardName: "Bolt", pickN: 30 });

    // "pod" matches all three; the July draft holds no Bolt pick either way,
    // so this filter changes only which drafts the ordinals span.
    const unfiltered = await getCardPickStats(client, { card_name: "Bolt" });
    const filtered = await getCardPickStats(client, { card_name: "Bolt", draft_name: "pod" });

    expect(filtered.weighted_geomean).toBeCloseTo(unfiltered.weighted_geomean, 10);
  });
```

Then add a test that pins the arithmetic directly, so the behavior is anchored rather than only compared against itself:

```ts
  it("weights a two-sessions-back observation at 0.5^(2/4)", async () => {
    // Aug at ordinal 0 (weight 1), Jun at ordinal 2 (weight 0.7071).
    // geomean = exp((1*ln 1 + 0.70711*ln 30) / 1.70711)
    const client = await makeTestDb();
    await seedDraft(client, { draftId: "aug", date: "2026-08-01" });
    await seedDraft(client, { draftId: "jul", date: "2026-07-01" });
    await seedDraft(client, { draftId: "jun", date: "2026-06-01" });
    await seedPick(client, { draftId: "aug", cardName: "Bolt", pickN: 1 });
    await seedPick(client, { draftId: "jun", cardName: "Bolt", pickN: 30 });

    const stats = await getCardPickStats(client, { card_name: "Bolt" });
    const w = Math.pow(0.5, 2 / 4);
    expect(stats.weighted_geomean).toBeCloseTo(
      Math.exp((1 * Math.log(1) + w * Math.log(30)) / (1 + w)), 6,
    );
  });
```

Adapt seeding helpers to whatever the file already provides. Note the July draft must be a *stats-phase* draft (complete or playing) with no Bolt pick, or it will not occupy a session slot.

- [ ] **Step 2: Run tests to verify the first fails**

Run: `pnpm vitest run src/core/db/queries/stats/cardStats.test.ts`
Expected: the interior-gap test FAILS (filtered collapses Jun from ordinal 2 to 1, so the geomeans differ). The arithmetic test may already pass unfiltered — that is fine, it guards the fix.

- [ ] **Step 3: Implement**

**`pickStats.ts`** — the ordinal query currently reads:

```ts
      sql: `SELECT draft_id, draft_date FROM drafts d
            WHERE ${phaseFragment} ${draftWhere}`,
      args: [...phaseArgs, ...draftArgs],
```

Drop the filter so it spans every stats-phase draft:

```ts
      sql: `SELECT draft_id, draft_date FROM drafts d WHERE ${phaseFragment}`,
      args: [...phaseArgs],
```

Replace the comment above it (it currently says ordinals must span drafts "matching this query's filters", which is the behavior being removed):

```ts
    // Session ordinals span every stats-phase draft, not the filtered subset:
    // how much drafting has happened since an observation is a fact about the
    // world, not about the current query. Numbering a filtered set densely
    // would close the gap left by an excluded interior session and silently
    // re-weight every older observation.
```

The existing comment below (`draftIds is always a subset of allStatsDraftsResult's rows…`) stays true and gets stronger — keep it.

**`rankedAvailable.ts`** — its ordinal map is built from `draftsResult`, which is cube-joined to the ranked card ids. Add a fourth query to the existing `Promise.all` at `:271`:

```ts
    client.execute({
      sql: `SELECT draft_id, draft_date FROM drafts d WHERE ${statsPhaseFilter("d.phase").fragment}`,
      args: [...statsPhaseFilter("d.phase").args],
    }),
```

Follow the file's existing convention of calling `statsPhaseFilter` once per query into a named local (the file has a comment at `:265` explaining that each query needs its own call so arg order matches its own placeholders) — declare `const allDraftsPhase = statsPhaseFilter("d.phase");` alongside `draftPhase` and `pickPhase`, and use it here.

Then build `sessionsAgo` from that result instead of `draftDates`, and replace the overstated comment:

```ts
  // Session ordinals span every stats-phase draft, not just those whose cube
  // held one of the ranked cards. A card that sat out a session must keep the
  // real gap on either side of it, and the gap is a fact about the drafting
  // history rather than about this query's filters.
```

**`getCards.ts`** — change the map source from `selectedDraftIds` to `completedDraftIds` (`draftMetadataMap` is populated for every draft in the same loop that builds `completedDraftSet`, so every id resolves):

```ts
  // Session ordinals span every completed draft, not the selection: how much
  // drafting has happened since a pick is a fact about the history, so
  // deselecting an interior session must not re-weight the ones around it.
  // This also keeps the main table's P# equal to the stats modal's.
  const sessionsAgo = sessionsAgoByDraft(
    completedDraftIds.map((draftId) => ({
      draftId,
      draftDate: draftMetadataMap.get(draftId)!.date,
    })),
  );
```

**`draftSessions.ts`** — extend the module docstring so the rule lives with the function:

```ts
 * Ordinals are dense over the dates given, so callers must pass every
 * stats-phase draft rather than a filtered subset. Only the differences
 * between ordinals affect the weight, so a uniform shift is harmless, but a
 * set that omits an interior session closes that gap and re-weights every
 * older observation against the newest one.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/db/queries/stats/ src/core/getCards.test.ts src/core/pickScore.test.ts`
Expected: PASS.

Some existing tests may encode the old dense-over-filtered numbering. For each failure, decide whether the fixture is asserting the behavior being deliberately changed — if so, update the expected value and add a sentence to the test's comment saying ordinals span all stats-phase drafts. Do not weaken an assertion to make it pass.

- [ ] **Step 5: Re-pin the LODO gate**

`worth.ts` is unchanged, so the worth model should be unaffected, but `pnpm worth:validate` is the check that proves it. Run it:

```bash
pnpm worth:validate
```

Expected: the pinned gate (`minPooledRho` 0.0616, per `scripts/worth-validate.ts`) still passes. If it moved, stop and report the delta rather than re-pinning — `worth.ts` was not supposed to change, so a moved gate means one of the three edits reached it.

- [ ] **Step 6: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/pickStats.ts src/core/db/queries/stats/rankedAvailable.ts src/core/getCards.ts src/core/draftSessions.ts src/core/db/queries/stats/cardStats.test.ts src/core/db/queries/stats/rankedAvailable.test.ts src/core/getCards.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Number sessions against all stats drafts so a filter cannot reweight history

Recency describes how much drafting has happened since an observation, which
does not depend on which drafts the current query selects.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Correct the factually wrong documentation claims

Three separate wrong facts, one editing pass. The 45-pick one actively reproduces a production incident.

**Files:**
- Modify: `README.md:44`, `README.md:72`, `README.md:123`
- Modify: `src/app/api/sync/route.ts:93`, `src/core/db/sync/index.ts:14` (stale comments)

- [ ] **Step 1: Fix the cron cadence (three places)**

`vercel.json` is `"* * * * *"`. `README.md:44` says "runs every 10 minutes in production" — change to "runs every minute in production". Change `src/app/api/sync/route.ts:93` "Called by Vercel cron job every 10 minutes." to "every minute", and `src/core/db/sync/index.ts:14` "(Vercel cron, every 10 min)" to "(Vercel cron, every minute)".

- [ ] **Step 2: Fix the live-draft creation example**

`README.md:72` omits `--double-pick-after` for a 45-pick draft. Omitting it stores NULL and falls back to the `floor(N/4)` heuristic — round 23 instead of 25 — which is the mismatch `34c21ea` was written to fix. Add the flag to the example and a sentence after it:

```
pnpm draft:create-live --name "Name" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:<id> --double-pick-after 25
```

Follow it with: `--double-pick-after is the last single-pick round. Omitting it stores NULL and falls back to a floor(N/4) heuristic, which gives round 23 for a 45-pick draft and puts the board and the server on different seats.`

- [ ] **Step 3: Correct the retroactive opt-out claim**

`README.md:123` currently ends: "Every sync also deletes any such rows that predate the opt-out, so adding a name is retroactive."

That is only true for drafts still in the sync window — `pnpm sync` selects `phase IN ('setup','drafting','playing')`, and completed drafts have left it permanently. Per the user's decision this is a documentation fix, not a behavior change. Replace that sentence with:

```
Every sync of a draft still in the sync window also deletes any such rows that predate the opt-out. Completed drafts have left that window, so add a name before the drafts it applies to complete; naming a seat afterwards requires re-syncing those drafts individually with `pnpm sync <draft-name>`.
```

- [ ] **Step 4: Verify**

```bash
grep -rn "10 minutes\|10 min" README.md src/app/api/sync/route.ts src/core/db/sync/index.ts
```
Expected: no matches.

```bash
pnpm precommit
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add README.md src/app/api/sync/route.ts src/core/db/sync/index.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Correct the sync cadence, the 45-pick example and the retroactive opt-out claim

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: Remove the decklist spec's false git-backup claim

`13f5cfe` moved the recovered decklists out of the repo and rewrote the paths but not the reasoning around them. The spec now claims the parsed JSONs are "committed to git" at a path that is gitignored, and one section argues against its own conclusion. This contradicts the correct and load-bearing warning in CLAUDE.md on the one hazard where being wrong is unrecoverable.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md:157-159` and `:182-183`

Do **not** modify `docs/superpowers/plans/2026-08-09-decklist-recovery.md`, which carries the same wording but is a historical record.

- [ ] **Step 1: Read both passages in full**

```bash
sed -n '150,190p' docs/superpowers/specs/2026-08-09-decklist-recovery-design.md
```

- [ ] **Step 2: Rewrite D4**

It claims the loss is "only survivable because the parsed JSONs are **committed to git** at `data/decklist-recovery/parsed/`". They are not — `data/` is gitignored. Rewrite so the decision records the actual risk, matching CLAUDE.md's warning: the JSONs live in a gitignored directory with no second copy, so a `draft:reset` plus a lost `data/` directory destroys them permanently, and the mitigation is an out-of-repo backup rather than version control.

- [ ] **Step 3: Rewrite D6**

It reads "Its output is committed as `data/decklist-status.md`. `data/` is gitignored, and a queue that vanishes with the working directory is not a queue" — the rationale contradicts its own conclusion. Rewrite it to state what is actually true: the status report is regenerated on demand with `pnpm decklists:integrity --write-report` and lives in the gitignored `data/` directory, so it is reproducible from the database rather than preserved by version control.

- [ ] **Step 4: Verify no other doc points at the old in-repo paths**

```bash
grep -rn "docs/decklist-status\|docs/decklist-recovery-parsed\|committed to git" docs/superpowers/specs/ CLAUDE.md README.md
```
Expected: no matches in specs; anything left in `docs/superpowers/plans/` is a historical record and stays.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add docs/superpowers/specs/2026-08-09-decklist-recovery-design.md
git -C /Users/arpanet/code/read-the-bones commit -m "Correct the recovery spec's claim that the parsed decklists are in git

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Close the documentation gaps

Reference-completeness work in CLAUDE.md, all verifiable against the tree.

**Files:**
- Modify: `CLAUDE.md` (Project Structure, Key Commands, REST API, doc index, Key Features)
- Modify: `README.md` (feature descriptions)

- [ ] **Step 1: Rebuild the Project Structure listing**

```bash
ls scripts/ scripts/lib/ src/core/*.ts src/app/stores/live/
```

The `scripts/` line names 8 files where far more exist, and omits `scripts/lib/` entirely while the same document cites `scripts/lib/deckMatching.ts` and `scripts/lib/deleteDraft.ts` as authoritative elsewhere. Update it from the listing. Add the `src/core` modules missing from the tree — `draftSessions.ts`, `manaSources.ts`, `manaCost.ts`, `pickScore.ts` (named in prose two sections later), `worthModel.ts`, `optOuts.ts` — and add `localDeck.ts` to the `stores/live/` list.

- [ ] **Step 2: Document the missing commands**

Add to Key Commands, verifying each flag against the script's own arg parsing before writing it down:

- `pnpm decklists:integrity` and `--write-report` (the only way to regenerate `data/decklist-status.md`, which CLAUDE.md calls the remediation queue), plus the per-seat coverage reporting added in `3257d8c`
- `pnpm decklists:import`, `--dry-run`, `--force`
- `pnpm redact:opted-out` and `--dry-run`, in the privacy section, described as the one-time migration that cleaned rows predating ingest-time redaction
- `pnpm worth:validate`

- [ ] **Step 3: Reconcile the doc index against the tree**

The dev-only route table is already correct — `16f1ac0` added `/api/cards/worth` and `/api/cards/win-stats` with their memo keys, so that part of this step is done. Verify it still matches `ls src/app/api/cards/`, then reconcile the doc index:

```bash
ls docs/superpowers/specs/ docs/superpowers/plans/
```

Add every missing entry, including the worth-model and desire-metric specs and plans.

- [ ] **Step 4: Correct README feature drift**

- Ranking description: add the third weight factor, `0.5^(sessionsAgo/4)`, alongside copy weight and the unpicked penalty
- Deck builder: mention the maindeck creature / non-creature split
- Queue: it says entries "drag-and-drop to reorder"; since `2da5e28` the grip is the sole drag activator, which is the point of the mobile change
- Decklist workflow: it says to add URLs and run `pnpm decklists`, contradicting the inbox semantics CLAUDE.md defines. Add the `--dry-run` → read → apply → remove-the-URL sequence and the follow-up integrity check
- Privacy "Not stored": add `deck_hashes`, which joined redaction in `8feef0d`
- Add a short version of CLAUDE.md's `draft:reset` + missing `.opt-outs.json` hazard, the one way the promise silently breaks

- [ ] **Step 5: Fix the two smaller inaccuracies**

- CLAUDE.md says `--pool` defaults to `cubecobra:samp`. `scripts/draft-create-live.ts:58` throws `"--pool is required"` and `samp` appears nowhere in the code. Reword as a team convention for which cube to use, not a code default.
- The `/pick` route entry describes `{ auto: true }` as triggering the cascade. Since `34c21ea` it also consults the seat's `auto_pick` flag and returns `autoPickDisabled: true` without picking. Document the field.
- CLAUDE.md's Active-draft-sync bullet says "The cron covers phases `setup`, `drafting`, and `playing`". Task 5 changed that: a draft still in `setup` has not had its first CLI sync, so the cron now skips it and reports `awaiting_cli_sync`. The draft-selection query still includes `setup`, so the phase list is right about which drafts are *considered* and wrong about which are *ingested*. Say that a Sheets draft needs one `pnpm sync <name>` before the cron will touch it, and why (opt-outs are recorded only by the CLI, which reads the gitignored `.opt-outs.json`).

- [ ] **Step 6: Verify and commit**

Re-read each claim you touched against the code once more, then:

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add CLAUDE.md README.md
git -C /Users/arpanet/code/read-the-bones commit -m "Bring the command, module and route references back in line with the tree

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: Parallelize the live-poll signature queries

`getLiveStateSig` awaits four fully independent reads sequentially, and the route awaits `resolveToken` before it — five serial round trips on *every* poll, including the idle ones the `?since=` short-circuit exists to make cheap. A 10-seat pod at a 10s interval pays about 240 avoidable serial hops a minute.

**Files:**
- Modify: `src/core/db/queries/picks.ts:484-520`
- Test: `src/core/db/queries/picks.liveDraft.test.ts`

**Interfaces:** No signature change. `getLiveStateSig` returns the same string for the same state — that is what the test must pin.

- [ ] **Step 1: Write the characterization test first**

Before touching the implementation, pin the current output so the refactor is provably behavior-preserving:

```ts
  it("produces a stable signature for a fixed draft state", async () => {
    const client = await seedLiveDraftForSig();
    const sig = await getLiveStateSig(client, "d1", 3);
    expect(sig).toBe(await getLiveStateSig(client, "d1", 3));
    // Pin the literal so a reordering that changes composition is caught.
    expect(sig).toMatchInlineSnapshot();
  });
```

Run it once to fill the inline snapshot, and read the filled value to confirm it looks like a real composed signature rather than an empty or partial string.

- [ ] **Step 2: Run to verify it passes against current code**

Run: `pnpm vitest run src/core/db/queries/picks.liveDraft.test.ts`
Expected: PASS with the snapshot recorded.

- [ ] **Step 3: Implement**

The seat-marker query depends on the resolved seat; the other reads do not depend on each other. Restructure so the independent reads run in one `Promise.all`, preserving the exact order in which their results are concatenated into the signature string. Do not change the composition — only when the queries are issued.

In `src/app/api/drafts/[id]/live/route.ts`, `getOptedOutSeats` at `:79` is a standalone hop immediately before a six-way `Promise.all` it could join. Since redaction moved to ingest, it now only feeds the `redactedSeats` display flag and no longer gates the pick queries below it. Move it into that `Promise.all`.

- [ ] **Step 4: Run tests to verify the signature is unchanged**

Run: `pnpm vitest run src/core/db/queries/picks.liveDraft.test.ts src/app/api/drafts/`
Expected: PASS with the snapshot matching — an unchanged snapshot is the proof the refactor preserved behavior.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/picks.ts src/core/db/queries/picks.liveDraft.test.ts src/app/api/drafts/\[id\]/live/route.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Issue the live-poll reads in parallel instead of five serial round trips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: Stop the cron re-querying opt-outs and firing no-op deletes

`reconcileRedactedRows` fetches the opted-out seat set and discards it; the next line fetches it again. When a draft has any opt-out it then issues three unbatched serial DELETEs on every run regardless of whether a row could exist — and this runs before the hash short-circuit, so an idle minute pays in full. The repo has live opt-outs, so this is active: roughly 5,800 wasted round trips a day per affected draft.

**Files:**
- Modify: `src/core/db/ingest/redaction.ts` (return the seat set; batch the deletes)
- Modify: `src/core/db/sync/syncActiveDraft.ts:98-99`
- Modify: `src/core/db/sync/index.ts:155,275` (same double lookup, CLI side)
- Test: `src/core/db/ingest/redaction.test.ts`, `src/core/db/sync/__tests__/syncActiveDraft.test.ts`

**Interfaces:**
- Changes: `reconcileRedactedRows` returns `{ picksDeleted, deckCardsDeleted, deckHashesDeleted, optedOutSeats: Set<number> }`. Both sync paths currently call `getOptedOutSeats` separately right after it — remove those calls and use the returned set.

- [ ] **Step 1: Write the failing test**

```ts
  it("returns the seat set it filtered on so callers need not re-query", async () => {
    const client = await makeTestDb();
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: 2 });
    const result = await reconcileRedactedRows(client, "d1");
    expect(result.optedOutSeats).toEqual(new Set([2]));
  });

  it("issues no delete statements when the draft has no opted-out seats", async () => {
    const client = await makeTestDb();
    const executed: string[] = [];
    const spied = spyOnExecute(client, executed);
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: null });

    await reconcileRedactedRows(spied, "d1");

    expect(executed.filter((sql) => /^\s*DELETE/i.test(sql))).toHaveLength(0);
  });
```

Match the file's existing client-spy conventions.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/db/ingest/redaction.test.ts`
Expected: FAIL — `optedOutSeats` is not on the return value.

- [ ] **Step 3: Implement**

Add `optedOutSeats` to `reconcileRedactedRows`'s return (both the early-return branch and the main path). Replace the three sequential `client.execute` DELETEs with a single `client.batch` over `REDACTED_TABLES` (from Task 3), keeping the per-table result counts. Confirm the `batch` result exposes `rowsAffected` per statement in the same order; if it does not, keep separate executes inside one `Promise.all` and say so in the commit message.

Then at `syncActiveDraft.ts:98` and `sync/index.ts:275`, delete the redundant `getOptedOutSeats` call and take the set from the reconcile result. At `sync/index.ts:155` check whether that earlier call is still needed for `insertOptOuts` ordering — the CLI records opt-outs *before* hashing, so that call may be genuinely separate. Leave it if so, and only remove the one that duplicates reconcile's.

The delete-before-ingest ordering is load-bearing and documented at `syncActiveDraft.ts:94`. Do not reorder it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/db/ingest/ src/core/db/sync/`
Expected: PASS. The cross-path hash-consistency test in `sync.test.ts` is the one that proves the CLI and cron still agree — it must stay green.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/db/ingest/redaction.ts src/core/db/ingest/redaction.test.ts src/core/db/sync/syncActiveDraft.ts src/core/db/sync/index.ts src/core/db/sync/__tests__/
git -C /Users/arpanet/code/read-the-bones commit -m "Reuse the reconcile pass's seat set and skip its deletes when nothing opted out

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: One predicate for "is this a land"

Four incompatible definitions, two of them rendered side by side. The zone header counts lands with `typeLine.includes("land")`; `colorSourceSplits` — in the same header row — uses a face-aware rule that excludes transforming DFCs. For a transforming card with a land back (Search for Azcanta, Legion's Landing — cube staples), the card sits in the Lands column, counts toward the land total, and simultaneously contributes zero mana sources while adding to the requirement side. Two numbers on one line derived from contradictory definitions of the same word.

**Files:**
- Create: `src/core/cardTypes.ts`
- Create: `src/core/cardTypes.test.ts`
- Modify: `src/app/components/deck-builder/DeckZone.tsx:88-100`
- Modify: `src/core/manaSources.ts:79-88`
- Modify: `src/core/deckBuilder.ts:156-167`
- Modify: `src/core/db/queries/stats/worth.ts:162-167`

**Interfaces:**
- Produces: `isLand(typeLine: string): boolean` — true when any face is a land
- Produces: `isFrontFaceLand(typeLine: string): boolean` — true when the front face is a land
- Produces: `isCreature(typeLine: string): boolean` — true when any face is a creature
- Produces: `FACE_SEPARATOR = " // "` — re-exported from `src/core/cardNames.ts` if it already lives there; otherwise defined here and imported by `manaCost.ts` and `manaSources.ts`, which currently declare it twice

- [ ] **Step 1: Write the failing test**

Create `src/core/cardTypes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isLand, isFrontFaceLand, isCreature } from "./cardTypes";

describe("isLand", () => {
  it("accepts a plain land", () => {
    expect(isLand("Land")).toBe(true);
    expect(isLand("Basic Land — Island")).toBe(true);
  });

  // The case the four old predicates disagreed on: the deck builder filed it
  // as a land while the mana-source readout counted it as a colored spell.
  it("accepts a transforming card whose back face is a land", () => {
    expect(isLand("Legendary Enchantment // Legendary Land")).toBe(true);
  });

  it("rejects a card that only mentions land in its type words", () => {
    expect(isLand("Creature — Landwalker")).toBe(false);
  });

  it("rejects a non-land", () => {
    expect(isLand("Instant")).toBe(false);
  });
});

describe("isFrontFaceLand", () => {
  it("is false for a spell that transforms into a land", () => {
    expect(isFrontFaceLand("Legendary Enchantment // Legendary Land")).toBe(false);
  });

  it("is true for a land with a land back", () => {
    expect(isFrontFaceLand("Land // Land")).toBe(true);
  });
});

describe("isCreature", () => {
  it("accepts either face", () => {
    expect(isCreature("Creature — Human")).toBe(true);
    expect(isCreature("Sorcery // Creature — Werewolf")).toBe(true);
    expect(isCreature("Artifact")).toBe(false);
  });
});
```

The `Landwalker` case pins the word-boundary behavior that `manaSources.ts`'s `\bland\b` rule already has and the naive `includes("land")` rule does not.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/cardTypes.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/core/cardTypes.ts` with the three predicates, lifting the face-aware `\bland\b` logic from `manaSources.ts:79` as the shared implementation (it is the strictest and the only one that handles both faces and word boundaries). Document why both `isLand` and `isFrontFaceLand` exist:

```ts
/**
 * Whether any face of the card is a land.
 *
 * Type lines join faces with " // ", and a word-boundary match keeps
 * "Landwalker" from reading as a land. Use isFrontFaceLand instead where the
 * question is what the card does when cast rather than what it can become.
 */
```

Then replace all four call sites so they import from here:
- `DeckZone.tsx:93` — its land and creature counts
- `manaSources.ts:79` — delete `isLandSource`'s local rule, import instead
- `deckBuilder.ts:157` — `getColumnKey`'s land placement
- `worth.ts:162` — `isFrontFaceLand`

`getColumnKey` moving from the naive rule to the face-aware one changes where a transforming DFC is filed. That is the point of the task, but it means a saved deck can have such a card under a stale column key. Check `migrateDeckState` in `deckBuilder.ts:89` — if it relocates by recomputing `getColumnKey`, this is handled; if not, note in the commit message that an affected card moves to the lands column on next save, and confirm no test asserts the old placement.

While here, resolve the duplicate `FACE_SEPARATOR`: it is declared in both `manaCost.ts:4` and `manaSources.ts:63`, with the literal `" // "` inline in `cardNames.ts`, `worth.ts` and `ManaSymbols.tsx`. Give it one home and import it everywhere.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/core/cardTypes.test.ts src/core/manaSources.test.ts src/core/deckBuilder.test.ts src/app/components/deck-builder/ && pnpm test:e2e`
Expected: PASS

- [ ] **Step 5: Full gate and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/core/cardTypes.ts src/core/cardTypes.test.ts src/core/manaSources.ts src/core/deckBuilder.ts src/core/db/queries/stats/worth.ts src/app/components/deck-builder/DeckZone.tsx src/core/manaCost.ts src/core/cardNames.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Give the deck builder one definition of a land so its two counts agree

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 15: Correct the comments that contradict the code

Documentation-only, no behavior change. Grouped because each is a one-line edit and none carries its own test.

**Files:**
- Modify: `src/app/api/drafts/[id]/live/route.ts:41-47` and `:124-125`
- Modify: `src/app/components/CardTable.tsx:56`
- Modify: `src/app/components/draft-board/QueuePanel.tsx:162`
- Modify: `scripts/decklists.ts:164,239,673`
- Modify: `scripts/decklists-integrity.ts:7`
- Modify: `src/core/processPick.test.ts:270`
- Modify: `src/app/viewportUnits.test.ts:29`

- [ ] **Step 1: Fix the live-route comments**

`:41` still documents the sig's per-seat marker as `~queueLen:floatCount`. `34c21ea` changed it to `~queueLen:floatCount:autoPick` precisely because the two-field marker let a client act on a stale "auto-pick on" view. The docstring on `getLiveStateSig` was updated and this one was not, so the file that reads most like the contract documents the bug. Correct it to match `picks.ts`.

`:124` says `redactedSeats` is "Deliberately excluded from `getLiveStateSig` — see comment at that call site." No such comment exists at `:41-55`. Either write the justification here in full, or delete the dangling pointer. State the consequence the audit found and nobody had written down: because the field is not in the signature, an opt-out recorded mid-draft does not change the sig, so a polling client keeps short-circuiting and does not see the new `redactedSeats` until some other change lands.

- [ ] **Step 2: Update the Pick Score tooltip**

`CardTable.tsx:56`'s `PICK_EXPLANATION` lists only "Copy weight" and "Unpicked cards". Session recency is a co-equal third factor (`pickScore.ts:51`), and `HowItWorks.tsx:56` was updated while the column tooltip — the most-read explanation of P# — was not. Add the third factor, matching `HowItWorks`'s wording so the two agree. No em dashes.

- [ ] **Step 3: Rewrite the five comments that narrate the change rather than the code**

The project convention forbids comments that only make sense relative to a past change. Each of these buries a real invariant in an incident report — keep the invariant, drop the narrative:

- `QueuePanel.tsx:162` — `Do not "clean this up" to h-11 — that was the earlier version and it grew every row by 14px`. State the constraint: the row height is what keeps the queue from growing past its container.
- `decklists.ts:164` — `…which is how 27 overwrite lines went unread`. State why the skip is logged.
- `decklists.ts:239` — `This overwrite was never the defect — it was the symptom of matching on the wrong card set`. State what the matcher matches on and why.
- `decklists.ts:673` — `Deleting earlier meant a malformed resubmission destroyed a good deck and then declined to write anything`. State the invariant: a seat's deck is replaced atomically, so a malformed submission cannot destroy a stored one.
- `decklists-integrity.ts:7` — `This is the check that would have caught the hidden-zone matching defect the day it landed`. State what the check verifies.

- [ ] **Step 4: Fix the two stale test comments**

- `processPick.test.ts:270` calls pick 24 a "trailing single-pick round"; `trailingSingleRounds` is 0 there, so it is the last double pick of round 5. The assertion is correct and does discriminate the NULL fallback — only the comment is wrong.
- `viewportUnits.test.ts:29` cites `CardTable.tsx:428` for an inline style now at `:444`. Name the symbol instead of the line so it survives the next edit.

- [ ] **Step 5: Verify and commit**

```bash
pnpm precommit
git -C /Users/arpanet/code/read-the-bones add src/app/api/drafts/\[id\]/live/route.ts src/app/components/CardTable.tsx src/app/components/draft-board/QueuePanel.tsx scripts/decklists.ts scripts/decklists-integrity.ts src/core/processPick.test.ts src/app/viewportUnits.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Correct comments that describe behavior the code no longer has

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Not addressed by this plan

Deliberately deferred, with reasoning. Carry these forward rather than treating the audit as fully discharged.

| Finding | Why deferred |
|---|---|
| **C1 enforcement change** (retroactive opt-out unreachable for completed drafts) | User's call: has not happened across 20+ drafts, and will be handled case-by-case if it ever does. Task 9 corrects the documentation instead. |
| **I3** `redactedSeats` excluded from the live signature | Real, but the fix trades a stale display against a per-poll cost on the every-minute path, and Task 15 documents the consequence. Wants its own decision. |
| **I4** worth-table cache not invalidated by match reports or decklist writes | Needs a cache-key design covering writes that move no domain hash, plus a matching client-side gate. `a724ca8` solved exactly this for win stats by memoizing on a `deck_hashes` + `match_events` fingerprint instead of the ingestion hash — copy that shape for `worth.ts` when this is picked up. |
| **I9** `calculateStats` "fail loudly" produces `NaN` rather than an error | Unreachable today by a documented invariant. Worth pinning when the surrounding code is next touched. |
| **I11, I12, I13** decklist script structure (untested `main()`, integrity-checker divergence, duplicated write pipeline) | A coherent refactor of the three scripts, best done as its own piece of work rather than split across tasks here. |
| **I15** float/queue auth gate implemented five times | Mechanical but touches four render paths; sequence it after Task 14 proves the shared-predicate pattern. |
| **I17** test gaps (worth in-flight dedup, CardTable clipping floor, mobile `dvh`) | Additive test work, no production risk while deferred. |
| **Minor findings** (basic-land lists, win/loss SQL fragment, `pollFailed`, naming, `viewportUnits` as a lint rule) | Batch opportunistically. Task 14 removes the `FACE_SEPARATOR` duplicate as a side effect. The `computeIngestionHash` row-order finding is gone — `29032d9` fixed it. |
| **rtb-mcp-server skill** still expects `"[REDACTED]"` in API responses | Different repo; needs a change there, not here. |

---

## Self-review notes

- **Coverage:** every Critical (C1–C8) maps to a task — C1 to Task 9, C2 to Task 2, C3 to Task 1, C4 to Task 7, C5 to Task 6, C6 and C7 to Task 9, C8 to Task 10. Approved Importants map to Tasks 3, 4, 5, 8, 12, 13, 14, 15; the rest are listed above with reasons.
- **Ordering:** Task 3 defines `REDACTED_TABLES` before Task 13 consumes it. Task 6 revives `getLatestPickNumber`, so it must land before anything that would delete it as dead code. Task 14's shared predicate is referenced by the deferred I15 note.
- **Risk:** Task 8 is the only one that changes a user-visible number. Its Step 5 re-runs `pnpm worth:validate` specifically to prove the worth model did not move.
