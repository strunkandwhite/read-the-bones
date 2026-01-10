/**
 * Shared utility functions for the core module.
 */

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
