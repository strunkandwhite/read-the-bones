/**
 * Stats calculation module for card rankings.
 * Computes weighted geometric means to rank cards based on pick positions.
 */

import type { CardPick, CardStats } from "./types";
import { groupBy, calculatePickWeight, weightedGeometricMean } from "./utils";
import { cardNameKey } from "./cardNames";

/**
 * Number of buckets for pick distribution histogram.
 * Each bucket covers 30 picks (1-30, 31-60, etc.)
 */
export const DISTRIBUTION_BUCKET_COUNT = 15;
export const DISTRIBUTION_BUCKET_SIZE = 30;

/**
 * Helper to calculate weight for a CardPick using the shared utility.
 */
function calculateWeight(pick: CardPick): number {
  return calculatePickWeight({
    copyNumber: pick.copyNumber,
    wasPicked: pick.wasPicked,
  });
}

/**
 * Calculate stats for a single card from its picks.
 */
function calculateSingleCardStats(
  cardName: string,
  cardPicks: CardPick[],
): CardStats {
  // Calculate weighted geomean
  const items = cardPicks.map((pick) => ({
    weight: calculateWeight(pick),
    value: pick.pickPosition,
  }));
  const weightedGeomean = weightedGeometricMean(items);

  // Count unique drafts (times available)
  const uniqueDrafts = new Set(cardPicks.map((p) => p.draftId));
  const timesAvailable = uniqueDrafts.size;

  // Count drafts where at least one copy was picked
  const draftsWithPicks = new Set(cardPicks.filter((p) => p.wasPicked).map((p) => p.draftId));
  const draftsPickedIn = draftsWithPicks.size;

  // Find max copies in any single draft
  const copiesByDraft = new Map<string, number>();
  for (const pick of cardPicks) {
    const current = copiesByDraft.get(pick.draftId) || 0;
    copiesByDraft.set(pick.draftId, Math.max(current, pick.copyNumber));
  }
  const maxCopiesInDraft = Math.max(...copiesByDraft.values(), 0);

  // Collect unique colors
  const colorSet = new Set<string>();
  for (const pick of cardPicks) {
    if (pick.color) {
      colorSet.add(pick.color);
    }
  }
  const colors = [...colorSet].sort();

  return {
    cardName,
    weightedGeomean,
    timesAvailable,
    draftsPickedIn,
    maxCopiesInDraft,
    colors,
  };
}

/**
 * Calculate stats for all cards from a collection of picks.
 *
 * @param picks - All card picks across all drafts
 * @returns Array of CardStats sorted by weightedGeomean (lower = better)
 */
export function calculateCardStats(
  picks: CardPick[],
): CardStats[] {
  if (picks.length === 0) return [];

  // Group by lowercase key for case-insensitive matching
  const picksByCard = groupBy(picks, (p) => cardNameKey(p.cardName));

  const stats: CardStats[] = [];
  for (const [, cardPicks] of picksByCard) {
    // Use the first occurrence's cardName for display (preserves original casing)
    const displayName = cardPicks[0].cardName;
    stats.push(calculateSingleCardStats(displayName, cardPicks));
  }

  // Sort by weightedGeomean ascending (lower = picked earlier = better)
  stats.sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  return stats;
}
