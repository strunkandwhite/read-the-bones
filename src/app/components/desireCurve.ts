/**
 * Desire: the expected win-rate value forfeited by not taking a card within
 * the next snake turn, given it is still available at pick n —
 * desire(n) = worth × danger(n, h, geomean).
 *
 * Closed-form from three per-card inputs (worth, geomean, pooled σ), so
 * curves and sparklines are evaluated at render time with no API payload.
 * Model reference: docs/superpowers/specs/2026-08-02-desire-metric-design.md
 */

import { overdueDanger, pickCdf, type WorthCard } from "@/core/worthModel";

/** Fixed danger horizon: one full snake turn at 10 seats (spec decision). */
export const DESIRE_HORIZON = 20;

/** Curve domain fallback when no draft is active: 10 seats × 45 picks. */
export const DEFAULT_TOTAL_PICKS = 450;

export interface DesireInputs {
  worth: number;
  geomean: number;
  sigma: number;
}

/**
 * Desire at a single pick position, in raw WR points: worth × overdueDanger.
 * The overdue floor means a card stranded past its market window reads at
 * full (worth-capped) desire instead of fading — see overdueDanger's doc.
 */
export function desireAt(pickN: number, inputs: DesireInputs): number {
  return (
    inputs.worth * overdueDanger(pickN, DESIRE_HORIZON, inputs.geomean, inputs.sigma)
  );
}

/**
 * Denominator for the desire index: the largest |worth| among cards whose
 * worth is a trustworthy quality signal — fitted (not prior_only, whose
 * "worth" is the unshrunk price-curve prior), in the current cube, and not
 * a land (land worth is archetype noise, flagged unreliable). Without the
 * filter, a new cube addition's top-of-curve prior could silently set the
 * ±100 scale with exactly the market opinion the zero-prior worth excludes.
 * ±100 = the cube's strongest quality signal, fully on the line.
 */
export function maxAbsWorth(cards: Iterable<WorthCard>): number {
  let max = 0;
  for (const card of cards) {
    if (
      card.worth != null &&
      !card.prior_only &&
      !card.is_land &&
      card.in_current_cube &&
      Math.abs(card.worth) > max
    ) {
      max = Math.abs(card.worth);
    }
  }
  return max;
}

/**
 * Display transform: raw WR-point desire → index clamped to [−100, 100].
 * The clamp only binds for cards excluded from the maxAbsWorth denominator
 * (prior_only priors, lands, out-of-cube cards) whose |worth| can exceed
 * the trustworthy scale. Returns null when the scale is degenerate.
 */
export function desireIndex(desire: number, worthScale: number): number | null {
  if (worthScale <= 0) return null;
  return Math.max(-100, Math.min(100, (100 * desire) / worthScale));
}

/**
 * "+41" / "-38", or "—" when the index rounds to zero — a remote danger
 * decays desire to nothing, and hundreds of zero rows are noise.
 */
export function formatDesireIndex(index: number): string {
  const rounded = Math.round(index);
  if (rounded === 0) return "—";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

export interface DesirePoint {
  pickN: number;
  desire: number;
}

// Curves end once the card is almost surely gone (survival < 0.1%). Past
// this point the conditional "if still available" is answered from vanishing
// probability mass — the lognormal tail plateaus and danger()'s survival
// guard snaps to 1.0, drawing a cliff. Ending the line instead makes its
// LENGTH the signal: a stub means the card's desire question only exists for
// the first picks. Display-only: the desire VALUE at the current pick is
// never truncated — a card actually still available past this point shows
// its real (conditional) desire.
const SURVIVAL_CUTOFF = 0.001;

/**
 * Sample the desire curve from pick 1 until totalPicks or until survival
 * drops below SURVIVAL_CUTOFF (the crossing point is included, so a curve
 * visibly reaches the end of the card's plausible life). sampleCount bounds
 * the work per curve; the default resolves a 450-pick draft every ~7 picks,
 * plenty for a small chart.
 */
export function desireCurvePoints(
  inputs: DesireInputs,
  totalPicks: number,
  sampleCount = 64,
): DesirePoint[] {
  if (
    inputs.sigma <= 0 ||
    inputs.geomean <= 0 ||
    !Number.isFinite(totalPicks) ||
    totalPicks < 1
  ) {
    return [];
  }
  const step = Math.max(1, Math.floor(totalPicks / sampleCount));
  const points: DesirePoint[] = [];
  for (let pickN = 1; pickN <= totalPicks; pickN += step) {
    points.push({ pickN, desire: desireAt(pickN, inputs) });
    if (1 - pickCdf(pickN, inputs.geomean, inputs.sigma) < SURVIVAL_CUTOFF) {
      return points;
    }
  }
  const lastSampled = points[points.length - 1];
  if (lastSampled === undefined || lastSampled.pickN !== totalPicks) {
    points.push({ pickN: totalPicks, desire: desireAt(totalPicks, inputs) });
  }
  return points;
}
