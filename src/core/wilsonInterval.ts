/**
 * Wilson score interval for binomial proportions.
 * Handles small sample sizes better than normal approximation.
 */

import { round3 } from "./utils";

/**
 * Compute the ±margin percentage from a Wilson confidence interval.
 * Returns an integer (e.g. 8 means "±8%").
 * Formula: (upper − lower) × 50, which is half the interval width as a percentage.
 */
export function ciMarginPct(ci: { lower: number; upper: number }): number {
  return Math.round((ci.upper - ci.lower) * 50);
}

/**
 * Calculate Wilson score confidence interval.
 * @param wins Number of successes
 * @param total Total number of trials
 * @param z Z-score for confidence level (default 1.96 = 95%)
 * @returns { lower, center, upper } bounds as proportions (0-1), rounded to 3 decimals
 */
export function wilsonInterval(
  wins: number,
  total: number,
  z = 1.96
): { lower: number; center: number; upper: number } {
  if (total === 0) return { lower: 0, center: 0, upper: 0 };

  const p = wins / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));

  return {
    lower: round3(Math.max(0, center - margin)),
    center: round3(center),
    upper: round3(Math.min(1, center + margin)),
  };
}
