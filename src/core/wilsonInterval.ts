/**
 * Wilson score interval for binomial proportions.
 * Handles small sample sizes better than normal approximation.
 */

/**
 * Calculate Wilson score confidence interval.
 * @param wins Number of successes
 * @param total Total number of trials
 * @param z Z-score for confidence level (default 1.96 = 95%)
 * @returns [lower, upper] bounds as proportions (0-1)
 */
export function wilsonInterval(
  wins: number,
  total: number,
  z = 1.96
): [lower: number, upper: number] {
  if (total === 0) return [0, 0];

  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);

  const lower = (centre - margin) / denominator;
  const upper = (centre + margin) / denominator;

  return [Math.max(0, lower), Math.min(1, upper)];
}
