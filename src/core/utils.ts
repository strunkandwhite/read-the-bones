/**
 * Shared utility functions for the core module.
 */

/**
 * Calculate the weight for a single pick in weighted geometric mean calculations.
 *
 * weight = copyWeight x unpickedWeight
 *
 * where:
 *   copyWeight = 0.5^(copyNumber - 1)  (1st=1, 2nd=0.5, 3rd=0.25)
 *   unpickedWeight = 0.5 if not picked, else 1
 */
export function calculatePickWeight(params: {
  copyNumber: number;
  wasPicked: boolean;
}): number {
  const { copyNumber, wasPicked } = params;

  const copyWeight = Math.pow(0.5, copyNumber - 1);
  const unpickedWeight = wasPicked ? 1 : 0.5;

  return copyWeight * unpickedWeight;
}

/**
 * Calculate weighted geometric mean from weights and values.
 *
 * geomean = exp(sum(weight * ln(value)) / sum(weight))
 *
 * Values must be > 0 for the logarithm to be valid.
 * Items with value <= 0 are filtered out to prevent -Infinity corruption.
 */
export function weightedGeometricMean(items: Array<{ weight: number; value: number }>): number {
  // Filter out items with invalid values (must be > 0 for log)
  const validItems = items.filter((item) => item.value > 0);

  if (validItems.length === 0) return 0;

  const totalWeight = validItems.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;

  const weightedLogSum = validItems.reduce(
    (sum, item) => sum + item.weight * Math.log(item.value),
    0
  );

  return Math.exp(weightedLogSum / totalWeight);
}

/**
 * Wilson score interval for binomial proportions.
 * Provides a confidence interval that works well with small samples.
 */
export function wilsonInterval(
  wins: number,
  total: number,
  z: number = 1.96
): { lower: number; center: number; upper: number } {
  if (total === 0) return { lower: 0, center: 0, upper: 0 };

  const p = wins / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));

  return {
    lower: Math.round(Math.max(0, center - margin) * 1000) / 1000,
    center: Math.round(center * 1000) / 1000,
    upper: Math.round(Math.min(1, center + margin) * 1000) / 1000,
  };
}

/**
 * Sleep for the given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Group items by a key derived from each item.
 *
 * @param items - Array of items to group
 * @param getKey - Function to extract the grouping key from each item
 * @returns Map from key to array of items with that key
 *
 * @example
 * const picks = [{ cardName: "Bolt" }, { cardName: "Bolt" }, { cardName: "Island" }];
 * const grouped = groupBy(picks, p => p.cardName);
 * // Map { "Bolt" => [{...}, {...}], "Island" => [{...}] }
 */
export function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();

  for (const item of items) {
    const key = getKey(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  return groups;
}
