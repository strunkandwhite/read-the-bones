/**
 * Wilson score interval for binomial proportions.
 * Handles small sample sizes better than normal approximation.
 */

import { round3 } from "./utils";

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
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));

  return {
    lower: round3(Math.max(0, center - margin)),
    center: round3(center),
    upper: round3(Math.min(1, center + margin)),
  };
}
