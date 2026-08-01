# Card Worth Model (Worth, PVI, Danger) — Design

**Date:** 2026-08-01
**Status:** Approved (formulation reviewed adversarially in-session; user
approved the build 2026-08-01)

## Problem

The app measures two things about a card separately: market demand (geomean
pick) and raw deck win rate. Neither answers the questions that matter during
a draft: *how good is this card, actually?* and *what should I pick right
now?* A 2026-08-01 analysis session derived a principled model connecting
them — but it lives in throwaway Python, refits constants by hand, and reads
CIs back into standard errors approximately. It needs to be productized:
computed server-side from live data, exposed through the API and MCP tools,
and consumed by the mtg-roto-draft skill.

## Goals

- A pure, unit-tested core module computing the full model: color baselines →
  ΔWR → price curve → PVI → shrinkage (Worth) → pick-position spread →
  danger curves and act-by picks.
- All model parameters (curve coefficients, τ, σ, baselines) recomputed from
  data on demand and returned in API responses — nothing hardcoded.
- A "recommend next picks" capability: given a draft, current pick, and the
  seat's next-pick horizon, rank available cards by Worth × danger.
- MCP tools exposing both the full worth table and the recommendation query.
- Dev-only exposure in the web UI (same gating as decklist win rate).
- Skill update: replace the hand-tuned Pick-Priority Index formula with the
  model, keeping fit/threat judgment in the skill layer.

## Non-goals

- Production/public UI exposure (localhost only, like decklist win rate).
- Per-card pick-position spread (one pooled σ in v1).
- Modeling opponent adaptation (the model assumes the table drafts like the
  historical market; equilibrium effects are the skill's problem).
- Automating deck-fit or synergy scoring — that judgment stays in the skill.
- Backtesting tooling or historical what-if UI.

## The model

All win rates are game-level. Let a card's observed deck win rate be `WR`
over `n = wins + losses` games (seats that maindecked it, completed drafts
only), with exact standard error `SE = sqrt(WR·(1−WR)/n)` computed from
counts — not recovered from Wilson CI widths.

1. **Color baseline.** `base(card) = mean(colorWR(c) for c in colorIdentity)`,
   where `colorWR` is the win rate of all decks containing that color.
   Colorless cards use 0.500. ΔWR = WR − base.
2. **Price curve.** Weighted least squares over eligible cards (completed
   drafts, `n ≥ MIN_GAMES`, non-land):
   `E[ΔWR | geo] = a + b·ln(geo)`, weights `1/SE²`.
   (2026-08-01 fit: a = +2.55%, b = −0.70% per ln-pick; recomputed live.)
3. **PVI** (pick value index): `(ΔWR − E[ΔWR|geo]) / SE` — over/under-delivery
   versus the price paid, in standard errors.
4. **Worth** (posterior card quality, in WR points): shrink the observation
   toward the price prior. `τ² = mean(residual² − SE²)` (method of moments,
   floored at 0), `w = τ²/(τ² + SE²)`,
   `Worth = w·ΔWR + (1−w)·E[ΔWR|geo]`.
   (2026-08-01: τ ≈ 3.5%.)
5. **Danger.** Pick positions are modeled lognormal around geomean with
   pooled σ = sd of `ln(pickPosition) − ln(geomeanOfPicked)` over all picked
   pick-history events. (2026-08-01: σ ≈ 0.51.)
   `danger(n, h, geo) = [F(n+h) − F(n)] / [1 − F(n)]` where
   `F(x) = Φ((ln x − ln geo)/σ)` — the probability the card is taken within
   the next `h` picks given it is still available at pick `n`.
   `act_by(geo, h)` = smallest n where danger ≥ 0.5, or null if never.
6. **Pick value score.** `score = Worth × danger(n, h, geo)` — the expected
   WR value lost by passing now. This is the recommendation ranking.
7. **Pair edge** (archetype quality): for each two-color pair P, the shrunk
   realized deck win rate. `pair_edge(P) = s_P·(WR_P − m) + m − 0.5` where m
   is the precision-weighted grand mean across pairs, `s_P = τ_a²/(τ_a² +
   SE_P²)`, and τ_a is estimated by DerSimonian–Laird (NOT unweighted method
   of moments — small-n pairs' −SE² terms otherwise crush τ_a; observed:
   DL τ_a ≈ 1.87% vs 0.53% unweighted). Centering note: `color_flag` below
   is a difference of maxes over pair_edge, so the centering constant
   cancels — grand-mean vs 0.5 affects displayed edges, never scores. Do
   not "fix" the centering expecting recommendation changes.
   (2026-08-01: UR +2.71%, BR +1.94%, UG +1.25% … WU −0.04%, BG −0.63%.)
8. **Color flag** (commitment cost, state-dependent):
   - `uncommitted`: `color_flag(card) = κ₁ · [max_{P ∩ colors(card) ≠ ∅,
     with P ⊇ colors(card) when |colors| ≤ 2} pair_edge(P) − max_P
     pair_edge(P)]` — always ≤ 0; colorless cards → 0; 3+ color identities
     fall back to pairs intersecting the identity.
   - `one color L locked`: same, restricted to pairs containing L.
   - `pair locked`: 0.
   κ₁ = 0.5 is a policy parameter (the marginal commitment estimate:
   P(final pair ∋ C | early pick of C) − base rate ≈ 0.94 − 0.4), returned
   in the API response, halving for each subsequent uncommitted pick.
9. **First pick score**: `first_pick_score = worth × danger + color_flag`.
   Applies to any pick made while colors are uncommitted, not just P1 —
   name kept for familiarity, documented as such. Components are
   commensurate (each spans roughly ±3%). The flag term's whole spread is
   ~0 to −1%: consumers (especially the skill) must present it as a
   tiebreaker between comparable cards, never a reason to pass a clearly
   better card.
10. **Pair supply**: `pair_supply(P, n)` — deterministic expected count of
    positive-Worth cards with identity ⊆ P (plus colorless) obtainable from
    pick n onward at the seat's slots, computed by greedy assignment on
    survival probabilities `1 − F(n)`. A supply/urgency signal ("B dries up
    by pick 60; W keeps until 200") — explicitly NOT a deck-quality
    prediction, and labeled as such in API responses.

### Rejected: Worth-sum pipelines (recorded rationale)

An earlier formulation valued color commitment by the expected *sum of
Worth* harvestable from a color/pair ("pipeline"). Empirical validation
rejected it: pipeline values anti-correlate with realized archetype win
rates (deepest pipelines WG/WU realize 50.0%/48.6%; shallowest UR/BR
realize 56.5%/55.6%). Three compounding biases: winner's-curse selection
(greedy max over noisy Worth), the deck-quality confound concentrated in
late-geo sleepers, and archetype double-counting (summing 12 white-aggro
sleepers counts the same edge 12×). Sum-of-Worth is a value-pile model of
deck quality, and value piles demonstrably lose this cube. Hence
`pair_edge` (realized, shrunk) as the flag quantity and `pair_supply`
(counts, not sums) as the demoted supply signal.

### Scope split: fits vs live-market evaluation

- The **fits** — price curve (a, b), τ, σ, pair_edge, color baselines — use
  ALL cards with pick history across completed drafts.
- The **live-market metrics** — danger, act_by, pair_supply, pick_value —
  evaluate over current-cube cards only, since they model the live market.
- The worth table is computed for all cards with history; the current-cube
  view is a filter, not the computation boundary.

### Empirical constants (2026-08-01 session, recomputed live in app)

Commitment curve: 94% of round-1 picks end in the seat's final top-2
colors (declining to ~76% by round 45). Marginal commitment ≈ 0.5.
Seat-level validation: Spearman ρ = +0.444 (p < 0.0005, n = 208 seats)
between sum of top-23 pick Worths and final match wins (in-sample).

### Data hygiene rules

- **Completed drafts only** feed the fit (`isCompletedForStats`); in-progress
  pods contribute no games or picks to the model.
- **Lands are excluded from the curve/τ/σ fits and flagged** (`is_land: true`)
  in output. Their ΔWR is archetype noise (fetches graded as "traps" in the
  session analysis); they still get a Worth number but consumers must treat
  it as unreliable.
- **Self-inclusion:** a card's own decks are part of its color baseline. This
  biases ΔWR toward zero (conservative); accepted in v1, documented in the
  API response.
- **No-data cards** (new cube additions, or `n < MIN_GAMES`): `worth` is
  returned as the prior `E[ΔWR|geo]` with `prior_only: true` when geomean
  exists, or null with `no_data: true` when the card has never been in a
  pool. Never silently zero.
- **Multi-copy cards** share a single entry keyed by normalized card name
  (existing suffix-stripping normalization).

## Design

### 1. Core module

- `src/core/worthModel.ts` — pure math, no I/O: WLS fit, τ estimation,
  shrinkage, lognormal danger/act-by, normal CDF. Fully unit-tested against
  synthetic fixtures with known answers.
- `src/core/db/queries/stats/worth.ts` — data assembly: pulls per-card
  aggregates (games, wins, geomean, color identity, type line) across
  completed drafts, calls the pure model, returns the table + parameters.

### 2. Caching

The 600-card ranked query already takes ~29s cold on the dev server and blows
the MCP client's 15s timeout; the worth table is strictly more work. The
assembled table is memoized in-module, keyed by the set of completed draft
ids plus each one's last-synced hash (already tracked by the sync pipeline).
Warm requests serve from memory (<100ms); the cache invalidates when a draft
completes or a reset/resync changes a hash. No persistence — dev-server
restarts just recompute once.

### 3. API

- **`GET /api/cards/worth`** — the full model output: per-card
  `{ card_name, colors, is_land, geomean, games, wr, se, delta, expected,
  pvi, worth, prior_only, no_data, act_by }` plus
  `model: { a, b, tau, sigma, tau_a, kappa, baselines, pair_edges,
  cards_fit, computed_at }`.
- **`/api/drafts/[id]/available/ranked`** gains `sort_by=pick_value` and
  optional `seat` and `committed_colors` params. With `seat`, the horizon h
  (picks until that seat acts again, snake-aware, including double-pick
  rounds) is computed server-side from `before_pick_n`; response rows gain
  `{ worth, danger, pick_value }`. Without `seat`, h defaults to the number
  of seats ×2 (one full snake turn). `committed_colors` (`""` =
  uncommitted, one letter = one color locked, two letters = pair locked)
  adds `{ color_flag, first_pick_score }` per row and sorts by
  `first_pick_score` when `sort_by=first_pick_score`. The response also
  carries `pair_supply`: per-pair obtainable-count summaries at the current
  pick for the given seat.
- **Gating:** both additions are dev-only via the existing
  `NODE_ENV !== "production"` pattern (decklist win rate precedent). The
  route returns 404 in production. The MCP server always targets localhost,
  so the skill retains access — this asymmetry is intended: private
  analytical edge, neutral public site.

### 4. MCP server (rtb-mcp-server)

- New tool **`get_worth_table`** → `/api/cards/worth`. Response is large;
  apply the same trim-and-limit treatment as `search_cards` (sortable,
  `limit` with default 50, `truncated` flag).
- **`rank_available_cards`** schema gains `sort_by: "pick_value"` and
  `seat`.
- Raise the per-request timeout for these two routes (or globally to 45s):
  the first call after a data change pays the recompute.

### 5. Skill (rtb-mcp-server/skill/SKILL.md)

- Replace the Pick-Priority Index formula (0.20·WR + 0.10·WR_color +
  0.40·urgency + 0.30·fit) with: fetch `rank_available_cards` sorted by
  `pick_value` for the user's seat, then adjust with the fit/threat layer
  the skill already prescribes (deck plan fit, table read, snake
  sequencing). Worth × danger supersedes the WR and urgency terms only.
- Session startup fetches `get_worth_table` once for the cube overview.
- Add trust-boundary guidance: Worth is observational and context-bound
  (measured at the card's market price, not at any hypothetical pick);
  sleeper plateau hazards are a known lognormal-tail artifact; land Worth is
  unreliable; τ/σ shift as drafts complete — cite the returned `model`
  params, don't quote session-frozen constants.
- `color_flag` is a tiebreaker: its full spread is ~0 to −1%, so it breaks
  ties between comparable cards and must never be presented as a reason to
  pass a clearly better card. `pair_edge` encodes "how this pod drafts
  these archetypes" — for advising this user, that is a feature, and the
  skill should say so when citing it.
- `pair_supply` is the supply/urgency signal ("black's playables dry up by
  pick 60; white's persist past 200") — never a deck-quality claim.
- Edit the skill at its source (`rtb-mcp-server/skill/SKILL.md`), not the
  `~/.claude/skills/` copy.

### 6. Web UI (dev-only)

- Card table: Worth and PVI columns, hidden in production builds alongside
  the decklist win-rate column.
- Card stats modal: a "Worth model" section showing Worth, PVI, act-by, and
  games/CI, with the model parameters in a tooltip.

### 7. Validation script (offline)

`scripts/worth-validate.ts` — not part of the app runtime:

- **Leave-one-draft-out backtest**: refit the full model excluding draft D,
  score D's seats (sum of top-23 pick Worths), aggregate Spearman ρ against
  final match wins across drafts. Permutation tests are **within-draft**
  (seats share opponents and a game pool; cross-draft permutation inflates
  significance).
- **Gate**: run LODO once on the current draft set, set the gate at the
  measured ρ minus a margin, and pin both the gate and the draft set it was
  measured on. Do not hard-commit a threshold before measuring; do not let
  the gate float as pods complete.
- **Coverage guards**: report per-seat pick coverage; exclude seats below
  60% coverage from ρ (never silently average); one-time check that
  coverage does not correlate with wins (|ρ| > 0.15 → investigate; expected
  driver is cube rotation, not deck quality). No "no-data penalty" — that
  injects modeler priors into the outcome variable.
- **P1 diagnostic**: first_pick_score of each historical seat's first pick
  vs final standing — reported, not gated (underpowered by design:
  ρ ≈ +0.08 in-session).
- Monte Carlo lives here only (validating the deterministic greedy), never
  in the app runtime: no seeded PRNG in JS stdlib, flaky cache tests, and
  illusory precision.

### 8. Testing

- `worthModel.test.ts`: WLS fit recovers known coefficients from synthetic
  data; τ method-of-moments with known mixtures; shrinkage weights; danger
  monotonicity and act-by; degenerate inputs (empty, single card, zero SE).
- `worth.test.ts` (query): hygiene rules — completed-only, land flagging,
  prior-only/no-data states, multi-copy merging, cache invalidation on hash
  change.
- Route tests for gating (404 in production) and the seat-horizon
  computation (snake + double-pick rounds).
- No e2e changes (dev-only UI).

## Open questions

- Whether `pick_value` should also fold in a small exploration bonus for
  high-SE cards (optimism under uncertainty) or stay at posterior mean — v1
  stays at posterior mean.
- Whether the UI should show act-by in the card table or only in the modal.
- MIN_GAMES threshold: reuse existing `MIN_SAMPLE_SIZE` or a new constant
  (session analysis used 100 games).
