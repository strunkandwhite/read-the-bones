/**
 * Card worth model: pure math for the worth/PVI/danger pipeline.
 * No I/O and no database imports — data assembly lives in
 * src/core/db/queries/stats/worth.ts, which calls into this module.
 *
 * Model reference: docs/superpowers/specs/2026-08-01-card-worth-model-design.md
 */

/** Fitted model parameters, recomputed from data on demand. */
export interface WorthModelFit {
  a: number;
  b: number; // E[dWR|geo] = a + b*ln(geo)
  tau: number; // quality spread around the price curve (diagnostic)
  tau0: number; // quality spread around zero (drives worth shrinkage)
  sigma: number; // ln-pick spread
  tauA: number; // pair-edge spread (DerSimonian-Laird)
  grandMean: number; // precision-weighted pair WR mean
  kappa: number; // commitment policy parameter (0.5)
  baselines: Record<string, number>; // W/U/B/R/G color WRs
  pairEdges: Record<string, number>; // "UR" -> shrunk edge (centered)
}

/** One row of the worth table returned by /api/cards/worth. */
export interface WorthCard {
  card_name: string;
  colors: string; // "" = colorless, else subset of WUBRG
  is_land: boolean;
  in_current_cube: boolean;
  geomean: number | null;
  games: number;
  wins: number;
  losses: number;
  wr: number | null;
  se: number | null;
  delta: number | null;
  expected: number | null;
  pvi: number | null;
  worth: number | null; // prior-only value when prior_only
  prior_only: boolean;
  no_data: boolean;
  act_by: number | null; // null = never crosses 0.5 (or no geomean)
}

/**
 * Weighted least squares fit of delta on ln(geomean), weights 1/se².
 * Returns the price curve E[dWR|geo] = a + b*ln(geo).
 * Degenerate inputs (no points, or no spread in lnGeo) get b = 0 and the
 * weighted mean of delta as a — a flat prior rather than NaN.
 * Precondition: se > 0 for every point (callers filter by MIN_GAMES).
 */
export function fitPriceCurve(
  pts: { lnGeo: number; delta: number; se: number }[],
): { a: number; b: number } {
  if (pts.length === 0) return { a: 0, b: 0 };

  let sumW = 0;
  let sumWx = 0;
  let sumWy = 0;
  let sumWxx = 0;
  let sumWxy = 0;
  for (const { lnGeo, delta, se } of pts) {
    const w = 1 / (se * se);
    sumW += w;
    sumWx += w * lnGeo;
    sumWy += w * delta;
    sumWxx += w * lnGeo * lnGeo;
    sumWxy += w * lnGeo * delta;
  }

  const denominator = sumW * sumWxx - sumWx * sumWx;
  if (Math.abs(denominator) < 1e-12) {
    return { a: sumWy / sumW, b: 0 };
  }
  const b = (sumW * sumWxy - sumWx * sumWy) / denominator;
  const a = (sumWy - b * sumWx) / sumW;
  return { a, b };
}

/**
 * Method-of-moments estimate of the card-quality spread τ:
 * τ² = mean(resid² − se²), floored at 0 (sampling noise can push it negative).
 */
export function estimateTau(resids: { resid: number; se: number }[]): number {
  if (resids.length === 0) return 0;
  const meanExcessVariance =
    resids.reduce((sum, { resid, se }) => sum + resid * resid - se * se, 0) /
    resids.length;
  return Math.sqrt(Math.max(meanExcessVariance, 0));
}

/**
 * DerSimonian-Laird estimate of between-group spread τ_a, for pair edges.
 * With fixed-effect weights w = 1/se²:
 *   Q = Σ w·(δ − fixedMean)²,  c = Σw − Σw²/Σw,  τ_a² = max((Q − df)/c, 0)
 * where df = k − 1. The returned grandMean is the standard DL pooled
 * estimate: precision-weighted with the random-effects weights 1/(se² + τ_a²).
 */
export function estimateTauDL(items: { delta: number; se: number }[]): {
  tauA: number;
  grandMean: number;
} {
  if (items.length === 0) return { tauA: 0, grandMean: 0 };
  if (items.length === 1) return { tauA: 0, grandMean: items[0].delta };

  let sumW = 0;
  let sumWSq = 0;
  let sumWDelta = 0;
  for (const { delta, se } of items) {
    const w = 1 / (se * se);
    sumW += w;
    sumWSq += w * w;
    sumWDelta += w * delta;
  }
  const fixedMean = sumWDelta / sumW;

  const q = items.reduce((sum, { delta, se }) => {
    const w = 1 / (se * se);
    return sum + w * (delta - fixedMean) * (delta - fixedMean);
  }, 0);
  const degreesOfFreedom = items.length - 1;
  const c = sumW - sumWSq / sumW;
  const tauASquared = c > 0 ? Math.max((q - degreesOfFreedom) / c, 0) : 0;

  let sumWStar = 0;
  let sumWStarDelta = 0;
  for (const { delta, se } of items) {
    const wStar = 1 / (se * se + tauASquared);
    sumWStar += wStar;
    sumWStarDelta += wStar * delta;
  }

  return { tauA: Math.sqrt(tauASquared), grandMean: sumWStarDelta / sumWStar };
}

/**
 * Shrink an observed ΔWR toward the zero (color-neutral) prior:
 *   w = τ₀²/(τ₀² + se²),  worth = w·delta.
 * τ₀ is the quality spread measured around zero (estimateTau over raw
 * deltas), not around the price curve — a zero-mean prior must use total
 * spread or the shrinkage is inconsistent. The price curve stays out of
 * the quality number by design: it explains ~5% of true quality variance
 * (see docs/superpowers/specs/2026-08-02-desire-metric-design.md).
 * τ₀ = 0 (or τ₀ = se = 0) means no card-quality spread: the prior wins, w = 0.
 */
export function shrinkQuality(
  delta: number,
  tau0: number,
  se: number,
): { worth: number; w: number } {
  const denominator = tau0 * tau0 + se * se;
  const w = denominator > 0 ? (tau0 * tau0) / denominator : 0;
  return { worth: w * delta, w };
}

/**
 * Error function via Abramowitz & Stegun 7.1.26 (max abs error 1.5e-7),
 * extended to negative x by odd symmetry.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-absX * absX));
}

/**
 * Standard normal CDF Φ(x) = ½(1 + erf(x/√2)).
 * Inherits the A&S 7.1.26 accuracy: absolute error under 1e-7.
 */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Lognormal pick-position CDF: F(x) = Φ((ln x − ln geo)/σ).
 * The probability the card has been taken by pick position x.
 */
export function pickCdf(x: number, geo: number, sigma: number): number {
  if (x <= 0) return 0;
  return normalCdf((Math.log(x) - Math.log(geo)) / sigma);
}

/**
 * danger(n, h) = [F(n+h) − F(n)] / [1 − F(n)]: the probability the card is
 * taken within the next h picks given it is still available at pick n.
 * When survival to n is essentially impossible (denominator < 1e-9) the
 * conditional is vacuous and we report certain loss: 1.0.
 */
export function danger(
  n: number,
  h: number,
  geo: number,
  sigma: number,
): number {
  const survival = 1 - pickCdf(n, geo, sigma);
  if (survival < 1e-9) return 1.0;
  return (pickCdf(n + h, geo, sigma) - pickCdf(n, geo, sigma)) / survival;
}

/**
 * Danger with the wheel-again inference removed: max(danger, F(n)).
 *
 * The raw conditional hazard reads long survival as evidence a card will
 * keep wheeling ("nobody here wants it"), discounting stranded good cards
 * exactly when they should scream — and "it wheeled twice, it'll wheel
 * again" is how good cards get lost in real drafts. Flooring at F(n), the
 * probability the card SHOULD already be gone, treats every look at an
 * overdue card as possibly the last. Early in a card's window F(n) ≈ 0 and
 * this is identical to danger(). Policy decision 2026-08-02; raw danger()
 * remains exported for callers that want the pure conditional hazard.
 */
export function overdueDanger(
  n: number,
  h: number,
  geo: number,
  sigma: number,
): number {
  return Math.max(danger(n, h, geo, sigma), pickCdf(n, geo, sigma));
}

// Scan bound for actBy: comfortably past the deepest real pick position
// (450-pick drafts); beyond it the card is effectively never in danger.
const ACT_BY_MAX_PICK = 459;

/**
 * The smallest pick position n where overdueDanger(n, h) ≥ 0.5 — the last
 * safe moment to act. The overdue floor caps this at roughly the geomean:
 * past its market window a card is never "safe to wait on." Null when the
 * threshold is never crossed within the scan bound.
 */
export function actBy(geo: number, h: number, sigma: number): number | null {
  for (let n = 1; n <= ACT_BY_MAX_PICK; n++) {
    if (overdueDanger(n, h, geo, sigma) >= 0.5) return n;
  }
  return null;
}

/**
 * State-dependent commitment cost of picking a card, always ≤ 0:
 *   κ · [best pair edge the card fits in − best pair edge available]
 * where the available pairs depend on commitment state (committed = "" when
 * uncommitted, one letter when one color is locked — restricting pairs to
 * those containing it — and two letters when pair-locked, which costs 0).
 * Colorless cards fit everywhere and cost 0. Cards with ≤2 colors "fit"
 * pairs containing their whole identity; 3+ color identities — and cards a
 * one-color lock leaves with no containing pair — fall back to pairs merely
 * intersecting the identity.
 */
export function colorFlag(
  colors: string,
  pairEdges: Record<string, number>,
  state: { committed: string },
  kappa: number,
): number {
  if (state.committed.length >= 2) return 0; // pair locked: no cost left to pay
  if (colors === "") return 0; // colorless fits every pair

  const candidatePairs = Object.entries(pairEdges).filter(
    ([pair]) => state.committed === "" || pair.includes(state.committed),
  );
  if (candidatePairs.length === 0) return 0;

  const cardColors = colors.split("");
  const containsIdentity = (pair: string) =>
    cardColors.every((color) => pair.includes(color));
  const intersectsIdentity = (pair: string) =>
    cardColors.some((color) => pair.includes(color));

  let feasiblePairs =
    cardColors.length <= 2
      ? candidatePairs.filter(([pair]) => containsIdentity(pair))
      : [];
  if (feasiblePairs.length === 0) {
    feasiblePairs = candidatePairs.filter(([pair]) => intersectsIdentity(pair));
  }
  if (feasiblePairs.length === 0) return 0;

  const bestOverall = Math.max(...candidatePairs.map(([, edge]) => edge));
  const bestFeasible = Math.max(...feasiblePairs.map(([, edge]) => edge));
  return kappa * (bestFeasible - bestOverall);
}

/**
 * Deterministic expected count of positive-worth cards obtainable at the
 * given slots from fromPick onward. Greedy assignment: at each slot
 * (ascending, slots before fromPick skipped), take the highest-worth
 * remaining card whose survival probability 1 − F(slot) is at least 0.5.
 * A supply/urgency signal — explicitly not a deck-quality prediction.
 */
export function pairSupply(
  cards: { worth: number; geo: number }[],
  slots: number[],
  fromPick: number,
  sigma: number,
): number {
  const remainingByWorth = cards
    .filter((card) => card.worth > 0)
    .sort((cardA, cardB) => cardB.worth - cardA.worth);
  const upcomingSlots = slots
    .filter((slot) => slot >= fromPick)
    .sort((slotA, slotB) => slotA - slotB);

  let obtainedCount = 0;
  for (const slot of upcomingSlots) {
    const takeIndex = remainingByWorth.findIndex(
      (card) => 1 - pickCdf(slot, card.geo, sigma) >= 0.5,
    );
    if (takeIndex !== -1) {
      remainingByWorth.splice(takeIndex, 1);
      obtainedCount++;
    }
  }
  return obtainedCount;
}
