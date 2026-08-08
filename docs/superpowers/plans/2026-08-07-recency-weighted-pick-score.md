# Recency-Weighted Pick Score — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the four divergent pick-score implementations into one canonical formula, then weight recent drafting sessions more heavily so P# tracks how the community values cards now rather than averaging ten months of drifting opinion.

**Architecture:** A new `src/core/pickScore.ts` owns the whole formula and exposes a single entry point, `pickScore(observations)`. The four call sites keep their legitimately-different data loading and are reduced to building `DraftObservation[]`. Recency is a third weight factor, `0.5^(sessionsAgo / 4)`, where a *session* is a distinct `draft_date` — parallel pods on one date are one session, because what moves card evaluations is drafting and playing, not the calendar. Phase A lands consolidation alone so the resulting number changes are attributable; Phase B adds decay on top.

**Tech Stack:** TypeScript (strict), Next.js App Router, Turso/libSQL (`@libsql/client`), Vitest, Playwright.

## Global Constraints

- Repo root: `/Users/arpanet/code/read-the-bones`. **Every git command uses `git -C /Users/arpanet/code/read-the-bones …` — never `cd … && git …`.**
- Commit co-author line (exact): `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Commit messages explain *why*, not *what*; 1–2 sentences.
- Quality gates: `pnpm typecheck`, `pnpm lint` (zero warnings), `pnpm knip` (zero unused exports), `pnpm test`. **`pnpm lint` must pass before every commit, with no exceptions.**
- **`typecheck`, `knip` and `test` have declared exceptions during Phase B, because this plan deliberately lands a shared module before its consumers.**
  - **Task 1** — `knip` flags `pickScore` as unused until Task 2 consumes it. Skip `knip` for this commit only.
  - **Task 9** — making `DraftObservation.sessionsAgo` *required* is what makes the compiler locate the four call sites, so `typecheck` fails there by design. Skip `typecheck` for this commit.
  - **Tasks 10-12** — `typecheck` still fails in the call sites not yet migrated.

  **The runtime consequence, which is easy to miss:** an un-migrated call site passes `sessionsAgo: undefined` at runtime, and `Math.pow(0.5, undefined / 4)` is `NaN`, which propagates through the whole score. So `pnpm test` is also red during this window — this is not optional breakage a task can avoid. Measured after Task 11: **17 failures across 4 files**, and they map exactly onto the two remaining sites:

  | failing file | tests | fixed by |
  |---|---|---|
  | `src/core/calculateStats.test.ts` | 13 | Task 13 |
  | `src/core/getCards.test.ts` | 1 | Task 13 |
  | `src/core/db/queries/stats/rankedAvailable.test.ts` | 2 | Task 12 |
  | `src/core/db/queries.test.ts` | 1 | Task 12 |

  During Tasks 9-12, a task's test gate is **its own scoped test files**, not the full suite. Before committing, confirm the failures outside your scope are still confined to the table above — a failure anywhere else is a real regression, so stop and report.

  Task 7 is the first commit where `knip` must be clean. **Task 13 must restore `typecheck` AND the full suite to green — that is its completion criterion, and Task 13 must run the full `pnpm test`, not a scoped file.** Tasks 14 and 15 run all four gates normally.
- **`pnpm knip` is why exports must be deleted, not merely unreferenced.** Any helper that loses its last consumer has to be unexported or removed in the same commit.
- `RECENCY_HALF_LIFE_SESSIONS = 4` (exact).
- Session ordinals are **0-based**: `0` is the most recent session in scope.
- Comments follow repo style — only for non-obvious decisions, and readable by someone in six months with no knowledge of this change. No comments that only make sense as PR commentary.
- Do **not** run `pnpm dev` or `vercel --prod` as part of this plan. Task 8 and Task 14 use `tsx` scripts against Turso directly.
- `.env.local` supplies `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`; scripts load it via `loadEnv()` from `src/core/db/ingest/utils`.

## Background: what is actually wrong today

Four sites compute a weighted geometric mean of pick positions, and they do not agree.

| Site | Feeds | Phase filter | Opt-outs | Unpicked penalty |
|---|---|---|---|---|
| `calculateStats.ts:39` (via `getCards.ts:427`) | main table P# | complete + playing | — | **per remaining copy** |
| `pickStats.ts:255` | `/api/cards/stats`, stats modal | complete + playing | filtered | only if fully unpicked |
| `rankedAvailable.ts:439` | `geomean_pick`, ranked sort | **none** | **not filtered** | only if fully unpicked |
| `worth.ts:412` | worth model → `worth`, `act_by`, danger | complete + playing | filtered | only if fully unpicked |

Three consequences, all measured against production data on 2026-08-07:

1. **Multi-copy divergence.** `getCards.ts:365` emits an unpicked entry per *remaining* copy; the other three emit one only when no copy was taken. All 20 qty-2 cards in the current cube are duals and fetches, and the main table reads every one of them as worse than the worth model does: Temple Garden 231.3 vs 215.8, Godless Shrine 235.1 vs 221.0, Stomping Ground 176.8 vs 170.4, down to Misty Rainforest 60.8 vs 60.0. Every difference is positive.

2. **In-progress drafts contaminate `rankedAvailable`.** With no phase filter, the three `drafting`-phase pods (kishla-skimmer, raven-eagle, hardened-academic) each contribute a 0.5-weight "unpicked at pool size" observation for every card that has not come up yet — *including the draft being ranked*. Median P# inflation 10.6, p90 28.5, max 79.3 (Stitcher's Supplier). Under the session decay this plan adds, the in-progress session sits at weight 1.0 while history decays, and the same inflation **doubles**: median 21.1, p90 36.6, max 144.5. This is why Task 5 is a prerequisite for Phase B rather than an optional cleanup.

3. **Opt-outs leak into `rankedAvailable`.** 9 rows exist in `privacy_opt_outs`; `rankedAvailable`'s pick query is the only one of the four that ignores them.

## Design decisions (settled — do not relitigate during execution)

- **Unpicked penalty: only when a draft took no copy at all.** A leftover copy of a qty-2 card is not evidence the card is unwanted, only that demand was not two deep. This adopts the `pickStats`/`rankedAvailable`/`worth` convention and changes the main table.
- **Recency unit: sessions, not days.** Evaluation drifts as the group drafts and sees cards play out. `draft_date` is the *sequencing key* (it is how a session is identified) but is consumed as an ordinal, never as a duration. A six-month hiatus therefore ages nothing.
- **Half-life: 4 sessions.** Across the 10 stats-eligible sessions this puts 2026-03-08 at 0.500 and 2025-10-01 at 0.210, holds median effective sample size at 20.5 of a flat 25.2, and moves the median card 8 ranks (p90 31) out of 515.
- **Anchor invariance.** The weighted geomean normalizes by ΣW, so scaling every weight by a constant is a no-op, and `0.5^(sessionsAgo/H)` differs from `0.5^(-sessionIndex/H)` only by such a constant. P# is therefore *exactly* stable until a new session lands — it moves on new data, never on the calendar. Do not add "days since" anywhere.

## Non-goals

- Normalizing pick position by pod size. Pods have run 8, 10, and 12 seats, so pick 30 is a different round in each. Real, pre-existing, out of scope.
- Surfacing effective sample size in the UI. After this change a card seen in 27 drafts may carry an ESS near 5, so `timesAvailable` and `drafts_seen` become optimistic. Worth doing; not here.
- Changing `worthModel.ts` itself. It consumes geomean and will re-fit on its own; Task 14 re-pins its validation gate.

## File Structure

| File | Responsibility |
|---|---|
| `src/core/pickScore.ts` **(new)** | The entire formula: `DraftObservation`, weights, recency decay, `pickScore()`. The only place any of it lives. |
| `src/core/draftSessions.ts` **(new)** | `sessionsAgoByDraft()` — groups drafts into sessions by date and returns 0-based ordinals. Separate from `pickScore.ts` because it is about draft metadata, not scoring, and all four sites need it independently. |
| `src/core/utils.ts` | Loses `calculatePickWeight` and `weightedGeometricMean`. Keeps `round3`, `sleep`, `groupBy`. |
| `src/core/calculateStats.ts` | Translates `CardPick[]` → `DraftObservation[]`. No longer computes weights. |
| `src/core/db/queries/stats/{worth,pickStats,rankedAvailable}.ts` | Each builds `DraftObservation[]` from its own query results. |
| `src/core/getCards.ts` | Threads session ordinals through to `calculateCardStats`. Its `buildAllPicks` is **not** changed. |

**A note on `getCards.ts`:** it is tempting to also stop `buildAllPicks` from emitting per-copy unpicked entries, since the new convention ignores them. Do not. Those entries are what `timesAvailable` and `maxCopiesInDraft` are derived from in `calculateStats.ts:43-55`. Leave them in the `CardPick[]` and let the translation in Task 6 drop them for scoring purposes only.

---

### Task 1: The canonical formula

**Files:**
- Create: `src/core/pickScore.ts`
- Test: `src/core/pickScore.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface DraftObservation {
    pickPositions: number[];  // in copy order; empty = no copy taken
    poolSize: number;
  }
  export function pickScore(observations: DraftObservation[]): number;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/core/pickScore.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pickScore, type DraftObservation } from "./pickScore";

const seen = (pickPositions: number[], poolSize = 540): DraftObservation => ({
  pickPositions,
  poolSize,
});

describe("pickScore", () => {
  it("returns 0 when there is nothing to average", () => {
    expect(pickScore([])).toBe(0);
  });

  it("returns the position itself for a single taken copy", () => {
    expect(pickScore([seen([10])])).toBeCloseTo(10, 10);
  });

  it("averages equally-weighted first copies geometrically", () => {
    // sqrt(4 * 16) = 8
    expect(pickScore([seen([4]), seen([16])])).toBeCloseTo(8, 5);
  });

  it("halves the weight of each successive copy", () => {
    // exp((1*ln(10) + 0.5*ln(20) + 0.25*ln(30)) / 1.75)
    expect(pickScore([seen([10, 20, 30])])).toBeCloseTo(14.27, 1);
  });

  it("scores a draft nobody took the card in at pool size, half weight", () => {
    // exp((1*ln(10) + 0.5*ln(540)) / 1.5) = 37.80
    expect(pickScore([seen([10]), seen([], 540)])).toBeCloseTo(37.8, 1);
  });

  it("ignores leftover copies when at least one copy was taken", () => {
    // A qty-2 card taken once contributes only that pick — the untaken copy
    // says demand was not two deep, not that the card is unwanted.
    expect(pickScore([seen([10])])).toBeCloseTo(10, 10);
  });

  it("uses each draft's own pool size for its unpicked penalty", () => {
    // exp((0.5*ln(533) + 0.5*ln(540)) / 1)
    expect(pickScore([seen([], 533), seen([], 540)])).toBeCloseTo(536.5, 1);
  });

  it("drops non-positive positions rather than letting ln(0) corrupt the score", () => {
    expect(pickScore([seen([0]), seen([10])])).toBeCloseTo(10, 10);
    expect(pickScore([seen([-5]), seen([20])])).toBeCloseTo(20, 10);
  });

  it("returns 0 when every position is invalid", () => {
    expect(pickScore([seen([0]), seen([-10])])).toBe(0);
  });

  it("stays finite for very large positions", () => {
    const result = pickScore([seen([10000])]);
    expect(result).toBeCloseTo(10000, 10);
    expect(Number.isFinite(result)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/core/pickScore.test.ts`
Expected: FAIL — `Failed to resolve import "./pickScore"`.

- [ ] **Step 3: Write the implementation**

Create `src/core/pickScore.ts`:

```ts
/**
 * The canonical pick score (P#).
 *
 * P# is the weighted geometric mean of the positions a card was taken at,
 * pooled across drafts. Lower is better. Every surface that reports a pick
 * score routes through pickScore() so the weighting conventions cannot drift
 * apart again.
 */

/** One card's record from one draft. */
export interface DraftObservation {
  /** Position each copy was taken at, in copy order. Empty if none were. */
  pickPositions: number[];
  /** Cards in that draft's cube — the stand-in position for an untaken card. */
  poolSize: number;
}

/**
 * Weight of a single observation.
 *
 * Successive copies are halved: the second copy of a card goes later for
 * mechanical reasons rather than because the card is worse, so it says less
 * about how the card is valued. A card nobody took is halved again because it
 * is censored — all it establishes is that the true position was at or beyond
 * the pool size.
 */
function observationWeight(copyIndex: number, wasPicked: boolean): number {
  return Math.pow(0.5, copyIndex) * (wasPicked ? 1 : 0.5);
}

/**
 * Flatten observations into weighted values.
 *
 * A draft in which any copy was taken contributes only its taken copies. A
 * leftover copy of a multi-copy card is not evidence the card went unwanted,
 * only that demand was not that deep.
 */
function weightedValues(
  observations: DraftObservation[],
): { value: number; weight: number }[] {
  const items: { value: number; weight: number }[] = [];

  for (const observation of observations) {
    if (observation.pickPositions.length > 0) {
      observation.pickPositions.forEach((position, copyIndex) => {
        items.push({ value: position, weight: observationWeight(copyIndex, true) });
      });
    } else {
      items.push({ value: observation.poolSize, weight: observationWeight(0, false) });
    }
  }

  return items;
}

/**
 * Weighted geometric mean of pick positions, or 0 when nothing is averageable.
 * Positions at or below 0 are dropped — ln(0) is -Infinity and would poison
 * the whole score.
 */
export function pickScore(observations: DraftObservation[]): number {
  const items = weightedValues(observations).filter((item) => item.value > 0);

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;

  const weightedLogSum = items.reduce(
    (sum, item) => sum + item.weight * Math.log(item.value),
    0,
  );

  return Math.exp(weightedLogSum / totalWeight);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/core/pickScore.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/pickScore.ts src/core/pickScore.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Add a single canonical pick-score formula

Four call sites had drifted into three different weighting conventions;
this is the one they will all be migrated onto.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

`pnpm knip` will flag `pickScore` as unused until Task 2 — that is expected, so do not run it as a gate for this task alone.

---

### Task 2: Migrate the worth table

**Files:**
- Modify: `src/core/db/queries/stats/worth.ts:383-414`
- Test: `src/core/db/queries/stats/worth.test.ts`

**Interfaces:**
- Consumes: `pickScore`, `DraftObservation` from Task 1.
- Produces: no signature changes. `getWorthTable()` returns the same shape.

This site already implements the target convention, so P# values must not move. That is the point: it proves the new module reproduces the old behaviour before any site changes numbers.

- [ ] **Step 1: Record the current output as a baseline**

```bash
npx tsx -e '
import { getWorthTable } from "/Users/arpanet/code/read-the-bones/src/core/db/queries/stats/worth";
import { loadEnv } from "/Users/arpanet/code/read-the-bones/src/core/db/ingest/utils";
loadEnv();
const t = await getWorthTable();
const out = Object.fromEntries(t.cards.map((c) => [c.name, c.geomean]));
console.log(JSON.stringify(out));
' > /tmp/worth-geomean-before.json
```

- [ ] **Step 2: Replace the geomean loop**

In `worth.ts`, replace the body of the `for (const name of tableNames)` loop (currently lines 384-413) with:

```ts
  const geomeanByName = new Map<string, number | null>();
  for (const name of tableNames) {
    const byDraft = picksByName.get(name);
    const observations: DraftObservation[] = [];
    for (const draft of statsDrafts) {
      if (!snapshotCardNames.get(draft.cubeSnapshotId)?.has(name)) continue;
      observations.push({
        pickPositions: byDraft?.get(draft.draftId) ?? [],
        poolSize: poolSizeBySnapshot.get(draft.cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
    }
    geomeanByName.set(name, observations.length > 0 ? pickScore(observations) : null);
  }
```

Update the import on line 20 from
`import { calculatePickWeight, weightedGeometricMean } from "../../../utils";`
to
`import { pickScore, type DraftObservation } from "../../../pickScore";`

Keep the existing comment above the loop, updated to drop the now-stale "(mirrors rankedAvailable.ts)" cross-reference:

```ts
  // Per-card pick aggregates. A draft in which the card sat in the pool
  // untaken contributes one half-weight observation at the pool size.
```

- [ ] **Step 3: Verify the numbers are unchanged**

```bash
pnpm test src/core/db/queries/stats/worth.test.ts
npx tsx -e '
import { getWorthTable } from "/Users/arpanet/code/read-the-bones/src/core/db/queries/stats/worth";
import { loadEnv } from "/Users/arpanet/code/read-the-bones/src/core/db/ingest/utils";
import { readFileSync } from "node:fs";
loadEnv();
const before = JSON.parse(readFileSync("/tmp/worth-geomean-before.json", "utf8"));
const t = await getWorthTable();
let worst = 0, worstName = "";
for (const c of t.cards) {
  const b = before[c.name];
  if (b == null || c.geomean == null) continue;
  const d = Math.abs(b - c.geomean);
  if (d > worst) { worst = d; worstName = c.name; }
}
console.log("max |delta| =", worst.toFixed(10), worstName);
'
```
Expected: `max |delta| = 0.0000000000` (floating-point reassociation may leave a value below 1e-9; anything larger means the translation is wrong — stop and fix it).

- [ ] **Step 4: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/worth.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Route the worth table through the canonical pick score

Behaviour-identical by construction — this site already used the target
convention, so it verifies the shared module before any numbers move.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Migrate the card stats query

**Files:**
- Modify: `src/core/db/queries/stats/pickStats.ts:194-255`
- Test: `src/core/db/queries.test.ts` (the `getCardPickStats` describe block, around line 1400)

**Interfaces:**
- Consumes: `pickScore`, `DraftObservation`.
- Produces: `CardPickStatsResult` unchanged.

Also behaviour-identical. Note this loop additionally accumulates `pickPositions` for `avg_pick_n` / `median_pick_n`, which must keep counting *only* taken copies.

- [ ] **Step 1: Replace the accumulation loop**

Replace lines 194-234 with:

```ts
  // Taken positions feed avg/median; observations feed the weighted score.
  const pickPositions: number[] = [];
  const observations: DraftObservation[] = [];

  for (const draftId of draftIds) {
    const picks = picksByDraft.get(draftId) || [];
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    const poolSize = cubeSnapshotId
      ? cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE
      : DEFAULT_POOL_SIZE;

    const positions = picks.map((pick) => pick.pick_n);
    pickPositions.push(...positions);
    observations.push({ pickPositions: positions, poolSize });
  }
```

Replace line 255 with:

```ts
  const weighted_geomean = pickScore(observations);
```

Update the import on line 8 from
`import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";`
to
```ts
import { round3 } from "../../../utils";
import { pickScore, type DraftObservation } from "../../../pickScore";
```

Update the module docstring on line 37 — it currently says "Uses the weighted geometric mean formula from calculateStats.ts", which was already wrong and is now doubly so:

```ts
/**
 * Get aggregate pick statistics for a card across drafts.
 * The weighted score comes from the canonical formula in pickScore.ts.
 */
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test src/core/db/queries.test.ts`
Expected: PASS. `queries.test.ts:1449` asserts `weighted_geomean === 5` and must still hold — if it does not, the translation dropped or double-counted an observation.

- [ ] **Step 3: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/pickStats.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Route card pick stats through the canonical pick score

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Migrate the ranked-available query

**Files:**
- Modify: `src/core/db/queries/stats/rankedAvailable.ts:413-441`
- Test: `src/core/db/queries/stats/rankedAvailable.test.ts`

**Interfaces:**
- Consumes: `pickScore`, `DraftObservation`.
- Produces: `RankedCard` unchanged.

Mechanical migration only. The phase and opt-out fixes are Task 5, deliberately separate so they can be reviewed on their own merits.

- [ ] **Step 1: Replace the geomean block**

Replace lines 413-441 with:

```ts
    // Pick stats: weighted score over every draft the card was in the pool for
    const drafts = cardDrafts.get(cardId) ?? new Map();
    const picks = cardPicks.get(cardId) ?? new Map();
    const observations: DraftObservation[] = [];
    let timesPicked = 0;

    for (const [draftId, cubeSnapshotId] of drafts) {
      const draftPicks = picks.get(draftId) ?? [];
      timesPicked += draftPicks.length;
      observations.push({
        pickPositions: draftPicks,
        poolSize: cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
    }

    const geomean =
      observations.length > 0 ? Math.round(pickScore(observations) * 10) / 10 : 0;
```

Update the import on line 11 from
`import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";`
to
```ts
import { round3 } from "../../../utils";
import { pickScore, type DraftObservation } from "../../../pickScore";
```

- [ ] **Step 2: Run the tests**

Run: `pnpm test src/core/db/queries/stats/rankedAvailable.test.ts`
Expected: PASS, unchanged.

- [ ] **Step 3: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/rankedAvailable.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Route ranked-available through the canonical pick score

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Canonicalize ranked-available's inputs (behaviour change)

**Files:**
- Modify: `src/core/db/queries/stats/rankedAvailable.ts:255-280` (the `draftsResult` / `picksResult` queries) and the `cardPicks` accumulation that follows
- Test: `src/core/db/queries/stats/rankedAvailable.test.ts`

**Interfaces:** no signature changes.

This is the one task in Phase A that intentionally moves numbers, and it is a prerequisite for Phase B. `rankedAvailable` is the only one of the four sites with no phase filter and no opt-out filter, so an in-progress draft currently supplies a "nobody took this" observation for every card that has not come up yet — including the very draft being ranked. Measured today: median P# inflation 10.6, p90 28.5, max 79.3. Session decay would double it.

**Why this is safe for live drafts:** which cards are still available comes from `getAvailableCards` in Step 1 of this query, driven by `before_pick_n`. The geomean is purely a historical prior. Excluding in-progress drafts from the prior does not hide any card.

- [ ] **Step 1: Write the failing tests**

This file drives a real in-memory libsql database via `createMemDb` and the
`insert*` helpers from `src/core/db/__tests__/testDb.ts`, with `getClient`
mocked to return it. **`rankAvailableCards` takes only `params`** — it calls
`getClient()` itself, so do not pass a client.

Add to `src/core/db/queries/stats/rankedAvailable.test.ts` a new top-level block:

```ts
describe("rankAvailableCards — pick-score inputs", () => {
  it("excludes in-progress drafts from geomean_pick", async () => {
    // A card untaken in a 'drafting' draft must not be scored as unwanted:
    // it may simply not have come up yet.
    await insertCubeSnapshot(db, 1);
    await insertCard(db, 1, "Alpha");
    await insertCubeCard(db, 1, 1);
    await insertDraft(db, "done", { phase: "complete", cubeSnapshotId: 1 });
    await insertDraft(db, "live", { phase: "drafting", cubeSnapshotId: 1 });
    await insertPickEvent(db, "done", 10, 1, 1);

    const result = await rankAvailableCards({
      draft_id: "live",
      before_pick_n: 5,
    });

    const card = result.cards.find((c) => c.card_name === "Alpha")!;
    // Only the completed draft counts, so the score is that single pick.
    expect(card.geomean_pick).toBeCloseTo(10, 1);
    expect(card.drafts_in_pool).toBe(1);
  });

  it("excludes opted-out seats from geomean_pick", async () => {
    await insertCubeSnapshot(db, 1);
    await insertCard(db, 1, "Alpha");
    await insertCubeCard(db, 1, 1);
    await insertDraft(db, "d1", { phase: "complete", cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 10, 3, 1);
    await insertPrivacyOptOut(db, "d1", 3);

    const result = await rankAvailableCards({
      draft_id: "d1",
      before_pick_n: 500,
    });

    const card = result.cards.find((c) => c.card_name === "Alpha")!;
    // The only pick was by an opted-out seat, so the card reads as untaken
    // and takes the half-weight pool-size penalty.
    expect(card.geomean_pick).toBeCloseTo(1, 1);
    expect(card.times_picked).toBe(0);
  });
});
```

The second assertion is `1`, not `540`: the cube here holds a single card, so
`SUM(qty)` makes the pool size 1. Keep the fixture minimal and assert against
the pool size it actually produces rather than inflating the cube to 540 rows.

Extend the file's existing import from `../../__tests__/testDb` with
`insertPickEvent` and `insertPrivacyOptOut`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/core/db/queries/stats/rankedAvailable.test.ts`
Expected: FAIL — geomean_pick reflects the live draft's unpicked penalty and the opted-out seat's pick.

- [ ] **Step 3: Add the phase filter to both queries**

`statsPhaseFilter` is already imported by the sibling modules; add it here:

```ts
import { statsPhaseFilter } from "../../../draftPhases";
```

In the `Promise.all` at line ~255, change `draftsResult` and `picksResult`. Note `statsPhaseFilter` returns `{ fragment, args }` and each query needs its **own** call, because the argument arrays are positional:

```ts
  const draftPhase = statsPhaseFilter("d.phase");
  const pickPhase = statsPhaseFilter("d.phase");

  const [draftsResult, picksResult, cubeSizesResult] = await Promise.all([
    client.execute({
      sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id, csc.card_id
            FROM drafts d
            JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE csc.card_id IN (${idPlaceholderStr}) AND ${draftPhase.fragment}`,
      args: [...cardIds, ...draftPhase.args],
    }),
    client.execute({
      sql: `SELECT pe.card_id, pe.draft_id, pe.pick_n, pe.seat
            FROM pick_events pe
            JOIN drafts d ON d.draft_id = pe.draft_id
            WHERE pe.card_id IN (${idPlaceholderStr}) AND ${pickPhase.fragment}`,
      args: [...cardIds, ...pickPhase.args],
    }),
    // cubeSizesResult unchanged
  ]);
```

- [ ] **Step 4: Filter opted-out seats out of the pick accumulation**

`fetchOptOuts` is already imported in this file and already called at line ~343 for play/win stats, but *after* the pick accumulation. Move that call above the loop that builds `cardPicks` and reuse the one `optedOut` set for both — do not fetch twice. In the loop that reads `picksResult.rows` into `cardPicks`, skip rows whose seat opted out:

```ts
    if (optedOut.has(`${row.draft_id}:${row.seat}`)) continue;
```

The `allDraftIds` set that `fetchOptOuts` is called with is currently built from `playResult` and `winResult` rows only; extend it with `picksResult` draft ids so pick-side opt-outs actually resolve.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/core/db/queries/stats/rankedAvailable.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the real-data effect matches the prediction**

```bash
npx tsx /tmp/claude-1000/-Users-arpanet-code/dea9820d-5f34-4f25-b25f-14d1db89b44f/scratchpad/live-contamination.ts
```
Expected: reports the same 3 non-stats-phase drafts and a flat median |delta| near 10.6. That script measures the *old* behaviour from the database directly, so it is a check that the code change addresses the measured problem, not a regression test.

- [ ] **Step 7: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/rankedAvailable.ts src/core/db/queries/stats/rankedAvailable.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Score ranked-available on completed drafts only, honouring opt-outs

An in-progress draft was contributing an unpicked penalty for every card
that had not come up yet, including the draft being ranked — inflating
P# by a median of 10.6. Opt-outs were also the only site not filtering them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Migrate the main table (behaviour change)

**Files:**
- Modify: `src/core/calculateStats.ts:17-39`
- Test: `src/core/calculateStats.test.ts`, `src/core/getCards.test.ts`

**Interfaces:**
- Consumes: `pickScore`, `DraftObservation`.
- Produces: `calculateCardStats(picks: CardPick[]): CardStats[]` — signature unchanged in this task.

This adopts the "only if fully unpicked" convention for the main table. `CardPick` entries with `wasPicked: false` still mark that the card was in that draft's pool (which is what `timesAvailable` counts), but when a draft took at least one copy they no longer contribute a penalty observation. Expected effect: the 20 qty-2 cards improve to match the worth table, e.g. Temple Garden 231.3 → 215.8.

- [ ] **Step 1: Update the existing tests to the new convention**

In `src/core/calculateStats.test.ts`, rewrite the two tests that assert the old per-copy behaviour.

Replace `"should handle combined copy and unpicked weights"` (expects 20.9) with:

```ts
    it("ignores an untaken copy when another copy was taken in that draft", () => {
      // A qty-2 card taken once says demand was one deep, not that the card
      // went unwanted — so only the taken copy is scored.
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 10,
          copyNumber: 1,
          wasPicked: true,
          draftId: "d1",
        }),
        createPick({
          cardName: "Test",
          pickPosition: 400,
          copyNumber: 2,
          wasPicked: false,
          draftId: "d1",
        }),
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].weightedGeomean).toBeCloseTo(10, 10);
      // The untaken copy still proves the card was in that draft's pool.
      expect(stats[0].timesAvailable).toBe(1);
    });
```

Replace `"unpicked third copy has lower influence than picked first copy in weighted geomean"` (expects 12.60) with:

```ts
    it("scores a draft that took no copy at pool size, at half weight", () => {
      // exp((1*ln(10) + 0.5*ln(80)) / 1.5) = 20.00
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 10, copyNumber: 1, wasPicked: true, draftId: "d1" }),
        createPick({ cardName: "Test", pickPosition: 80, copyNumber: 1, wasPicked: false, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].weightedGeomean).toBeCloseTo(20.0, 1);
    });
```

Leave `"handles unpicked third copy: weight factors combine but single-value geomean is the pick position"` — it asserts 10 for a lone unpicked entry, which the new convention still produces — but update its now-inaccurate comment to `// A draft that took no copy contributes one observation; with nothing to average against, the score is that value.`

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/core/calculateStats.test.ts`
Expected: FAIL — the two rewritten tests get 20.9 and 12.60 against expectations of 10 and 18.6.

- [ ] **Step 3: Translate CardPick[] into observations**

In `src/core/calculateStats.ts`, delete the `calculateWeight` helper (lines 17-25) and replace the geomean computation in `calculateSingleCardStats` (lines 34-39) with:

```ts
  // Group by draft: the score treats each draft as one observation, and a
  // draft that took at least one copy contributes only the copies it took.
  const picksByDraft = groupBy(cardPicks, (pick) => pick.draftId);
  const observations: DraftObservation[] = [];
  for (const [, draftPicks] of picksByDraft) {
    const taken = draftPicks
      .filter((pick) => pick.wasPicked)
      .sort((a, b) => a.copyNumber - b.copyNumber);
    const untaken = draftPicks.find((pick) => !pick.wasPicked);
    observations.push({
      pickPositions: taken.map((pick) => pick.pickPosition),
      // An unpicked entry carries the pool size as its pickPosition. A draft
      // with no untaken entry never reaches pickScore's pool-size branch, so
      // the 0 fallback is unreachable rather than a silent default.
      poolSize: untaken?.pickPosition ?? 0,
    });
  }
  const weightedGeomean = pickScore(observations);
```

Update the imports on line 7 from
`import { groupBy, calculatePickWeight, weightedGeometricMean } from "./utils";`
to
```ts
import { groupBy } from "./utils";
import { pickScore, type DraftObservation } from "./pickScore";
```

Update the module docstring on line 3 from "Computes weighted geometric means to rank cards based on pick positions." to "Aggregates per-card pick data; the score itself comes from pickScore.ts."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/core/calculateStats.test.ts src/core/getCards.test.ts`
Expected: PASS. `getCards.test.ts:277` asserts Cancel's geomean exceeds Counterspell's — Cancel is unpicked in one draft of two, so it still does.

- [ ] **Step 5: Gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm test
git -C /Users/arpanet/code/read-the-bones add src/core/calculateStats.ts src/core/calculateStats.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Score the main table on the same convention as every other surface

A leftover copy of a qty-2 card was counted as an unpicked penalty here and
nowhere else, so all 20 duals and fetches read as worse on the main table
than in the worth model.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Retire the old helpers

**Files:**
- Modify: `src/core/utils.ts` (delete `calculatePickWeight` lines 5-24 and `weightedGeometricMean` lines 26-49)
- Modify: `src/core/utils.test.ts` (delete both describe blocks and trim the import)

**Interfaces:** `utils.ts` retains `round3`, `sleep`, `groupBy`.

- [ ] **Step 1: Confirm nothing still imports them**

```bash
grep -rn "calculatePickWeight\|weightedGeometricMean" --include="*.ts" --include="*.tsx" /Users/arpanet/code/read-the-bones/src /Users/arpanet/code/read-the-bones/scripts
```
Expected: only `src/core/utils.ts` and `src/core/utils.test.ts`. If any other file appears, that call site was missed in Tasks 2-6 — go back and migrate it.

- [ ] **Step 2: Delete both functions and their tests**

Remove `calculatePickWeight` and `weightedGeometricMean` from `utils.ts`, and the `describe("calculatePickWeight")` and `describe("weightedGeometricMean")` blocks from `utils.test.ts`. Change the test import on line 2 to `import { round3 } from "./utils";`.

Their coverage now lives in `pickScore.test.ts` — do not re-add equivalent tests here.

- [ ] **Step 3: Run the full gates including knip**

Run: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`
Expected: all pass. This is the first task where `pnpm knip` should be clean, since `pickScore` now has consumers and the old helpers are gone.

- [ ] **Step 4: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/utils.ts src/core/utils.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Drop the superseded pick-weight helpers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Verify Phase A against production data

**Files:** none modified. This task produces a written result, not a diff.

- [ ] **Step 1: Compare main-table P# before and after**

`npx tsx -e` rejects top-level `await` (Task 2 hit this). Write a scratch file
and run it instead — put it outside the repo so it never risks being committed:

```bash
cat > /tmp/phase-a-check.mts <<'EOF'
import { getCards } from "/Users/arpanet/code/read-the-bones/src/core/getCards";
import { loadEnv } from "/Users/arpanet/code/read-the-bones/src/core/db/ingest/utils";

loadEnv();

const result = await getCards({});
const multiCopy = ["Temple Garden","Godless Shrine","Stomping Ground","Sacred Foundry","Overgrown Tomb","Polluted Delta","Misty Rainforest"];
const singleCopy = ["Counterspell","Dark Ritual","Korvold, Fae-Cursed King","Lurrus of the Dream-Den","Mockingbird"];

for (const label of ["multi-copy (expected to move)", "single-copy (expected unchanged)"]) {
  console.log(`\n${label}`);
  for (const name of label.startsWith("multi") ? multiCopy : singleCopy) {
    const card = result.cards.find((c) => c.cardName === name);
    console.log(" ", name.padEnd(28), card ? card.weightedGeomean.toFixed(1) : "NOT FOUND");
  }
}
EOF
npx tsx /tmp/phase-a-check.mts
```

`loadEnv()` prints dotenv "tip" lines to stdout; ignore them, or filter them out
if you pipe this into anything that parses the output.

Expected values, measured on 2026-08-07 after Task 6:

| card | main table (expected) | worth table | gap |
|---|---|---|---|
| Temple Garden | 215.8 | 215.8 | — |
| Godless Shrine | 221.1 | 221.0 | 0.1 |
| Stomping Ground | 170.4 | 170.4 | — |
| Sacred Foundry | 155.2 | 154.1 | 1.1 |
| Overgrown Tomb | 176.7 | 174.4 | 2.3 |
| Polluted Delta | 79.5 | 83.6 | 4.1 |
| Misty Rainforest | 58.7 | 60.0 | 1.3 |

**The main table does not fully converge on the worth table, and that is expected.**
An earlier draft of this plan predicted exact convergence; that was wrong. The
residual gap is a *sixth* inconsistency, independent of pick-score convention:
`getCards.ts` applies **no privacy opt-out filtering at all** (grep it — there
are zero references), while `worth.ts` and `pickStats.ts` both exclude
opted-out seats. With 9 rows in `privacy_opt_outs`, cards those seats took read
lower on the main table.

This was confirmed by computing the post-Task-6 convention both ways: every
main-table value above matches the no-opt-out computation exactly, and every
worth-table value matches the opt-out-filtered one. So a gap here is evidence
the convention change worked, not that it failed.

Fixing it is **out of scope for this plan** — see Non-goals. Note that
`worth.ts:312-315` documents a deliberate precedent for *not* applying opt-outs
to pod-level aggregates, so which behaviour is correct is a judgment call, not
an obvious bug.

- [ ] **Step 2: Confirm qty-1 cards did not move**

The convention change touches multi-copy cards only, so every single-copy card
must read exactly as it did before Task 6. The script above prints these five;
compare against the pre-change main table:

| card | expected (unchanged) |
|---|---|
| Counterspell | 72.6 |
| Dark Ritual | 172.9 |
| Korvold, Fae-Cursed King | 307.0 |
| Lurrus of the Dream-Den | 147.8 |
| Mockingbird | 294.6 |

Do **not** compare these to the worth table — they differ there for the opt-out
reason above (Dark Ritual is 182.5 in the worth table, a 9.6 gap that has
nothing to do with this change). Any movement in this column is a real
regression.

- [ ] **Step 3: Run the e2e suite**

Run: `pnpm test:e2e`
Expected: PASS. If a spec asserts a hard-coded P#, update it to the new value and note which in the commit.

- [ ] **Step 4: Record the result**

Append a short "Phase A measured effect" note to this plan file listing the observed before/after for the seven cards above, then commit the plan update. Phase B's diffs are read against this baseline.

#### Phase A measured effect (2026-08-07, Task 8 verification)

Ran the Step 1/2 script against production Turso data (27/30 drafts loaded,
520 cards). All twelve values matched the brief's expected values exactly —
zero deviation on every card, including the tenths place.

Multi-copy cards (expected to move, main table vs. worth table gap from
missing opt-out filtering in `getCards.ts` is expected and unrelated to this
plan):

| card | main table (measured) | expected | match |
|---|---|---|---|
| Temple Garden | 215.8 | 215.8 | yes |
| Godless Shrine | 221.1 | 221.1 | yes |
| Stomping Ground | 170.4 | 170.4 | yes |
| Sacred Foundry | 155.2 | 155.2 | yes |
| Overgrown Tomb | 176.7 | 176.7 | yes |
| Polluted Delta | 79.5 | 79.5 | yes |
| Misty Rainforest | 58.7 | 58.7 | yes |

Single-copy controls (expected unchanged since Task 6 touches only the 20
quantity-2 cards in the cube):

| card | main table (measured) | expected (unchanged) | match |
|---|---|---|---|
| Counterspell | 72.6 | 72.6 | yes |
| Dark Ritual | 172.9 | 172.9 | yes |
| Korvold, Fae-Cursed King | 307.0 | 307.0 | yes |
| Lurrus of the Dream-Den | 147.8 | 147.8 | yes |
| Mockingbird | 294.6 | 294.6 | yes |

No single-copy card moved. `pnpm test:e2e` was run with chromium already
installed (`~/.cache/ms-playwright`); all 50 specs passed with no hard-coded
pick-score assertions needing an update. Full detail (script output, e2e log)
is in `.superpowers/sdd/2026-08-07-recency-weighted-pick-score/task-8-report.md`.

---

### Task 9: Session ordinals and recency decay

**Files:**
- Create: `src/core/draftSessions.ts`
- Create: `src/core/draftSessions.test.ts`
- Modify: `src/core/pickScore.ts`
- Modify: `src/core/pickScore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // draftSessions.ts
  export function sessionsAgoByDraft(
    drafts: Array<{ draftId: string; draftDate: string }>,
  ): Map<string, number>;

  // pickScore.ts — DraftObservation gains one required field
  export interface DraftObservation {
    sessionsAgo: number;
    pickPositions: number[];
    poolSize: number;
  }
  export const RECENCY_HALF_LIFE_SESSIONS = 4;
  ```

Making `sessionsAgo` **required** is deliberate: the compiler then proves all four call sites were updated in Tasks 10-13.

- [ ] **Step 1: Write the failing session-ordinal tests**

Create `src/core/draftSessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sessionsAgoByDraft } from "./draftSessions";

describe("sessionsAgoByDraft", () => {
  it("gives the most recent session ordinal 0", () => {
    const map = sessionsAgoByDraft([
      { draftId: "old", draftDate: "2026-01-01" },
      { draftId: "new", draftDate: "2026-07-17" },
    ]);
    expect(map.get("new")).toBe(0);
    expect(map.get("old")).toBe(1);
  });

  it("treats same-date pods as one session", () => {
    // Five parallel pods are one drafting occasion, not five.
    const map = sessionsAgoByDraft([
      { draftId: "a", draftDate: "2026-07-17" },
      { draftId: "b", draftDate: "2026-07-17" },
      { draftId: "c", draftDate: "2026-05-23" },
    ]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(0);
    expect(map.get("c")).toBe(1);
  });

  it("counts sessions, not elapsed time", () => {
    // A four-month gap and a one-week gap are both one session.
    const map = sessionsAgoByDraft([
      { draftId: "x", draftDate: "2026-07-17" },
      { draftId: "y", draftDate: "2026-07-10" },
      { draftId: "z", draftDate: "2026-03-08" },
    ]);
    expect(map.get("y")).toBe(1);
    expect(map.get("z")).toBe(2);
  });

  it("returns an empty map for no drafts", () => {
    expect(sessionsAgoByDraft([]).size).toBe(0);
  });

  it("does not depend on input order", () => {
    const forward = sessionsAgoByDraft([
      { draftId: "a", draftDate: "2026-01-01" },
      { draftId: "b", draftDate: "2026-07-17" },
    ]);
    const reverse = sessionsAgoByDraft([
      { draftId: "b", draftDate: "2026-07-17" },
      { draftId: "a", draftDate: "2026-01-01" },
    ]);
    expect([...forward]).toEqual([...reverse].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/core/draftSessions.test.ts`
Expected: FAIL — `Failed to resolve import "./draftSessions"`.

- [ ] **Step 3: Implement session ordinals**

Create `src/core/draftSessions.ts`:

```ts
/**
 * Drafts that ran on the same date are one session — parallel pods are a
 * single drafting occasion, and each drafter only played one of them.
 *
 * Recency is measured in sessions rather than days because what moves the
 * group's evaluation of a card is drafting it and seeing it play out, not the
 * calendar. A long gap between sessions therefore ages nothing.
 */

/**
 * Map each draft to how many sessions back it is, 0 being the most recent
 * session among the drafts given.
 */
export function sessionsAgoByDraft(
  drafts: Array<{ draftId: string; draftDate: string }>,
): Map<string, number> {
  // ISO dates sort lexicographically, so this is newest-first.
  const sessionDates = [...new Set(drafts.map((draft) => draft.draftDate))]
    .sort()
    .reverse();

  const ordinalByDate = new Map(sessionDates.map((date, index) => [date, index]));

  return new Map(
    drafts.map((draft) => [draft.draftId, ordinalByDate.get(draft.draftDate)!]),
  );
}
```

- [ ] **Step 4: Run to verify passing**

Run: `pnpm test src/core/draftSessions.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing decay tests**

Add to `src/core/pickScore.test.ts`, and update the existing `seen` helper to supply the new field:

```ts
const seen = (
  pickPositions: number[],
  poolSize = 540,
  sessionsAgo = 0,
): DraftObservation => ({ sessionsAgo, pickPositions, poolSize });
```

```ts
describe("pickScore recency", () => {
  it("halves an observation's weight every RECENCY_HALF_LIFE_SESSIONS sessions", () => {
    // Recent pick at 10 (weight 1), pick four sessions back at 40 (weight 0.5):
    // exp((1*ln(10) + 0.5*ln(40)) / 1.5)
    expect(
      pickScore([seen([10], 540, 0), seen([40], 540, RECENCY_HALF_LIFE_SESSIONS)]),
    ).toBeCloseTo(15.9, 1);
  });

  it("pulls the score toward the more recent observation", () => {
    const flat = pickScore([seen([10], 540, 0), seen([40], 540, 0)]);
    const decayed = pickScore([seen([10], 540, 0), seen([40], 540, 8)]);
    expect(decayed).toBeLessThan(flat);
  });

  it("is unchanged by shifting every observation back equally", () => {
    // Weights are normalized by their sum, so a uniform shift cancels: P# moves
    // when new data lands, never merely because time passed.
    const anchored = pickScore([seen([10], 540, 0), seen([40], 540, 2)]);
    const shifted = pickScore([seen([10], 540, 3), seen([40], 540, 5)]);
    expect(shifted).toBeCloseTo(anchored, 10);
  });

  it("compounds with the copy factor", () => {
    // Four sessions back, both copies also take the 0.5 recency factor:
    // first copy 1*0.5 = 0.5, second copy 0.5*0.5 = 0.25.
    // exp((1*ln(10) + 0.5*ln(40) + 0.25*ln(40)) / 1.75) = 18.11
    expect(pickScore([seen([10], 540, 0), seen([40, 40], 540, 4)])).toBeCloseTo(18.1, 1);
    // Without decay the same observations score 22.97.
    expect(pickScore([seen([10]), seen([40, 40])])).toBeCloseTo(23.0, 1);
  });
});
```

Add `RECENCY_HALF_LIFE_SESSIONS` to the import at the top of the file.

- [ ] **Step 6: Run to verify failure**

Run: `pnpm test src/core/pickScore.test.ts`
Expected: FAIL — `RECENCY_HALF_LIFE_SESSIONS` is not exported.

- [ ] **Step 7: Add the recency factor**

In `src/core/pickScore.ts`, add the field to the interface:

```ts
export interface DraftObservation {
  /** How many drafting sessions back this draft was; 0 is the most recent. */
  sessionsAgo: number;
  /** Position each copy was taken at, in copy order. Empty if none were. */
  pickPositions: number[];
  /** Cards in that draft's cube — the stand-in position for an untaken card. */
  poolSize: number;
}
```

Add the constant and helper:

```ts
/**
 * Sessions after which an observation counts half as much.
 *
 * Four keeps roughly four fifths of the effective sample while still letting
 * the newest session outweigh a year-old one by about five to one.
 */
export const RECENCY_HALF_LIFE_SESSIONS = 4;

/**
 * How much an observation from `sessionsAgo` sessions back still counts.
 *
 * Only the differences between sessions matter: because the geometric mean
 * normalizes by total weight, shifting every observation back by the same
 * amount cancels out exactly. P# moves when a new session lands, not as time
 * passes.
 */
function recencyWeight(sessionsAgo: number): number {
  return Math.pow(0.5, sessionsAgo / RECENCY_HALF_LIFE_SESSIONS);
}
```

Change `observationWeight` to take the observation's recency and multiply it in:

```ts
function observationWeight(
  copyIndex: number,
  wasPicked: boolean,
  sessionsAgo: number,
): number {
  return (
    Math.pow(0.5, copyIndex) * (wasPicked ? 1 : 0.5) * recencyWeight(sessionsAgo)
  );
}
```

Update both `push` calls in `weightedValues` to pass `observation.sessionsAgo`.

Extend the module docstring to name the third factor:

```ts
/**
 * The canonical pick score (P#).
 *
 * P# is the weighted geometric mean of the positions a card was taken at,
 * pooled across drafts. Lower is better. Three factors set an observation's
 * weight: which copy it was, whether anyone took it, and how many drafting
 * sessions ago the draft ran. Every surface that reports a pick score routes
 * through pickScore() so the weighting conventions cannot drift apart again.
 */
```

- [ ] **Step 8: Run to verify passing**

Run: `pnpm test src/core/pickScore.test.ts src/core/draftSessions.test.ts`
Expected: PASS. The Phase A tests still pass because they all use `sessionsAgo: 0`.

- [ ] **Step 9: Commit**

`pnpm typecheck` will now fail in the four call sites — that is expected and is fixed in Tasks 10-13. Commit the module alone so the decay logic is reviewable on its own:

```bash
pnpm test src/core/pickScore.test.ts src/core/draftSessions.test.ts
git -C /Users/arpanet/code/read-the-bones add src/core/pickScore.ts src/core/pickScore.test.ts src/core/draftSessions.ts src/core/draftSessions.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Weight pick observations by how many sessions ago they happened

The cube and the group's read on it have both moved over ten months, so a
pick from last October should not count as much as one from July.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Thread sessions into the worth table

**Files:**
- Modify: `src/core/db/queries/stats/worth.ts:51-54, 81-84, 114-119, 383-414`
- Test: `src/core/db/queries/stats/worth.test.ts`

**Interfaces:** `StatsDraftRef` gains `draftDate: string`.

**The LODO subtlety:** `getWorthTable({ excludeDraftId })` drops one draft for leave-one-draft-out validation. Session ordinals must be computed from the **unfiltered** draft set, *then* the exclusion applied. Otherwise excluding the sole pod of a one-pod session (2026-01-08, 2026-01-01, 2025-12-15 are each single-pod) collapses that session and shifts every older ordinal, making that fold incomparable to the others.

- [ ] **Step 1: Add the date to the query and the ref**

Extend the interface at line 51:

```ts
interface StatsDraftRef {
  draftId: string;
  cubeSnapshotId: number;
  draftDate: string;
  sessionsAgo: number;
}
```

Add `draft_date` to the `SELECT` at line 82:

```sql
SELECT draft_id, cube_snapshot_id, draft_date, pool_hash, picks_hash, matches_hash
FROM drafts WHERE ${phaseFilter.fragment} ORDER BY draft_id
```

- [ ] **Step 2: Compute ordinals before excluding**

Replace lines 114-119 with:

```ts
  const allStatsDrafts = draftsResult.rows.map((row) => ({
    draftId: row.draft_id as string,
    cubeSnapshotId: row.cube_snapshot_id as number,
    draftDate: row.draft_date as string,
  }));

  // Ordinals come from the full set so a leave-one-out fold that removes the
  // only pod of a session does not renumber every older session.
  const sessionsAgo = sessionsAgoByDraft(allStatsDrafts);

  const statsDrafts: StatsDraftRef[] = allStatsDrafts
    .map((draft) => ({ ...draft, sessionsAgo: sessionsAgo.get(draft.draftId)! }))
    .filter((draft) => draft.draftId !== opts?.excludeDraftId);
```

Add the import:

```ts
import { sessionsAgoByDraft } from "../../../draftSessions";
```

- [ ] **Step 3: Pass it into the observations**

In the geomean loop from Task 2, add the field:

```ts
      observations.push({
        sessionsAgo: draft.sessionsAgo,
        pickPositions: byDraft?.get(draft.draftId) ?? [],
        poolSize: poolSizeBySnapshot.get(draft.cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
```

- [ ] **Step 4: Add a regression test for the LODO invariant**

This file also drives a real memdb (`createMemDb` + `insert*` helpers, `getClient`
mocked, `_resetWorthCache()` in `beforeEach`). Add a self-contained block rather
than extending the shared fixture, so the session layout is explicit:

```ts
describe("session ordinals under leave-one-draft-out", () => {
  it("does not renumber older sessions when a fold removes a single-pod session", async () => {
    // Sessions: 2026-07-17 (newest), 2026-03-08 (one pod), 2026-01-01.
    // Dropping the lone 2026-03-08 pod must not promote 2026-01-01 from two
    // sessions back to one, or LODO folds stop being comparable.
    await insertCubeSnapshot(db, 1);
    await insertCard(db, 1, "Alpha");
    await insertCubeCard(db, 1, 1);
    await insertDraft(db, "newest", { date: "2026-07-17", cubeSnapshotId: 1 });
    await insertDraft(db, "solo", { date: "2026-03-08", cubeSnapshotId: 1 });
    await insertDraft(db, "oldest", { date: "2026-01-01", cubeSnapshotId: 1 });
    await insertPickEvent(db, "newest", 10, 1, 1);
    await insertPickEvent(db, "oldest", 40, 1, 1);

    _resetWorthCache();
    const withoutSolo = await getWorthTable({ excludeDraftId: "solo" });
    const geomean = withoutSolo.cards.find((c) => c.card_name === "Alpha")!.geomean!;

    // 'oldest' stays two sessions back: weight 0.5^(2/4) = 0.7071.
    // exp((1*ln(10) + 0.7071*ln(40)) / 1.7071) = 17.76
    // Had it been renumbered to one session back (weight 0.8409) the score
    // would be 18.84, so this distinguishes the two orderings.
    expect(geomean).toBeCloseTo(17.8, 1);
  });
});
```

The two candidate values differ by ~1.1, which `toBeCloseTo(_, 1)` (tolerance
0.05) separates cleanly. If a fixture change narrows that gap, widen the session
spacing until it is discriminating again.

- [ ] **Step 5: Run tests and gates**

Run: `pnpm typecheck && pnpm test src/core/db/queries/stats/worth.test.ts`
Expected: PASS (typecheck may still fail in the three not-yet-migrated sites; that is fine until Task 13).

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/worth.ts src/core/db/queries/stats/worth.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Weight the worth table's pick data by session recency

Ordinals are computed before the leave-one-out exclusion so removing a
single-pod session does not renumber the sessions behind it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Thread sessions into the card stats query

**Files:**
- Modify: `src/core/db/queries/stats/pickStats.ts:84-90, 194-210`
- Test: `src/core/db/queries.test.ts`

**Interfaces:** no public signature change.

Note this query already supports `date_from` / `date_to` / `draft_name` filters. Ordinals are computed over whatever set survives those filters, which is correct: with anchor invariance, only the gaps between the included sessions matter.

- [ ] **Step 1: Select the date**

Change the query at line 85:

```sql
SELECT DISTINCT d.draft_id, d.cube_snapshot_id, d.draft_date
FROM drafts d
JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
WHERE csc.card_id = ? AND ${phaseFragment} ${draftWhere}
```

- [ ] **Step 2: Build the ordinal map**

After `draftIds` is filtered for bans (line 133), add:

```ts
  const sessionsAgo = sessionsAgoByDraft(
    draftsWithCardResult.rows
      .map((row) => ({
        draftId: row.draft_id as string,
        draftDate: row.draft_date as string,
      }))
      .filter((draft) => !bannedInDrafts.has(draft.draftId)),
  );
```

Add the import:

```ts
import { sessionsAgoByDraft } from "../../../draftSessions";
```

- [ ] **Step 3: Pass it into the observations**

In the loop from Task 3:

```ts
    observations.push({
      sessionsAgo: sessionsAgo.get(draftId)!,
      pickPositions: positions,
      poolSize,
    });
```

- [ ] **Step 4: Add two tests**

This block mocks `client.execute` call-by-call with `mockResolvedValueOnce`, so
the order matters. For a card that resolves on the first lookup it is: card
lookup → drafts with card → banned check → cube sizes → picks → opt-outs → deck
cards. Add to the `getCardPickStats` describe block in
`src/core/db/queries.test.ts`:

```ts
  it("weights the more recent session more heavily", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card — two sessions
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", cube_snapshot_id: 1, draft_date: "2026-07-17" },
        { draft_id: "older", cube_snapshot_id: 1, draft_date: "2026-03-08" },
      ])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks of this card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", pick_n: 10, seat: 1 },
        { draft_id: "older", pick_n: 100, seat: 1 },
      ])
    );
    // Opt-outs (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Deck cards (no decklist data)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats(mockClient as never, { card_name: "Test Card" });

    // 'older' is one session back, weight 0.5^(1/4) = 0.8409:
    // exp((1*ln(10) + 0.8409*ln(100)) / 1.8409) = 28.63.
    // Flat weighting would give exp((ln(10) + ln(100)) / 2) = 31.62.
    expect(result?.weighted_geomean).toBeCloseTo(28.6, 1);
  });

  it("counts sessions rather than elapsed time", async () => {
    // Identical to the previous fixture except the older draft is one week
    // back instead of four months. It is still one session back, so the score
    // must be identical — recency decays over drafting, not over the calendar.
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", cube_snapshot_id: 1, draft_date: "2026-07-17" },
        { draft_id: "older", cube_snapshot_id: 1, draft_date: "2026-07-10" },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", pick_n: 10, seat: 1 },
        { draft_id: "older", pick_n: 100, seat: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats(mockClient as never, { card_name: "Test Card" });

    expect(result?.weighted_geomean).toBeCloseTo(28.6, 1);
  });
```

Note `weighted_geomean` is rounded to one decimal by `pickStats.ts:263`, so
`toBeCloseTo(28.6, 1)` is comparing against an already-rounded 28.6.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm typecheck && pnpm test src/core/db/queries.test.ts
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/pickStats.ts src/core/db/queries.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Weight card pick stats by session recency

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Thread sessions into ranked-available

**Files:**
- Modify: `src/core/db/queries/stats/rankedAvailable.ts` (the `draftsResult` query, `cardDrafts` map, and the observation loop)
- Test: `src/core/db/queries/stats/rankedAvailable.test.ts`

**Interfaces:** no public signature change.

Task 5 already restricted this query to completed drafts, so the newest session here is the last completed one — not the draft being ranked.

- [ ] **Step 1: Select the date and widen the map**

Add `d.draft_date` to the `draftsResult` SELECT from Task 5, then change `cardDrafts` from `Map<number, Map<string, number>>` to carry the snapshot and date together:

```ts
  // cardId -> draftId -> { cubeSnapshotId, draftDate }
  const cardDrafts = new Map<number, Map<string, { cubeSnapshotId: number; draftDate: string }>>();
  const draftDates = new Map<string, string>();
  for (const row of draftsResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const draftDate = row.draft_date as string;
    draftDates.set(draftId, draftDate);
    if (!cardDrafts.has(cardId)) cardDrafts.set(cardId, new Map());
    cardDrafts.get(cardId)!.set(draftId, {
      cubeSnapshotId: row.cube_snapshot_id as number,
      draftDate,
    });
  }

  // Ordinals span every draft in play, not just the ones a given card was in.
  // A card that sat out a session must keep the real gap on either side of it.
  const sessionsAgo = sessionsAgoByDraft(
    [...draftDates].map(([draftId, draftDate]) => ({ draftId, draftDate })),
  );
```

That last point is subtler than it looks. Renumbering per card is harmless when the card appears in *consecutive* sessions — that is a uniform shift, and weight normalization cancels it exactly. It goes wrong only when a card **skips** a session: per-card numbering would compress a two-session gap into one and make the older pick count for more than it should. Hence one ordinal map built from all drafts, not one per card.

- [ ] **Step 2: Pass it into the observations**

In the loop from Task 4:

```ts
    for (const [draftId, { cubeSnapshotId }] of drafts) {
      const draftPicks = picks.get(draftId) ?? [];
      timesPicked += draftPicks.length;
      observations.push({
        sessionsAgo: sessionsAgo.get(draftId)!,
        pickPositions: draftPicks,
        poolSize: cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
    }
```

Add the import:

```ts
import { sessionsAgoByDraft } from "../../../draftSessions";
```

- [ ] **Step 3: Add a test**

Same memdb harness as Task 5. The fixture must make the card **skip** a session,
since that is the only case where per-card renumbering changes the answer:

```ts
  it("keeps the real session gap for a card that sat out a session", async () => {
    // Four sessions; Beta is in the cube for sessions 1 and 3 only. Numbering
    // per card would compress that two-session gap to one and overweight the
    // older pick (18.84 instead of 17.76).
    await insertCubeSnapshot(db, 1); // sessions 0 and 2 — no Beta
    await insertCubeSnapshot(db, 2); // sessions 1 and 3 — Beta present
    await insertCard(db, 1, "Alpha");
    await insertCard(db, 2, "Beta");
    await insertCubeCard(db, 1, 1);
    await insertCubeCard(db, 2, 1);
    await insertCubeCard(db, 2, 2);
    await insertDraft(db, "s0", { date: "2026-07-17", cubeSnapshotId: 1 });
    await insertDraft(db, "s1", { date: "2026-05-23", cubeSnapshotId: 2 });
    await insertDraft(db, "s2", { date: "2026-03-30", cubeSnapshotId: 1 });
    await insertDraft(db, "s3", { date: "2026-03-08", cubeSnapshotId: 2 });
    await insertPickEvent(db, "s1", 10, 1, 2);
    await insertPickEvent(db, "s3", 40, 1, 2);

    const result = await rankAvailableCards({
      draft_id: "s0",
      before_pick_n: 500,
    });

    // exp((0.5^(1/4)*ln(10) + 0.5^(3/4)*ln(40)) / (0.8409 + 0.5946)) = 17.76
    const beta = result.cards.find((c) => c.card_name === "Beta")!;
    expect(beta.geomean_pick).toBeCloseTo(17.8, 1);
  });
```

`rankAvailableCards` ranks what is available in draft `s0`, and Beta is not in
`s0`'s cube snapshot — so if this test finds no Beta row, rank against `s1`
instead and adjust the expected value for the shifted anchor before asserting.

- [ ] **Step 4: Run tests and commit**

```bash
pnpm typecheck && pnpm test src/core/db/queries/stats/rankedAvailable.test.ts
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/stats/rankedAvailable.ts src/core/db/queries/stats/rankedAvailable.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Weight ranked-available pick data by session recency

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Thread sessions into the main table

**Files:**
- Modify: `src/core/getCards.ts:427, 420-430, 534-556`
- Modify: `src/core/calculateStats.ts:82-101`
- Test: `src/core/calculateStats.test.ts`, `src/core/getCards.test.ts`

**Interfaces:**
- `calculateCardStats(picks: CardPick[], sessionsAgoByDraftId: Map<string, number>): CardStats[]`
- `assembleCardStats` gains the same map as a parameter and forwards it.

Passing a map rather than adding a date to `CardPick` keeps `CardPick` a record of a pick and leaves the 15 test fixtures that construct one untouched.

- [ ] **Step 1: Update the tests**

In `src/core/calculateStats.test.ts`, the `calculateCardStats` calls need a second argument. Add a helper near the top and use it everywhere:

```ts
/** All picks in one session unless a test says otherwise. */
const oneSession = (picks: CardPick[]) =>
  new Map([...new Set(picks.map((p) => p.draftId))].map((id) => [id, 0]));
```

so existing calls become `calculateCardStats(picks, oneSession(picks))` — every current expectation holds, because a single session means every weight is 1.

Then add a decay test:

```ts
    it("discounts picks from older sessions", () => {
      // pick 10 this session, pick 100 four sessions back:
      // exp((1*ln(10) + 0.5*ln(100)) / 1.5) = 21.5
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 10, draftId: "recent" }),
        createPick({ cardName: "Test", pickPosition: 100, draftId: "older" }),
      ];

      const stats = calculateCardStats(
        picks,
        new Map([["recent", 0], ["older", 4]]),
      );

      expect(stats[0].weightedGeomean).toBeCloseTo(21.5, 1);
    });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/core/calculateStats.test.ts`
Expected: FAIL — `calculateCardStats` takes one argument.

- [ ] **Step 3: Thread the map through**

In `calculateStats.ts`, add the parameter to both functions and use it:

```ts
function calculateSingleCardStats(
  cardName: string,
  cardPicks: CardPick[],
  sessionsAgoByDraftId: Map<string, number>,
): CardStats {
```

and in the observation loop:

```ts
  for (const [draftId, draftPicks] of picksByDraft) {
    const taken = draftPicks
      .filter((pick) => pick.wasPicked)
      .sort((a, b) => a.copyNumber - b.copyNumber);
    const untaken = draftPicks.find((pick) => !pick.wasPicked);
    observations.push({
      sessionsAgo: sessionsAgoByDraftId.get(draftId) ?? 0,
      pickPositions: taken.map((pick) => pick.pickPosition),
      poolSize: untaken?.pickPosition ?? 0,
    });
  }
```

`groupBy(cardPicks, (pick) => pick.draftId)` already keys by draft id, so the loop destructures the key directly.

- [ ] **Step 4: Build the map in getCards**

In `getCards.ts`, after `selectedDraftIds` is computed (line ~504), add:

```ts
  // Ordinals span the selected drafts only: with a draft filter applied, the
  // newest selected session is the reference point.
  const sessionsAgo = sessionsAgoByDraft(
    selectedDraftIds.map((draftId) => ({
      draftId,
      draftDate: draftMetadataMap.get(draftId)!.date,
    })),
  );
```

Add the import and pass it through `assembleCardStats` (line ~552) to `calculateCardStats` (line 427).

- [ ] **Step 5: Run to verify passing**

Run: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`
Expected: all PASS. This is the task where the whole tree typechecks again.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/calculateStats.ts src/core/calculateStats.test.ts src/core/getCards.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Weight the main table's pick data by session recency

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Re-measure and re-pin the worth model's validation gate

**Files:**
- Modify: `scripts/worth-validate.ts` (the pinned gate value only)

The worth model fits on `ln(geomean)`. Phase B changes every geomean, so the model re-fits and the pinned leave-one-draft-out gate — measured against the old scores — is now meaningless.

- [ ] **Step 1: Record the pre-change gate**

```bash
grep -n "PINNED\|recommendedGate\|observedPooledRho" /Users/arpanet/code/read-the-bones/scripts/worth-validate.ts
```
Note the currently pinned value before touching anything.

- [ ] **Step 2: Re-run validation**

Run: `pnpm worth:validate`

This is a measurement run and always exits 0. Read the reported pooled rho and the "recommended pinned gate (measured - 0.1)" line.

- [ ] **Step 3: Decide whether the model still holds up**

If the new pooled rho is **at or above** the old one, the recency weighting did not hurt the model's ability to predict wins — re-pin to the new recommendation.

If it dropped **materially** (more than the 0.1 gate margin), stop and report. That would be evidence that a half-life of 4 sessions is discarding signal, and the right response is to reconsider the half-life, not to lower the gate to accommodate it.

- [ ] **Step 4: Update the pin and commit**

```bash
pnpm test
git -C /Users/arpanet/code/read-the-bones add scripts/worth-validate.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Re-pin the LODO gate against recency-weighted scores

The worth model fits on ln(geomean), so it re-fit when the scores changed;
the old pin was measured against numbers that no longer exist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Documentation

**Files:**
- Modify: `CLAUDE.md` (the "Terminology: Picks vs Rounds" section)
- Modify: `src/app/components/HowItWorks.tsx`
- Modify: `docs/plans/2026-01-08-card-rankings-design.md`

- [ ] **Step 1: Update CLAUDE.md**

Replace the closing line of the Terminology section — currently `The UI displays "Pick Score" which is the weighted geometric mean of pick positions across drafts.` — with:

```markdown
The UI displays "Pick Score" (P#): the weighted geometric mean of pick positions
across drafts, computed by `src/core/pickScore.ts`. Three factors set an
observation's weight — copy number (`0.5^(copy-1)`), whether anyone took it
(`0.5` if not), and how many drafting sessions ago the draft ran
(`0.5^(sessionsAgo/4)`).

Drafts sharing a `draft_date` are one **session** — parallel pods are a single
drafting occasion. Recency decays over sessions rather than days because what
moves card evaluations is drafting and playing, not the calendar. Because the
geometric mean normalizes by total weight, P# is unchanged by time passing; it
moves only when a new session lands.
```

Also update the **Unpicked penalty** bullet, which currently describes the old per-copy convention:

```markdown
- **Unpicked penalty**: A draft in which *no* copy was taken contributes one
  half-weight observation at pickPosition = poolSize (540). A draft that took at
  least one copy contributes only the copies it took — a leftover copy of a
  qty-2 card means demand was not two deep, not that the card went unwanted.
```

- [ ] **Step 2: Update HowItWorks.tsx**

Read the component first and match its existing prose voice and JSX structure. The copy must state that recent drafts count more, that a session is a date rather than a pod, and that the score does not drift with time. Per `457f017` ("Correct How it works claims") and `01c2661` ("Remove em dashes from How it works copy"), this copy is held to accuracy and has no em dashes — respect both.

- [ ] **Step 3: Update the card-rankings design doc**

`docs/plans/2026-01-08-card-rankings-design.md` documents the original two-factor weighting. Add a dated note recording the two changes and pointing at this plan, rather than rewriting history:

```markdown
## 2026-08-07 update

The weight gained a third factor, `0.5^(sessionsAgo/4)`, and the unpicked
penalty now applies only when a draft took no copy at all. All four call sites
were consolidated into `src/core/pickScore.ts`. See
`docs/superpowers/plans/2026-08-07-recency-weighted-pick-score.md`.
```

- [ ] **Step 4: Full gates and commit**

```bash
pnpm typecheck && pnpm lint && pnpm knip && pnpm test && pnpm test:e2e
git -C /Users/arpanet/code/read-the-bones add CLAUDE.md src/app/components/HowItWorks.tsx docs/plans/2026-01-08-card-rankings-design.md
git -C /Users/arpanet/code/read-the-bones commit -m "Document session-weighted pick scoring

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Deploying

The main page is statically prerendered, so none of this reaches the site until a rebuild:

```bash
vercel --prod
```

Do this only when the user asks. Every P# on the deployed table changes, so it should be a deliberate publish.

## Reference: measured effects (2026-08-07)

Session weights across the 10 stats-eligible sessions at H=4:

| sessions ago | date | pods | weight |
|---|---|---|---|
| 0 | 2026-07-17 | 5 | 1.000 |
| 1 | 2026-05-23 | 2 | 0.841 |
| 2 | 2026-03-30 | 3 | 0.707 |
| 3 | 2026-03-23 | 2 | 0.595 |
| 4 | 2026-03-08 | 5 | 0.500 |
| 5 | 2026-01-08 | 1 | 0.420 |
| 6 | 2026-01-01 | 1 | 0.354 |
| 7 | 2025-12-15 | 1 | 0.297 |
| 8 | 2025-12-01 | 5 | 0.250 |
| 9 | 2025-10-01 | 2 | 0.210 |

Median effective sample size falls from 25.2 to 20.5. The median card moves 8 ranks of 515, p90 31, max 74. Largest movers, flat → H=4:

| card | rank | P# |
|---|---|---|
| Fell | 368 → 442 | 319.2 → 370.6 |
| Temporal Manipulation | 299 → 372 | 287.9 → 322.6 |
| Korvold, Fae-Cursed King | 353 → 281 | 310.7 → 276.4 |
| Cloud, Midgar Mercenary | 261 → 326 | 266.7 → 300.4 |
| Mischievous Mystic | 365 → 300 | 317.6 → 290.6 |
| Dark Ritual | 145 → 207 | 182.5 → 229.8 |

Analysis scripts are in the session scratchpad at
`/tmp/claude-1000/-Users-arpanet-code/dea9820d-5f34-4f25-b25f-14d1db89b44f/scratchpad/`
(`session-analysis.ts`, `live-contamination.ts`). They read Turso directly and are
throwaway measurement tools, not part of the repo.
