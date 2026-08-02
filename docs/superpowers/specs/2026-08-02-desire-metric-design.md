# Desire Metric and Zero-Prior Worth — Design

**Date:** 2026-08-02
**Status:** Approved (brainstormed in-session 2026-08-02; user approved all
four design forks)
**Amends:** `2026-08-01-card-worth-model-design.md`

## Problem

The 2026-08-01 worth model shrinks a card's ΔWR toward the price curve
`E[ΔWR|geo]`. Measured against the model's own fit, the price curve explains
only **~5% of true card-quality variance** (b²·Var(lnGeo) / (b²·Var(lnGeo)
+ τ²) = 4.8% on 2026-08-02 data), yet the shrinkage gives it 30–50% of the
blend weight at typical sample sizes (w = 0.59 at 300 games). Worth therefore
answers "what is my best posterior estimate of this card's ΔWR given the
market's opinion" — a quality estimate contaminated by a weak prior — when
the question the user wants answered is "how badly should I want this card
with this pick," which is a function of quality **and** scarcity.

Concrete failure: Swords to Plowshares (geo 2.2, 45.4% WR over 361 games)
shows worth −1.30% when its zero-prior shrunk delta is −2.29%; the price
prior launders the market's overvaluation back into the quality estimate.

## Decisions (user-approved 2026-08-02)

1. **q replaces worth everywhere.** The `worth` field keeps its name and API
   shape (avoids MCP/skill ripple) but is redefined as the **zero-prior**
   shrunk delta. The price-prior blend is gone from the quality number.
2. **Prior-only fallback stays on the price curve.** Cards below
   `WORTH_MIN_GAMES` keep `worth = E[ΔWR|geo]` with `prior_only: true`. The
   market's opinion is weak but it is the only information about unplayed
   cards; a geo-15 unknown is probably not a 0.
3. **Desire renders as modal curve + row sparkline** (both dev-gated).
   *(Revised after user testing, 2026-08-02: sparklines removed — at row
   size every curve looked alike; the modal chart carries the shape. The
   column header is "Desire (n)" with n = the evaluation pick; the modal
   chart gains a dotted pick-score (geomean) reference line. The modal's
   act-by row and the τ₀/σ/κ footnote were removed as noise.)*
   *(Second revision, same day: desire DISPLAYS as an index in [−100, 100]:
   `100 × desire / max|worth|` over the table. Since |desire| ≤ |worth| ≤
   max|worth|, the bounds hold by construction; ±100 = the cube's strongest
   quality signal fully on the line, comparable across picks. Rows whose
   index rounds to 0 show "—" — remote danger means nothing is on the line,
   and hundreds of zero rows are noise. UI display only: `pick_value` and
   all API fields remain in raw WR points.)*
4. **Fixed horizon h = 20** (one snake turn at 10 seats, matches
   `ACT_BY_HORIZON`). No seat-aware horizon in the table; the ranked
   endpoint keeps its seat-aware horizon for recommendations.

## The metrics

### q — quality (redefined `worth`)

`q = w·ΔWR` where `w = τ₀²/(τ₀² + SE²)` and **τ₀ is estimated around the
zero prior**: `τ₀² = mean(ΔWR² − SE²)` over fitted cards, floored at 0.
(The old τ measured spread around the price curve; a zero-mean prior must
use total spread around zero or the shrinkage is inconsistent. τ₀ > τ,
slightly: the price-explained slice moves into the prior variance.)

- ΔWR stays delta vs color baseline (mean of colorWR over color identity,
  colorless = 0.500) — quality is always relative to color context.
- PVI is **unchanged**: still `(ΔWR − E[ΔWR|geo])/SE`, still the market
  mispricing signal. The price curve remains fitted for PVI, `expected`,
  and the prior-only fallback.
- The model fit output carries both `tau` (price-curve residual spread,
  diagnostic) and `tau0` (zero-prior spread, drives q's weights).

### desire(n) — state-dependent demand

`desire(n) = q × overdueDanger(n, h=20, geo)` where
**`overdueDanger = max(danger, F(n))`** — danger floored at the probability
the card should already be gone (redefined 2026-08-02, user decision; was
raw conditional danger). Rationale: the conditional hazard reads long
survival as evidence a card will keep wheeling ("nobody wants it"), which
discounts stranded good cards exactly when they should scream — and "it
wheeled twice, it'll wheel again" loses good cards in real drafts. With the
floor, desire matches the intended semantic: a signed −100↔+100 scale from
"do not touch under any circumstances" to "how is this still here, grab it
now." Early in a card's window F(n) ≈ 0, so the pick-1 priority board is
unchanged; curves become monotone (rise through the window, pin at the
worth cap) instead of sagging in the tail.

**Wheel-inference audit (2026-08-02):** overdueDanger now feeds `desireAt`
(UI), `pick_value`/`first_pick_score` on the ranked endpoint (and thus MCP
recommendations), `act_by` (now capped at ~geomean: an overdue card is
never "safe to wait on"), and the validation script's P1 diagnostic. Raw
`danger()` remains exported for pure-hazard uses. `pair_supply` was audited
and left alone: it uses *unconditional* survival for future slots
(prospective planning, conservative, no wheel inference). The skill's
"denial and wheeling" guidance is the one sanctioned wheel bet — a
named-opponent read, never a statistical default. LODO gate unaffected
(seat scores are worth sums; danger does not enter).

Properties (all confirmed against the 2026-08-02 fit, σ = 0.53):

- At n = 1, cards with geo ≳ 50–60 have desire ≈ 0: the no-draft table
  reads as a **draft-start priority board**.
- As a live draft approaches a card's geomean, its desire wakes up
  (Keen-Eyed Curator, geo 304: ~0 at pick 1, material by ~250).
- Negative-q cards get negative desire scaled by danger — Swords reads
  strongly negative early ("let it go") and, under the overdue floor, stays
  pinned at "do not touch" for as long as he is somehow still available.
- The old known artifact (conditional hazard sagging far past geomean —
  "the room passed judgment") is **resolved by the overdue floor**: desire
  is now monotone non-decreasing in n, pinning at the worth cap once the
  card is overdue.
- **Curve truncation (display decision, 2026-08-02):** rendered curves end
  where survival drops below 0.1% (initially 1%; loosened same day). Past
  that point the "if still available" hypothetical essentially never
  occurs, so the line stops — pinned at its worth cap under the overdue
  floor. Ending the line makes its length the signal: a stub = the card's
  window is the first few picks. The desire *value* at the current pick is
  never truncated — a card actually still available past the cutoff shows
  full-strength desire (the floor guarantees it), which is exactly the
  "how is this still here, grab it now" reading.

### Current-pick semantics for the column

- Active draft selected and in progress → n = current pick (picks made + 1).
- No draft selected, or draft complete → **n = 1** (draft-start view).
- **Settings override (dev-only, added 2026-08-02):** a "Set pick to" field
  in the settings menu (localhost section) pins n explicitly, winning over
  both cases above; empty = automatic. Session state in cardStore
  (`desirePickOverride`), not persisted.
- desire is closed-form from (q, geo, σ, h): computed **client-side** at
  render, no API payload change beyond what `/api/cards/worth` already
  returns. Sparklines evaluate the same function over the pick domain
  (1..total picks of the active draft, default 450); the table is
  virtualized so only visible rows compute.

## Ripple

- `pick_value = worth × danger` and `first_pick_score` on the ranked
  endpoint inherit q automatically once `worth` is redefined (intended —
  option 1 explicitly covers the ranked endpoint and MCP).
- Lands: q inherits the `is_land` unreliability flag; desire for lands is
  equally unreliable, marked via the cell's hover title ("land
  (unreliable)"), and lands are excluded from the desire-index denominator.
- GPWR column: q covers its job (sortable, sample-size-honest, color-
  relative), so the CardTable GPWR column is **removed** in this change
  (user decision 2026-08-02). Raw WR/CI stays in the stats modal — the
  uncompressed evidence belongs there — and the `gpwr` fields keep feeding
  the modal and deck builder.
- **Table width:** the dev-only column set (GPWR, worth/q, PVI, desire +
  sparkline) is cramped at the production layout width. When dev columns
  render (localhost), the card-table container widens to fit them; the
  production layout is untouched.
- **LODO revalidation (measured 2026-08-02).** Both the shrinkage target
  and the seat score input changed, voiding the 2026-08-01 gate. Rerun
  result: pooled within-draft ρ = **0.1707**, permutation p = **0.0065**
  (2000 iters, seed 42), 27 drafts, 266 seats, no coverage exclusions.
  New pinned gate: **0.0707** (measured − 0.1) on the same draft set.
  The open question resolved: the zero-prior model validates slightly
  *worse* than the price-prior one (ρ 0.171 vs 0.189) — the price prior
  carried a little real predictive signal. Accepted trade: marginally
  weaker seat-level prediction for a quality metric the market's opinion
  cannot contaminate (the model's purpose is per-card judgment, not seat
  forecasting).

## Non-goals

- No per-card σ (pooled, as before).
- No modeling of live-draft market deviation (rival interest in a sleeper).
- No production exposure (same NODE_ENV gating as the rest of the model).
- No pick slider in the static table (n = 1 is the static view).
