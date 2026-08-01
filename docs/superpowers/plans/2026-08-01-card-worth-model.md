# Card Worth Model — Implementation Plan

**Date:** 2026-08-01
**Spec:** `docs/superpowers/specs/2026-08-01-card-worth-model-design.md`
**Branches:** `worth-model` in both `read-the-bones` and `rtb-mcp-server`.

## Shared contracts (agents implement against these, do not drift)

```ts
// src/core/worthModel.ts (pure, no I/O)
export interface WorthModelFit {
  a: number; b: number;            // E[dWR|geo] = a + b*ln(geo)
  tau: number;                     // card-quality spread
  sigma: number;                   // ln-pick spread
  tauA: number;                    // pair-edge spread (DerSimonian-Laird)
  grandMean: number;               // precision-weighted pair WR mean
  kappa: number;                   // commitment policy parameter (0.5)
  baselines: Record<string, number>;   // W/U/B/R/G color WRs
  pairEdges: Record<string, number>;   // "UR" -> shrunk edge (centered)
}
export interface WorthCard {
  card_name: string;
  colors: string;                  // "" = colorless, else subset of WUBRG
  is_land: boolean;
  in_current_cube: boolean;
  geomean: number | null;
  games: number; wins: number; losses: number;
  wr: number | null; se: number | null;
  delta: number | null; expected: number | null;
  pvi: number | null;
  worth: number | null;            // prior-only value when prior_only
  prior_only: boolean; no_data: boolean;
  act_by: number | null;           // null = never crosses 0.5 (or no geomean)
}
```

Key pure functions in `worthModel.ts` (all exported, all unit-tested):
`fitPriceCurve(pts: {lnGeo, delta, se}[]): {a, b}` (WLS, weights 1/se²);
`estimateTau(resids: {resid, se}[]): number` (MoM, floored at 0);
`estimateTauDL(items: {delta, se}[]): {tauA, grandMean}`;
`shrinkWorth(delta, expected, tau, se): {worth, w}`;
`normalCdf(x)`; `pickCdf(x, geo, sigma)`;
`danger(n, h, geo, sigma)`; `actBy(geo, h, sigma)` (scan n=1..459, first ≥0.5);
`colorFlag(colors, pairEdges, state, kappa)` with
`state: {committed: string}` ("" | one letter | two letters); 3+ color
identities fall back to pairs intersecting the identity; colorless → 0;
`pairSupply(cards: {worth, geo}[], slots: number[], fromPick, sigma): number`
(deterministic greedy on survival probabilities `1 − F(n)`, counts cards with
expected survival ≥ 0.5 at assignment, positive-worth cards only).

In `src/core/snakeDraft.ts` add:
`picksUntilNextTurn(currentPickN: number, seat: number, opts: DerivePickSeatOptions): number | null`
(iterate `derivePickSeat` forward from currentPickN; null when seat never
picks again). Reuses existing double-pick logic; do not duplicate it.

`/api/cards/worth` response:
`{ cards: WorthCard[], model: { a, b, tau, sigma, tau_a, kappa, baselines, pair_edges, cards_fit, computed_at } }`
(model keys snake_case at the API boundary, camelCase internally.)

Ranked-route additions (dev-only): per-row `worth, danger, pick_value` always
when enabled; `color_flag, first_pick_score` when `committed_colors` param
present; top-level `horizon` and `pair_supply: Record<pair, number>`.

## read-the-bones tasks

**A1 — model core (blocking everything else in repo 1):**
`src/core/worthModel.ts` + `worthModel.test.ts`; `picksUntilNextTurn` in
`src/core/snakeDraft.ts` + tests alongside existing snakeDraft tests.
Synthetic-fixture tests: WLS recovers known coefficients; DL matches
hand-computed two-group case; danger monotone in n up to geo, act_by
consistent with danger; colorFlag state matrix (uncommitted/one/two,
colorless, 3+ colors); pairSupply on tiny fixtures.

**A2 — data assembly:** `src/core/db/queries/stats/worth.ts` +
`worth.test.ts` (memdb style, `vi.mock("../../client")`, helpers from
`src/core/db/__tests__/testDb.ts`). Assemble per-card aggregates across
drafts passing `statsPhaseFilter` (NOTE: unlike `rankedAvailable.ts`, which
leaks in-progress drafts — do not copy that part). Reuse:
`calculatePickWeight`/`weightedGeometricMean` for geomean with unpicked
penalty; the `deck_cards`×`match_events` join shape from `rankedAvailable.ts`
for wins; `parseScryfallJson` for color identity; type_line for `is_land`;
`inferSeatColors`-based color/pair WRs (same approach as
`getDraftStats.ts`). σ from picked `pick_events` residuals. Cache: module-
level memo keyed by `computeIngestionHash` over stats-phase drafts' domain
hashes; export `_resetWorthCache()` for tests (cardStore precedent).
`in_current_cube` = membership in the latest draft's cube snapshot.
Barrel-export from `stats/index.ts` (knip will flag unused exports — export
only what routes/tests use).

**A3 — worth route:** `src/app/api/cards/worth/route.ts` + test. Gate:
`process.env.NODE_ENV !== "production"` else 404 (comment pattern from
`src/app/api/cards/route.ts:4-7`). `withApiErrors`, no cache header
(dev-only). Route test per `route.test.ts` conventions (namespace mock,
NODE_ENV branch assertions like `api/cards/route.test.ts:71-80`).

**A4 — ranked extensions:** `rankedAvailable.ts` params gain
`seat?, committed_colors?, sort_by: +"pick_value" | "first_pick_score"`;
route parses them (validate `committed_colors` ⊆ WUBRG, ≤2 chars, else 400).
Horizon: `picksUntilNextTurn` with draft meta (`numSeats`,
`picksPerPlayer`, `doublePickAfterRound` via `getDraftMeta`); default
`2 × numSeats` without `seat`. New fields dev-gated at the route
(`includeWorth` flag param into the query, same shape as `includeWinStats`).
Route + query tests.

**A5 — UI (minimal, dev-only):** Worth + PVI columns in `CardTable.tsx`
via the existing `isLocalClient()` conditional-spread pattern
(`CardTable.tsx:193-215`); data fetched client-side from `/api/cards/worth`
in `cardStore` with the `ingestionHash`-keyed cache convention
(`cardStore.ts:68-77`). A "Worth model" block in the card stats modal
(worth, PVI, act_by, games, CI). Store tests stub `isLocalClient` false as
existing tests do.

**A6 — validation script:** `scripts/worth-validate.ts` (+ package.json
`worth:validate`). LODO refit excluding each draft; per-seat top-23 worth
sum vs match wins; within-draft permutation only; coverage report with <60%
exclusion; coverage-vs-wins check; ungated P1 diagnostic; prints measured ρ
and a recommended pinned gate (measured − 0.10) plus the draft-id set. Reads
via the query layer directly (tsx, dotenv) — not HTTP.

## rtb-mcp-server tasks

**B1 — client timeout:** `apiGet(path, params, opts?: {timeoutMs?})`;
default stays 15_000; error message uses the effective value.
**B2 — tools:** new `get_worth_table` route tool (`/api/cards/worth`,
transform: sort by |worth| desc optional `sort_by`, `limit` default 50,
strip nothing else); `rank_available_cards` schema gains `seat`,
`committed_colors`, extended `sort_by`; both pass
`{timeoutMs: 45_000}`.
**B3 — tests:** `routeCases` entries + transform tests (node:test style,
runs against dist).

## Skill task

**C — `rtb-mcp-server/skill/SKILL.md`:** replace the Pick-Priority Index
formula with the worth-model flow (`rank_available_cards` with
`sort_by=pick_value` / `first_pick_score` + fit/threat judgment layer);
startup fetches `get_worth_table`; add trust-boundary and tiebreaker
language per spec §5; keep threat/table-read/snake-sequencing guidance.

## Sequencing

1. A1 first (contracts). Then A2. Then A3, A4, A6 in parallel. A5 after A3.
2. B and C run parallel to A-track (contracts fixed above).
3. Final: `pnpm precommit`-equivalent in repo 1 (typecheck, lint, knip,
   test; e2e only if touched surfaces demand), `npm test` in repo 2, live
   smoke against dev server, `pnpm worth:validate` run once, commits on
   both branches.
