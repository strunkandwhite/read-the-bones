# Turso Read Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut Turso rows-read from ~100–290M/day to a small fraction of that by fixing the win-stats join shape, memoizing win stats server-side, decoupling them from `/api/cards`, and repairing two CDN cache-key defects.

**Architecture:** Four independent groups of changes. (A) Rewrite two `deck_cards ⋈ match_events` queries whose `OR` join defeats indexing — pre-aggregate match results per `(draft_id, seat)` in a CTE, then drive the join from that small set. (B) Give `getAllCardWinStats` the same module-memo treatment `getWorthTable` already has, keyed on a fingerprint of only the tables win stats depend on. (C) Move win stats off the frequently-refetched `/api/cards` payload onto their own dev-only route, fetched once per fingerprint, mirroring the existing `fetchWorthTable` pattern. (D) Make `computeIngestionHash` order-independent and sort the `drafts` query param so the edge cache stops fragmenting.

**Tech Stack:** Next.js 16 (App Router), TypeScript, `@libsql/client` (Turso), Zustand, Vitest (in-memory libsql integration tests), Playwright.

## Global Constraints

- `pnpm lint` runs with `--max-warnings 0`. Zero warnings allowed.
- `pnpm knip` must pass — no unused files, exports, or dependencies. Any new exported symbol must have a real consumer, or be marked `@public` with a comment naming its consumer (existing convention, e.g. `_resetWorthCache`).
- `pnpm typecheck` must pass (`tsc --noEmit`), strict mode. Avoid `any`.
- Query-layer tests use real in-memory libsql via `createMemDb()` from `src/core/db/__tests__/testDb.ts` — not mocks. Seed helpers available: `insertCard`, `insertDraft`, `insertMatch`, `insertDeckCard`, `insertCubeSnapshot`.
- Win stats and the worth table are **dev-only** (`process.env.NODE_ENV !== "production"`). Nothing in this plan may make either reachable in production.
- Do not change observable win-rate numbers. Query rewrites must be provably equivalent.
- Commit after each task. Conventional-commit prefixes (`fix:`, `feat:`, `perf:`, `refactor:`).
- **Always use `git -C /Users/arpanet/code/read-the-bones <cmd>`.** Never `cd` into the repo in a compound command.

## Measured Baseline (for verification)

From `turso db inspect read-the-bones --queries`, a live 9.2-minute window:

| Rows | Share | Query | Source |
|---|---|---|---|
| 1,018,584 | 54.7% | win stats, unfiltered | `getAllCardWinStats` |
| 432,117 | 23.2% | pick events | `getCards.ts:194` |
| 236,569 | 12.7% | cube cards | `getCards.ts:255` |
| 118,503 | 6.4% | cube pool sizes | `getCards.ts:167` |

`getAllCardWinStats` costs **339,528 rows per execution** (measured by diffing its per-query counter across one run). Target after Task 1: ~20,000.

## File Structure

| File | Change | Responsibility after change |
|---|---|---|
| `src/core/db/queries/winStats.ts` | Modify | Rewritten bulk query + module memo + fingerprint |
| `src/core/db/queries/winStats.test.ts` | Create | Integration tests: equivalence, aggregation, memo |
| `src/core/db/queries/stats/rankedAvailable.ts` | Modify | Rewritten win query (MCP `rank_available_cards` path) |
| `src/core/db/queries/stats/rankedAvailable.test.ts` | Modify | Add win-aggregation regression test |
| `src/app/api/cards/win-stats/route.ts` | Create | Dev-only bulk win-stats endpoint |
| `src/app/api/cards/win-stats/route.test.ts` | Create | 404-in-prod + payload shape |
| `src/app/api/cards/route.ts` | Modify | Drops `includeWinStats` |
| `src/app/api/cards/route.test.ts` | Modify | Drop win-stats assertions |
| `src/core/getCards.ts` | Modify | Drops win-stats param and enrichment |
| `src/app/stores/cardStore.ts` | Modify | `winStats` state, `fetchWinStats()`, merge into `cardStatsMap`, sorted `drafts` param |
| `src/core/db/sync/domains.ts` | Modify | Order-independent `computeIngestionHash` |
| `src/core/db/sync/__tests__/domains.test.ts` | Modify | Add order-independence test |

---

### Task 1: Rewrite the bulk win-stats query

The `JOIN match_events me ON me.draft_id = dc.draft_id AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)` shape forces `SCAN deck_cards` → `SEARCH match_events (draft_id=?)`, reading every match row of the draft for every deck-card row (8,901 × ~38 ≈ 340k). Pre-aggregating match results per `(draft_id, seat)` first lets the planner drive from the ~300-row aggregate and seek `deck_cards` on its full `(draft_id, seat)` key.

The equivalent rewrite has already been verified read-only against the production database: **6,317 rows out, identical md5**. This task reproduces it with tests.

**Files:**
- Modify: `src/core/db/queries/winStats.ts:139-155` (the `db.execute` inside `getAllCardWinStats`)
- Test: `src/core/db/queries/winStats.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getAllCardWinStats(client: Client): Promise<Map<string, BulkWinStatsEntry>>` — signature unchanged. `BulkWinStatsEntry = { win_rate: number; ci: { lower: number; upper: number }; sample_size: number }`.

- [ ] **Step 1: Write the failing test**

Create `src/core/db/queries/winStats.test.ts`:

```typescript
/**
 * Integration tests for getAllCardWinStats against a real in-memory libsql
 * database. The bulk query pre-aggregates match results per (draft_id, seat)
 * so the planner can seek deck_cards on its full key; these tests pin the
 * aggregation semantics that rewrite must preserve.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createMemDb,
  insertCard,
  insertDraft,
  insertDeckCard,
  insertMatch,
} from "../__tests__/testDb";
import { getAllCardWinStats } from "./winStats";

let db: Client;

beforeEach(async () => {
  db = await createMemDb();
});

describe("getAllCardWinStats", () => {
  it("returns an empty map when there is no decklist data", async () => {
    const result = await getAllCardWinStats(db);
    expect(result.size).toBe(0);
  });

  it("sums a seat's wins and losses across all its matches", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // Seat 1 appears as seat1 in one match and seat2 in another.
    await insertMatch(db, "d1", 1, 2, 2, 1); // seat1 wins 2, loses 1
    await insertMatch(db, "d1", 1, 3, 0, 2); // seat1 wins 0, loses 2
    await insertMatch(db, "d1", 2, 3, 2, 0); // does not involve seat 1

    const result = await getAllCardWinStats(db);
    const bolt = result.get("bolt");
    expect(bolt).toBeDefined();
    // 2 wins vs 3 losses -> 0.4
    expect(bolt!.win_rate).toBe(0.4);
    expect(bolt!.sample_size).toBe(1);
  });

  it("counts one sample per (draft, seat) that maindecked the card", async () => {
    await insertDraft(db, "d1");
    await insertDraft(db, "d2");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertDeckCard(db, "d1", 2, 1, "deck");
    await insertDeckCard(db, "d2", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 0);
    await insertMatch(db, "d2", 1, 2, 1, 1);

    const result = await getAllCardWinStats(db);
    // d1 seat1, d1 seat2, d2 seat1 = 3 samples.
    expect(result.get("bolt")!.sample_size).toBe(3);
    // wins 2+0+1 = 3, losses 0+2+1 = 3 -> 0.5
    expect(result.get("bolt")!.win_rate).toBe(0.5);
  });

  it("ignores sideboard cards", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "sideboard");
    await insertMatch(db, "d1", 1, 2, 2, 0);

    const result = await getAllCardWinStats(db);
    expect(result.has("bolt")).toBe(false);
  });

  it("excludes seats with no match data", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // No matches at all.

    const result = await getAllCardWinStats(db);
    expect(result.has("bolt")).toBe(false);
  });

  it("aggregates two cards independently", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertCard(db, 2, "Counterspell");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertDeckCard(db, "d1", 2, 2, "deck");
    await insertMatch(db, "d1", 1, 2, 3, 1);

    const result = await getAllCardWinStats(db);
    expect(result.get("bolt")!.win_rate).toBe(0.75);
    expect(result.get("counterspell")!.win_rate).toBe(0.25);
  });
});
```

- [ ] **Step 2: Run the test to see it pass against the CURRENT query**

Run: `pnpm vitest run src/core/db/queries/winStats.test.ts`
Expected: PASS. These tests characterise existing behaviour — they must pass **before** the rewrite so they can prove the rewrite is equivalent. If any fail now, stop and reconcile the expectation with the current implementation before continuing.

- [ ] **Step 3: Commit the characterisation tests**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/winStats.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "test: characterise getAllCardWinStats aggregation before rewrite"
```

- [ ] **Step 4: Rewrite the query**

In `src/core/db/queries/winStats.ts`, replace the `db.execute({...})` call inside `getAllCardWinStats` (the SQL only — leave the JS aggregation loop below it untouched) with:

```typescript
  const result = await db.execute({
    // Pre-aggregating match results per (draft_id, seat) is what makes this
    // affordable. Joining deck_cards directly to match_events needs
    // `(me.seat1 = dc.seat OR me.seat2 = dc.seat)`, which no index can serve:
    // the planner scans deck_cards and re-reads every match row of the draft
    // for each one. Folding the two seat columns into one via UNION ALL first
    // yields ~one row per drafted seat, which the planner then drives the join
    // from, seeking deck_cards on its full (draft_id, seat) key.
    sql: `WITH seat_totals AS (
            SELECT draft_id, seat, SUM(w) AS game_wins, SUM(l) AS game_losses
            FROM (
              SELECT draft_id, seat1 AS seat, seat1_wins AS w, seat2_wins AS l FROM match_events
              UNION ALL
              SELECT draft_id, seat2 AS seat, seat2_wins AS w, seat1_wins AS l FROM match_events
            )
            GROUP BY draft_id, seat
          )
          SELECT c.name AS card_name,
                 dc.draft_id,
                 dc.seat,
                 st.game_wins,
                 st.game_losses
          FROM deck_cards dc
          JOIN seat_totals st ON st.draft_id = dc.draft_id AND st.seat = dc.seat
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck'`,
    args: [],
  });
```

- [ ] **Step 5: Run the tests to verify equivalence**

Run: `pnpm vitest run src/core/db/queries/winStats.test.ts`
Expected: PASS — all six tests, unchanged from Step 2.

- [ ] **Step 6: Verify the plan flipped**

Run:

```bash
turso db shell read-the-bones "EXPLAIN QUERY PLAN WITH seat_totals AS (SELECT draft_id, seat, SUM(w) AS game_wins, SUM(l) AS game_losses FROM (SELECT draft_id, seat1 AS seat, seat1_wins AS w, seat2_wins AS l FROM match_events UNION ALL SELECT draft_id, seat2 AS seat, seat2_wins AS w, seat1_wins AS l FROM match_events) GROUP BY draft_id, seat) SELECT c.name AS card_name, dc.draft_id, dc.seat, st.game_wins, st.game_losses FROM deck_cards dc JOIN seat_totals st ON st.draft_id = dc.draft_id AND st.seat = dc.seat JOIN cards c ON dc.card_id = c.card_id WHERE dc.zone = 'deck'"
```

Expected: contains `SEARCH dc USING COVERING INDEX sqlite_autoindex_deck_cards_1 (draft_id=? AND seat=?)`. It must **not** contain `SCAN dc`. If it still scans `dc`, the rewrite did not achieve its purpose — stop and investigate.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/winStats.ts
git -C /Users/arpanet/code/read-the-bones commit -m "perf: pre-aggregate seat match totals in bulk win-stats query

The OR join against match_events could not use an index, so the query
read every match row of a draft once per deck-card row: ~340k rows read
per call from a 9k-row table. Folding the seat columns into one via
UNION ALL first lets the planner drive from the aggregate."
```

---

### Task 2: Rewrite the ranked-available win query

`rankedAvailable.ts` carries the same `OR` join. It backs `/api/drafts/[id]/available/ranked`, which is the MCP `rank_available_cards` tool — called repeatedly during a live draft, where latency is felt directly. Measured at 1,862,226 rows in the sampled window.

This query filters on `dc.card_id IN (...)` rather than by draft, so the rewrite keeps that filter on `deck_cards` and joins the aggregate to it.

**Files:**
- Modify: `src/core/db/queries/stats/rankedAvailable.ts:308-322` (the second `client.execute` in the "Step 4: Batch play/win stats" `Promise.all`)
- Test: `src/core/db/queries/stats/rankedAvailable.test.ts` (modify — file already exists)

**Interfaces:**
- Consumes: nothing from Task 1 (independent file).
- Produces: no signature change. The query must keep returning rows shaped `{ card_id, draft_id, seat, game_wins, game_losses }`, one per `(card_id, draft_id, seat)`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/db/queries/stats/rankedAvailable.test.ts`. The file already imports `createMemDb`, `insertCard` and `insertDraft` from `../../__tests__/testDb` — **add `insertDeckCard` and `insertMatch` to that existing import list**, then append this `describe` block:

```typescript
describe("ranked available win aggregation", () => {
  it("sums each seat's wins and losses across all of that seat's matches", async () => {
    const db = await createMemDb();
    await insertDraft(db, "d1", { phase: "complete" });
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // Seat 1 is seat1 in one match and seat2 in the other.
    await insertMatch(db, "d1", 1, 2, 2, 1);
    await insertMatch(db, "d1", 3, 1, 1, 2);

    const rows = await db.execute({
      sql: `WITH seat_totals AS (
              SELECT draft_id, seat, SUM(w) AS game_wins, SUM(l) AS game_losses
              FROM (
                SELECT draft_id, seat1 AS seat, seat1_wins AS w, seat2_wins AS l FROM match_events
                UNION ALL
                SELECT draft_id, seat2 AS seat, seat2_wins AS w, seat1_wins AS l FROM match_events
              )
              GROUP BY draft_id, seat
            )
            SELECT dc.card_id, dc.draft_id, dc.seat, st.game_wins, st.game_losses
            FROM deck_cards dc
            JOIN seat_totals st ON st.draft_id = dc.draft_id AND st.seat = dc.seat
            WHERE dc.card_id IN (?) AND dc.zone = 'deck'`,
      args: [1],
    });

    expect(rows.rows).toHaveLength(1);
    // seat 1: wins 2 + 2 = 4, losses 1 + 1 = 2
    expect(rows.rows[0].game_wins).toBe(4);
    expect(rows.rows[0].game_losses).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm vitest run src/core/db/queries/stats/rankedAvailable.test.ts`
Expected: PASS. This pins the aggregate semantics independently of the production call site.

- [ ] **Step 3: Apply the rewrite to the production query**

In `src/core/db/queries/stats/rankedAvailable.ts`, replace the second `client.execute` inside the `Promise.all` at "Step 4: Batch play/win stats" with:

```typescript
    client.execute({
      // See getAllCardWinStats for why the seat totals are pre-aggregated:
      // the direct `(me.seat1 = dc.seat OR me.seat2 = dc.seat)` join cannot
      // use an index and re-reads a draft's whole match set per deck-card row.
      sql: `WITH seat_totals AS (
              SELECT draft_id, seat, SUM(w) AS game_wins, SUM(l) AS game_losses
              FROM (
                SELECT draft_id, seat1 AS seat, seat1_wins AS w, seat2_wins AS l FROM match_events
                UNION ALL
                SELECT draft_id, seat2 AS seat, seat2_wins AS w, seat1_wins AS l FROM match_events
              )
              GROUP BY draft_id, seat
            )
            SELECT dc.card_id, dc.draft_id, dc.seat, st.game_wins, st.game_losses
            FROM deck_cards dc
            JOIN seat_totals st ON st.draft_id = dc.draft_id AND st.seat = dc.seat
            WHERE dc.card_id IN (${idPlaceholderStr}) AND dc.zone = 'deck'`,
      args: cardIds,
    }),
```

Note: `GROUP BY dc.card_id, dc.draft_id, dc.seat` is dropped because `seat_totals` is already one row per `(draft_id, seat)`, making the result one row per `(card_id, draft_id, seat)` without aggregation. The consuming code below is unchanged.

- [ ] **Step 4: Run the full rankedAvailable suite**

Run: `pnpm vitest run src/core/db/queries/stats/rankedAvailable.test.ts`
Expected: PASS, including all pre-existing tests. Pre-existing tests exercise the consuming code against real data, so a semantic regression here would surface as a win-rate assertion failure.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/rankedAvailable.ts src/core/db/queries/stats/rankedAvailable.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "perf: pre-aggregate seat match totals in ranked-available win query"
```

---

### Task 3: Memoize bulk win stats on a decks+matches fingerprint

`getWorthTable` already memoizes on a cheap fingerprint; `getAllCardWinStats` has no cache at all, so every `/api/cards` call recomputes it. This task adds the same treatment.

**Key design point:** the fingerprint must **not** be the full `ingestionHash`. That includes `picks_hash`, which changes on every pick — it would invalidate constantly during a live draft, exactly the churn this is meant to stop. Win stats depend only on `deck_cards`, `match_events`, and `cards.name`. So the fingerprint reads `deck_hashes` (the per-seat decklist content hash, ~200 rows) plus an aggregate of `match_events` (~1,134 rows). A full `COUNT(*)` on `deck_cards` was rejected: it is an 8,901-row scan, which would undo much of the saving.

`match_events` is fingerprinted by count and both win-column sums rather than a stored hash, because live drafts write it via `reportMatchResult` (`matches.ts:166`, `INSERT OR REPLACE`) which never updates `drafts.matches_hash` — that column is only maintained on the Sheets sync path.

Known limitation to document in the code: `scripts/merge-dfc-cards.ts:116` deletes `deck_cards` rows without touching `deck_hashes`, so it will not invalidate this memo. It is a rare manual maintenance script and this is a dev-only display metric; restarting the dev server clears the memo.

**Files:**
- Modify: `src/core/db/queries/winStats.ts` (add fingerprint query + memo around `getAllCardWinStats`)
- Test: `src/core/db/queries/winStats.test.ts` (add memo tests)

**Interfaces:**
- Consumes: `getAllCardWinStats(client)` from Task 1 — unchanged signature.
- Produces: `_resetWinStatsCache(): void` — test hook, exported, mirroring `_resetWorthCache` in `stats/worth.ts:64`. Marked `@public` for knip.

- [ ] **Step 1: Write the failing test**

Append to `src/core/db/queries/winStats.test.ts`. Also add `_resetWinStatsCache` to the import from `./winStats`, and add a `beforeEach` reset so the memo cannot leak between the tests written in Task 1:

```typescript
// Add to the existing beforeEach in this file:
//   beforeEach(async () => { db = await createMemDb(); _resetWinStatsCache(); });

describe("getAllCardWinStats memoization", () => {
  it("serves a repeat call from the memo without re-running the bulk query", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 0);

    const first = await getAllCardWinStats(db);
    const second = await getAllCardWinStats(db);
    // Same object identity proves the second call did not recompute.
    expect(second).toBe(first);
  });

  it("recomputes when a match result is added", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 0);

    const first = await getAllCardWinStats(db);
    expect(first.get("bolt")!.win_rate).toBe(1);

    await insertMatch(db, "d1", 1, 3, 0, 2);
    const second = await getAllCardWinStats(db);
    expect(second).not.toBe(first);
    expect(second.get("bolt")!.win_rate).toBe(0.5);
  });

  it("recomputes when a match score is corrected in place", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const first = await getAllCardWinStats(db);
    expect(first.get("bolt")!.win_rate).toBeCloseTo(0.667, 3);

    // Same pairing, scores swapped — count is unchanged, so the fingerprint
    // must be catching the per-column sums.
    await db.execute({
      sql: `UPDATE match_events SET seat1_wins = 1, seat2_wins = 2
            WHERE draft_id = 'd1' AND seat1 = 1 AND seat2 = 2`,
      args: [],
    });
    const second = await getAllCardWinStats(db);
    expect(second.get("bolt")!.win_rate).toBeCloseTo(0.333, 3);
  });

  it("recomputes when a decklist hash changes", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertCard(db, 2, "Counterspell");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 0);
    await db.execute({
      sql: `INSERT INTO deck_hashes (draft_id, seat, hash) VALUES ('d1', 1, 'h1')`,
      args: [],
    });

    const first = await getAllCardWinStats(db);
    expect(first.has("counterspell")).toBe(false);

    await insertDeckCard(db, "d1", 1, 2, "deck");
    await db.execute({
      sql: `UPDATE deck_hashes SET hash = 'h2' WHERE draft_id = 'd1' AND seat = 1`,
      args: [],
    });
    const second = await getAllCardWinStats(db);
    expect(second.has("counterspell")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/core/db/queries/winStats.test.ts`
Expected: FAIL — `_resetWinStatsCache` is not exported (import error), and the identity test would fail regardless since every call currently builds a fresh Map.

- [ ] **Step 3: Implement the fingerprint and memo**

In `src/core/db/queries/winStats.ts`, add above `getAllCardWinStats`:

```typescript
// Module-level memo for the bulk win-stats table. Deliberately NOT keyed on
// the ingestion hash: that includes picks_hash, which changes on every pick,
// and win stats do not depend on picks at all. They depend only on
// deck_cards, match_events and card names — so the key below reads
// deck_hashes (the per-seat decklist content hash) and an aggregate of
// match_events.
//
// match_events is fingerprinted by count plus both win-column sums rather
// than drafts.matches_hash, because live drafts write it through
// reportMatchResult, which never updates that column — only the Sheets sync
// path maintains it. Count alone would miss an in-place score correction.
//
// Known gap: scripts/merge-dfc-cards.ts deletes deck_cards rows without
// touching deck_hashes, so it will not invalidate this memo. That is a rare
// manual maintenance script and this is a dev-only metric; restarting the
// dev server clears it.
let winStatsCache: { key: string; result: Map<string, BulkWinStatsEntry> } | null = null;
let winStatsPending: { key: string; promise: Promise<Map<string, BulkWinStatsEntry>> } | null = null;

/** @public Test hook: clears the module-level bulk win-stats memo. */
export function _resetWinStatsCache(): void {
  winStatsCache = null;
  winStatsPending = null;
}

async function computeWinStatsFingerprint(client: Client): Promise<string> {
  const [decks, matches] = await Promise.all([
    client.execute({
      sql: `SELECT draft_id, seat, hash FROM deck_hashes ORDER BY draft_id, seat`,
      args: [],
    }),
    client.execute({
      sql: `SELECT COUNT(*) AS n,
                   COALESCE(SUM(seat1_wins), 0) AS w1,
                   COALESCE(SUM(seat2_wins), 0) AS w2
            FROM match_events`,
      args: [],
    }),
  ]);
  const decksPart = decks.rows
    .map((r) => `${r.draft_id}:${r.seat}:${r.hash}`)
    .join(",");
  const m = matches.rows[0];
  return `${decksPart}|${m?.n ?? 0}:${m?.w1 ?? 0}:${m?.w2 ?? 0}`;
}
```

Then rename the existing function body to a private worker and wrap it. Change the existing `export async function getAllCardWinStats(` declaration to:

```typescript
async function computeAllCardWinStats(
```

and add, immediately after that function's closing brace:

```typescript
/**
 * Get win stats for all cards at once, memoized on a fingerprint of the only
 * tables the result depends on. Concurrent cold callers share one in-flight
 * computation (the UI fetch and the MCP tool typically race on dev-server start).
 */
export async function getAllCardWinStats(
  client: Client,
): Promise<Map<string, BulkWinStatsEntry>> {
  const key = await computeWinStatsFingerprint(client);
  if (winStatsCache?.key === key) return winStatsCache.result;
  if (winStatsPending?.key === key) return winStatsPending.promise;

  const assembly = computeAllCardWinStats(client);
  winStatsPending = { key, promise: assembly };
  try {
    const result = await assembly;
    winStatsCache = { key, result };
    return result;
  } finally {
    winStatsPending = null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/core/db/queries/winStats.test.ts`
Expected: PASS — all Task 1 tests plus the four memo tests.

- [ ] **Step 5: Run typecheck, lint and knip**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: all pass. If knip flags `_resetWinStatsCache`, confirm the `@public` comment is present in the exact form used by `_resetWorthCache` in `stats/worth.ts:63`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/winStats.ts src/core/db/queries/winStats.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "perf: memoize bulk win stats on a decks+matches fingerprint

Keyed on deck_hashes plus a match_events aggregate rather than the
ingestion hash, which includes picks_hash and would invalidate on every
pick during a live draft."
```

---

### Task 4: Add the dev-only bulk win-stats route

Mirrors `/api/cards/worth` exactly: 404 in production, no cache-control header (the query layer memoizes).

**Files:**
- Create: `src/app/api/cards/win-stats/route.ts`
- Test: `src/app/api/cards/win-stats/route.test.ts`

**Interfaces:**
- Consumes: `getAllCardWinStats(client)` from Task 3.
- Produces: `GET /api/cards/win-stats` returning `{ cards: Record<string, { win_rate: number; ci: { lower: number; upper: number }; sample_size: number }> }`. Keys are `cardNameKey`-normalised names (lowercase), matching the Map keys `getAllCardWinStats` returns. Task 5 consumes this shape.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/cards/win-stats/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(async () => ({}) as never),
}));

const getAllCardWinStats = vi.fn();
vi.mock("@/core/db/queries", () => ({
  getAllCardWinStats: (...args: unknown[]) => getAllCardWinStats(...args),
}));

const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.resetModules();
  getAllCardWinStats.mockReset();
});

afterEach(() => {
  vi.stubEnv("NODE_ENV", ORIGINAL_ENV ?? "test");
});

describe("GET /api/cards/win-stats", () => {
  it("returns 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(404);
    expect(getAllCardWinStats).not.toHaveBeenCalled();
  });

  it("returns the bulk map as a plain object outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    getAllCardWinStats.mockResolvedValue(
      new Map([
        ["bolt", { win_rate: 0.6, ci: { lower: 0.4, upper: 0.8 }, sample_size: 12 }],
      ]),
    );
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards.bolt).toEqual({
      win_rate: 0.6,
      ci: { lower: 0.4, upper: 0.8 },
      sample_size: 12,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/cards/win-stats/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Create the route**

Create `src/app/api/cards/win-stats/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getAllCardWinStats } from "@/core/db/queries";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

// Decklist win rates are dev-only tooling and disabled in production.
// Using an env check rather than trusting the client-supplied Host header, which
// can be spoofed and also appears in server/CDN logs when used for auth decisions.
const WIN_STATS_ENABLED = process.env.NODE_ENV !== "production";

export const GET = withApiErrors(async () => {
  if (!WIN_STATS_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const client = await getClient();
  const stats = await getAllCardWinStats(client);

  // No cache-control header: dev-only, always fresh (the query layer memoizes).
  return NextResponse.json({ cards: Object.fromEntries(stats) });
}, "[/api/cards/win-stats] Error:");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/app/api/cards/win-stats/route.test.ts`
Expected: PASS, both cases.

Note: `src/core/db/queries/index.ts` already contains `export * from "./winStats";`, so the barrel import above resolves without further change.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/api/cards/win-stats/
git -C /Users/arpanet/code/read-the-bones commit -m "feat: add dev-only /api/cards/win-stats route"
```

---

### Task 5: Fetch win stats from the store and merge them client-side

Adds `winStats` state plus `fetchWinStats()` to `cardStore`, mirroring `worthCards` / `fetchWorthTable`. The fetched entries are merged into `cachedCardStatsMap` during `recompute()`, so every existing consumer (`DeckColumn.tsx:94` reads `stats?.gpwr`) keeps working with no prop changes.

**Files:**
- Modify: `src/app/stores/cardStore.ts`

**Interfaces:**
- Consumes: `GET /api/cards/win-stats` from Task 4 — `{ cards: Record<string, { win_rate, ci: { lower, upper }, sample_size }> }`.
- Produces: `useCardStore` gains `winStats: Map<string, BulkWinStatsEntry>` and `fetchWinStats(): Promise<void>`. `cardStatsMap` entries gain `gpwr` / `gpwrCi` / `gpwrSampleSize` on localhost. Task 6 relies on this being in place before removing the server-side enrichment.

- [ ] **Step 1: Add the module-scoped fetch marker**

In `src/app/stores/cardStore.ts`, immediately after the `worthFetchedForHash` declaration (line 84), add:

```typescript
// Module-scoped cache marker for /api/cards/win-stats (dev-only route), and
// the reference used to decide whether recompute() must rebuild the card-stats
// map. Same shape as worthFetchedForHash.
let winStatsFetchedForHash: string | null = null;
let lastWinStatsRef: Map<string, BulkWinStatsEntry> | null = null;
```

Add to the `_resetSearchState()` body (after line 99):

```typescript
  winStatsFetchedForHash = null;
  lastWinStatsRef = null;
```

Add the type import at the top of the file, alongside the other `@/core` type imports:

```typescript
import type { BulkWinStatsEntry } from "@/core/db/queries/winStats";
```

- [ ] **Step 2: Add state and action to the store interface**

In the store's state interface, next to `worthCards: Map<string, WorthCard>;` (line 179), add:

```typescript
  // Bulk decklist win rates (dev-only; populated from /api/cards/win-stats on
  // localhost). Merged into cardStatsMap by recompute() rather than delivered
  // inline on /api/cards, which refetches on every pick.
  winStats: Map<string, BulkWinStatsEntry>;
```

In the store's initial state, next to `worthCards: new Map(),` (line 367), add:

```typescript
    winStats: new Map(),
```

- [ ] **Step 3: Merge win stats in recompute()**

Replace the map-rebuild guard in `recompute()` (lines 211-220) with:

```typescript
  // Rebuild maps when either input reference changes. Win stats arrive on a
  // separate, much less frequent request than cardData, so both are guards.
  const { winStats } = state;
  if (cardData !== lastCardDataRef || winStats !== lastWinStatsRef) {
    lastCardDataRef = cardData;
    lastWinStatsRef = winStats;
    cachedScryfallDataMap = new Map<string, ScryCard>();
    cachedCardStatsMap = new Map<string, EnrichedCardStats>();
    for (const card of cardData.cards) {
      if (card.scryfall) cachedScryfallDataMap.set(card.cardName, card.scryfall);
      const ws = winStats.get(cardNameKey(card.cardName));
      cachedCardStatsMap.set(
        card.cardName,
        ws
          ? {
              ...card,
              gpwr: ws.win_rate,
              gpwrCi: ws.ci,
              gpwrSampleSize: ws.sample_size,
            }
          : card,
      );
    }
  }
```

`cardNameKey` is **not** currently imported in this file. Line 11 reads `import { getFrontFace } from "@/core/cardNames";` — change it to:

```typescript
import { cardNameKey, getFrontFace } from "@/core/cardNames";
```

The key normalisation must match the server's: `getAllCardWinStats` keys its Map by `cardNameKey(cardName)` (`winStats.ts`, in the aggregation loop), so the lookup here must use the same function rather than the raw card name.

- [ ] **Step 4: Add fetchWinStats**

In `src/app/stores/cardStore.ts`, immediately after the `fetchWorthTable` action's closing `},`, add:

```typescript
    fetchWinStats: async () => {
      // Dev-only: /api/cards/win-stats 404s in production builds, so production
      // clients must never request it.
      if (!isLocalClient()) return;

      const currentHash = get().cardData.ingestionHash;
      if (winStatsFetchedForHash === currentHash) return;
      // Mark before awaiting so overlapping triggers don't double-fetch.
      winStatsFetchedForHash = currentHash;

      try {
        const res = await fetch("/api/cards/win-stats");
        if (!res.ok) throw new Error(`Win stats fetch failed: ${res.status}`);
        const data = (await res.json()) as {
          cards: Record<string, BulkWinStatsEntry>;
        };
        // A newer hash may have started its own fetch while this one was in
        // flight; only the fetch that still owns the marker may write.
        if (winStatsFetchedForHash !== currentHash) return;
        set({ winStats: new Map(Object.entries(data.cards)) });
        recompute();
      } catch {
        // Swallow: the dev server may still be compiling the route. Empty
        // state hides the GPWR values; clearing the marker lets the next
        // ingestionHash trigger retry.
        if (winStatsFetchedForHash !== currentHash) return;
        winStatsFetchedForHash = null;
        set({ winStats: new Map() });
        recompute();
      }
    },
```

Declare `fetchWinStats: () => Promise<void>;` in the store's actions interface next to `fetchWorthTable`.

- [ ] **Step 5: Subscribe on ingestion-hash change**

Immediately after the existing worth-table subscription (lines 626-629), add:

```typescript
// Bulk win stats (dev-only): same trigger as the worth table — refetch
// whenever the committed card data's ingestionHash changes. fetchWinStats
// no-ops off localhost and when the hash is one it already fetched for.
useCardStore.subscribe(
  (state) => state.cardData.ingestionHash,
  () => void useCardStore.getState().fetchWinStats(),
);
```

- [ ] **Step 6: Verify typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Run the store test suite**

Run: `pnpm vitest run src/app/stores/`
Expected: PASS. If a test snapshots the store's initial state, add `winStats: new Map()` to the expectation.

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/stores/cardStore.ts
git -C /Users/arpanet/code/read-the-bones commit -m "feat: fetch bulk win stats separately and merge them client-side

Mirrors the existing worth-table pattern: fetched once per ingestion hash
on localhost, merged into cardStatsMap by recompute() so existing gpwr
consumers are unchanged."
```

---

### Task 6: Remove win stats from /api/cards

With Task 5 in place the client no longer needs win stats inline. Removing them means `/api/cards` — refetched on every pick, sync and selection change — stops carrying a 340k-row (now ~20k-row) query and a larger payload.

**Files:**
- Modify: `src/core/getCards.ts` (remove `includeWinStats` param, the win-stats call, and the enrichment)
- Modify: `src/app/api/cards/route.ts` (remove the gate and the param)
- Modify: `src/app/api/cards/route.test.ts` (drop win-stats assertions)

**Interfaces:**
- Consumes: Task 5's client-side merge must already be committed.
- Produces: `GetCardsParams` loses `includeWinStats`. `assembleCardStats` loses its `winStats` parameter. `EnrichedCardStats.gpwr` / `gpwrCi` / `gpwrSampleSize` stay declared on the type — they are now populated client-side.

- [ ] **Step 1: Check what the route test asserts**

Run:

```bash
grep -n "includeWinStats\|gpwr\|WIN_STATS" /Users/arpanet/code/read-the-bones/src/app/api/cards/route.test.ts
```

Note every line — each one must be removed or adjusted in Step 4.

- [ ] **Step 2: Remove from getCards.ts**

In `src/core/getCards.ts`:

1. Delete the import of `getAllCardWinStats` (line 23), keeping the `BulkWinStatsEntry` type import only if still referenced — it will not be, so delete the whole line:

```typescript
import { getAllCardWinStats, type BulkWinStatsEntry } from "./db/queries/winStats";
```

2. Delete the `includeWinStats` field and its doc comment from `GetCardsParams` (around line 60):

```typescript
  /** Include GPWR win stats (localhost only) */
  includeWinStats?: boolean;
```

3. Delete the win-stats fetch (lines 556-559):

```typescript
  // 7. Optionally fetch bulk win stats (localhost only)
  const winStats = params.includeWinStats
    ? await getAllCardWinStats(client)
    : undefined;
```

4. Remove the `winStats,` argument from the `assembleCardStats(...)` call below it.

5. In `assembleCardStats` (line 420), delete the `winStats?: Map<string, BulkWinStatsEntry>,` parameter, and in its `stats.map` body delete the `const ws = winStats?.get(key);` line and the spread that follows:

```typescript
      ...(ws && {
        gpwr: ws.win_rate,
        gpwrCi: ws.ci,
        gpwrSampleSize: ws.sample_size,
      }),
```

6. Renumber the surrounding step comments only if they read as a broken sequence; leaving them is acceptable.

- [ ] **Step 3: Remove from the route**

In `src/app/api/cards/route.ts`, delete the `WIN_STATS_ENABLED` constant and its three-line comment (lines 4-7), and delete `includeWinStats: WIN_STATS_ENABLED,` from the `getCards({...})` call.

- [ ] **Step 4: Update the route test**

Remove the lines identified in Step 1. If a whole test case exists solely to assert win-stats gating, delete that case — the equivalent coverage now lives in `src/app/api/cards/win-stats/route.test.ts`.

- [ ] **Step 5: Run the affected suites**

Run: `pnpm vitest run src/app/api/cards/ src/core/`
Expected: PASS.

- [ ] **Step 6: Run typecheck, lint and knip**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: all pass. knip may now flag `BulkWinStatsEntry` if nothing imports it — Task 5 imports it in `cardStore.ts`, so it should stay live. If knip flags anything, resolve it rather than suppressing.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/getCards.ts src/app/api/cards/route.ts src/app/api/cards/route.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "perf: stop bundling win stats into /api/cards

/api/cards refetches on every pick, sync and selection change; win rates
change only when decklists or match results do. They now come from
/api/cards/win-stats, fetched once per ingestion hash."
```

---

### Task 7: Make computeIngestionHash order-independent

`computeIngestionHash` joins rows positionally, and its five call sites disagree on ordering: `getCards.ts:89` uses `ORDER BY d.draft_date DESC`, `lock.ts:66` has no `ORDER BY`. Same data, different hash — verified live as `282a68d057989c6d` vs `a31cad07be1ca281`. The client uses the `lock.ts` value as the `?v=` cache-buster while the SSR payload carries the `getCards` value, so a fresh client mints at least two cache keys per session.

Fixing it inside the function rather than adding `ORDER BY` to five call sites makes future divergence structurally impossible.

**Files:**
- Modify: `src/core/db/sync/domains.ts:33-40`
- Test: `src/core/db/sync/__tests__/domains.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `computeIngestionHash(rows)` — same signature, now returns the same value for any permutation of `rows`.

- [ ] **Step 1: Write the failing test**

Append to `src/core/db/sync/__tests__/domains.test.ts` (add `computeIngestionHash` to the existing import from `../domains` if not already imported):

```typescript
describe("computeIngestionHash", () => {
  const rows = [
    { pool_hash: "p1", picks_hash: "k1", matches_hash: "m1" },
    { pool_hash: "p2", picks_hash: "k2", matches_hash: "m2" },
    { pool_hash: "p3", picks_hash: null, matches_hash: null },
  ];

  it("is independent of row order", () => {
    const forward = computeIngestionHash(rows);
    const reversed = computeIngestionHash([...rows].reverse());
    const shuffled = computeIngestionHash([rows[1], rows[2], rows[0]]);
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("still changes when a hash value changes", () => {
    const before = computeIngestionHash(rows);
    const after = computeIngestionHash([
      { pool_hash: "p1", picks_hash: "CHANGED", matches_hash: "m1" },
      rows[1],
      rows[2],
    ]);
    expect(after).not.toBe(before);
  });

  it("treats null and empty string identically, as before", () => {
    expect(computeIngestionHash([{ pool_hash: null, picks_hash: null, matches_hash: null }]))
      .toBe(computeIngestionHash([{ pool_hash: "", picks_hash: "", matches_hash: "" }]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/core/db/sync/__tests__/domains.test.ts`
Expected: FAIL on "is independent of row order" — the reversed and shuffled hashes differ.

- [ ] **Step 3: Implement**

Replace `computeIngestionHash` in `src/core/db/sync/domains.ts`:

```typescript
/**
 * Fingerprint the per-domain hashes of a set of drafts.
 *
 * Sorted before joining because callers disagree on row order — getCards
 * orders by draft_date, getServerIngestionHash does not order at all — and an
 * order-sensitive hash made them disagree on identical data. The client uses
 * one as the ?v= cache-buster for /api/cards while SSR embeds the other, so
 * the mismatch cost a CDN cache key per session. Sorting here, rather than
 * adding ORDER BY at each call site, means they cannot diverge again.
 *
 * Sorting the mapped strings is a sound canonicalization: the value depends
 * only on the multiset of (pool, picks, matches) triples, which is exactly
 * what "has any draft's synced data changed" should mean.
 */
export function computeIngestionHash(
  rows: Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
): string {
  const combined = rows
    .map((r) => `${r.pool_hash ?? ""}:${r.picks_hash ?? ""}:${r.matches_hash ?? ""}`)
    .sort()
    .join("|");
  return sha256Short(combined);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/core/db/sync/__tests__/domains.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the wider suite**

Run: `pnpm vitest run`
Expected: PASS. Any test asserting a hard-coded ingestion-hash string will now fail — update the expected value to the newly computed one; the change of value is intended and nothing persists it (the `ingestion_meta` table stores only `sync_lock` and `last_synced_at`).

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/sync/domains.ts src/core/db/sync/__tests__/domains.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "fix: make computeIngestionHash independent of row order

getCards ordered by draft_date and getServerIngestionHash not at all, so
identical data produced two different hashes. The client used one as the
/api/cards cache-buster while SSR embedded the other, costing an edge
cache key per session."
```

---

### Task 8: Sort the drafts param and drop the dead `local` param

`[...selectedDrafts].join(",")` serialises a `Set` in insertion order, and `DraftSelector.tsx:42` rebuilds that Set by toggling — so unchecking and rechecking a draft permanently reorders it. Ten clients with ten orderings request ten distinct URLs for identical data, each a 52,000-row cache miss. Sorting makes the URL canonical.

`params.set("local", "1")` is also removed: no route reads `local` (verified by grep across `src/`), so it only ever added a cache key.

**Files:**
- Modify: `src/app/stores/cardStore.ts` (the `fetchCardData` action, around lines 434-448)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `/api/cards` and `/api/draft-stats` receive `drafts` sorted lexicographically.

- [ ] **Step 1: Apply the change**

In `src/app/stores/cardStore.ts`, inside `fetchCardData`, replace the params construction:

```typescript
        // Sorted so the same selection always produces the same URL. The Set's
        // insertion order changes as drafts are toggled, and an unsorted join
        // gave each client its own permanently distinct CDN cache key for
        // identical data — every one a full uncached getCards.
        const draftsParam = [...selectedDrafts].sort().join(",");

        const params = new URLSearchParams();
        params.set("drafts", draftsParam);
        params.set("v", currentHash);
        if (activeDraft) params.set("activeDraft", activeDraft);
        if (effectivePool) params.set("poolAsOfDraft", effectivePool);
```

(The `if (isLocalClient()) params.set("local", "1");` line is deleted.)

And in the `/api/draft-stats` branch immediately below, replace `statsParams.set("drafts", [...selectedDrafts].join(","));` with:

```typescript
                statsParams.set("drafts", draftsParam);
```

- [ ] **Step 2: Verify isLocalClient is still used in this file**

Run:

```bash
grep -n "isLocalClient" /Users/arpanet/code/read-the-bones/src/app/stores/cardStore.ts
```

Expected: still referenced by `fetchWorthTable` and `fetchWinStats`, so the import stays. If it is now unused, remove the import — `pnpm lint` will fail otherwise.

- [ ] **Step 3: Run typecheck, lint and the store suite**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run src/app/stores/`
Expected: PASS. If a store test asserts a request URL containing `local=1` or an unsorted `drafts=` value, update it to the sorted form.

- [ ] **Step 4: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/stores/cardStore.ts
git -C /Users/arpanet/code/read-the-bones commit -m "fix: sort the drafts query param and drop the unread local param

The Set's insertion order changes as drafts are toggled, so each client
requested a distinct /api/cards URL for identical data — every one a
52k-row cache miss. No route reads the local param."
```

---

### Task 9: Full verification

**Files:** none modified.

- [ ] **Step 1: Run the full quality gate**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, unit tests and e2e all pass. E2E requires chromium — if missing, run `npx playwright install chromium` first.

- [ ] **Step 2: Verify the GPWR column still renders in dev**

Start the dev server (`pnpm dev`), open `http://localhost:3000`, and confirm:
- the deck-builder card tiles still show a `GPWR` percentage with its `±` interval (`DeckCard.tsx:146-152`)
- the network tab shows exactly one `/api/cards/win-stats` request on load, and **no further** win-stats requests as picks land

Stop the dev server as soon as the check is done — leaving it running against production Turso is the single largest source of the read volume this plan exists to fix.

- [ ] **Step 3: Confirm production still hides the dev-only routes**

Run:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://read-the-bones.vercel.app/api/cards/win-stats
curl -s -o /dev/null -w '%{http_code}\n' https://read-the-bones.vercel.app/api/cards/worth
```

Expected: `404` for both. (Run after deploying; before deploying, `/api/cards/win-stats` will return 404 simply because it does not exist yet — which is also fine.)

- [ ] **Step 4: Re-measure**

Run: `turso db inspect read-the-bones --queries`

Expected: the `SELECT c.name AS card_name, ...` bulk win-stats entry should stop growing at ~340k per execution. Take two snapshots ~9 minutes apart and compare the delta against the baseline table at the top of this plan.

---

## Self-Review

**Spec coverage:** All four agreed changes are covered — query rewrite (Tasks 1, 2), server-side memo keyed on decks+matches rather than the ingestion hash (Task 3), decoupling win stats from `/api/cards` (Tasks 4–6), and the two cache-key fixes (Tasks 7, 8). The dead `local` param cleanup rides along in Task 8.

**Deliberate exclusions:** `getCardWinStats` (`winStats.ts:34`) carries the same `OR` join but filters on `dc.card_id = ?`, which the `idx_deck_cards_card` index serves — it measured 72,421 rows total (0.1%) in the sampled window. Rewriting it would add risk for no measured benefit. Pointing local dev at a database copy is the largest single lever but is an operational change, not a code change, so it is out of scope here; Task 9 Step 2 flags it.

**Type consistency:** `BulkWinStatsEntry` is used with the same shape in Tasks 3, 4 and 5. `_resetWinStatsCache` matches the `_resetWorthCache` convention. The route payload key (`cards`) and its `Record<string, BulkWinStatsEntry>` value type are consistent between Task 4's producer and Task 5's consumer. `getAllCardWinStats` keeps its exported signature across Tasks 1, 3 and 4; only the private worker `computeAllCardWinStats` is new.

**Ordering dependency:** Task 5 must land before Task 6, or GPWR disappears from the dev UI in between. Tasks 1–3, 7 and 8 are independent of each other.
