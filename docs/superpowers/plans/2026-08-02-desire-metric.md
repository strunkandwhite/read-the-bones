# Desire Metric and Zero-Prior Worth — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-02-desire-metric-design.md`

## Task A — Core model (`src/core/worthModel.ts`)

1. `estimateTau0(cards)`: `τ₀² = mean(ΔWR² − SE²)` over fitted cards,
   floored at 0. Sits beside `estimateTau` (which stays, for diagnostics).
2. `shrinkQuality(delta, se, tau0)`: `w = τ₀²/(τ₀²+SE²)`, returns `w·delta`.
   `shrinkWorth` (price-prior) is removed with its callers — grep confirms
   the query layer is the only consumer.
3. `desire(n, h, geo, sigma, q)`: `q × danger(n, h, geo, sigma)` reusing the
   existing danger/normal-CDF helpers. Exported for client-side curve use.
4. `WorthModelFit` gains `tau0`.
5. Tests: τ₀ recovery on synthetic mixtures (known τ₀, zero-mean);
   shrinkage weight edge cases (SE→0, SE→∞); desire monotonicity in q,
   sign preservation for negative q, desire(n)≈0 for geo ≫ n at h=20;
   curve values against hand-computed Φ fixtures.

## Task B — Query layer + routes

1. `src/core/db/queries/stats/worth.ts`: compute `worth` via
   `shrinkQuality`; prior-only path unchanged (`E[ΔWR|geo]`,
   `prior_only: true`); emit `tau0` in the model block.
2. `rankedAvailable.ts` / ranked route: no formula edits needed —
   `pick_value`/`first_pick_score` consume `worth` and inherit q. Verify
   by test, not assumption.
3. Update tests: worth.test.ts fixtures re-derived for zero-prior numbers;
   ranked tests likewise; route tests for `tau0` presence.

## Task C — CardTable (desire column + sparkline)

1. Shared client util (e.g. `src/app/components/desireCurve.ts`): evaluates
   desire(n) over a pick domain from (q, geo, σ, h=20), importing the pure
   core function.
2. Current-pick source: active in-progress draft → picks made + 1; else 1.
3. Dev-gated `Desire` column: value + inline SVG sparkline (domain 1..total
   picks, default 450). Land rows get the same unreliability dimming as
   worth. Sortable by desire at the current pick.
4. Widen the table container when dev columns render (localhost only).
5. Load the dataviz skill before writing sparkline/chart code.
6. Tests: column gating, current-pick fallback to 1, sort order.

## Task D — CardStatsModal (desire curve)

1. Full-size labeled desire-vs-pick curve in the worth-model section,
   sharing `desireCurve.ts`. Mark the current pick if a draft is active.
2. Update the metric-definition tooltips (added 60e23ce) for the redefined
   worth/q and the new desire.
3. Tests: curve renders with model params present, absent without.

## Task E — Validation + quality gates

1. `scripts/worth-validate.ts`: seat scores use redefined worth (no code
   change if it reads `worth` — verify). Run `pnpm worth:validate`; record
   new pooled ρ, p, recommended gate; compare against price-prior ρ 0.19.
   Re-pin gate + draft set in the spec and memory.
2. `pnpm typecheck && pnpm lint && pnpm test`. knip + precommit deferred to
   host (darwin-only bindings — memory note), flagged before any push.

## Order

A → B → E1 (validation early — if zero-prior LODO collapses, the UI work
still proceeds but the finding goes to the user before merge) → C → D → E2.
