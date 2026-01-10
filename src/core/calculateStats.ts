/**
 * Stats calculation module for card rankings.
 * Computes weighted geometric means to rank cards based on pick positions.
 */

import type { CardPick, CardStats, DraftMetadata, DraftScore } from "./types";
import { groupBy } from "./utils";

/** Default number of drafters when not specified (typical rotisserie draft size) */
export const DEFAULT_NUM_DRAFTERS = 10;

/**
 * Number of buckets for pick distribution histogram.
 * Each bucket covers 30 picks (1-30, 31-60, etc.)
 */
export const DISTRIBUTION_BUCKET_COUNT = 15;
export const DISTRIBUTION_BUCKET_SIZE = 30;

/**
 * Get the distribution bucket index for a pick position.
 * Each bucket covers 30 picks: 0 = picks 1-30, 1 = picks 31-60, etc.
 * Positions beyond bucket range go in the last bucket.
 */
function getDistributionBucket(pickPosition: number): number {
  const bucket = Math.floor((pickPosition - 1) / DISTRIBUTION_BUCKET_SIZE);
  return Math.min(bucket, DISTRIBUTION_BUCKET_COUNT - 1);
}

/**
 * Calculate the weight for a single pick.
 *
 * weight = copyWeight x unpickedWeight x topPlayerMultiplier
 *
 * where:
 *   copyWeight = 0.5^(copyNumber - 1)  (1st=1, 2nd=0.5, 3rd=0.25)
 *   unpickedWeight = 0.5 if not picked, else 1
 *   topPlayerMultiplier = 2 if drafter is top player AND useTopPlayer is true, else 1
 */
function calculateWeight(
  pick: CardPick,
  topPlayers: Set<string>,
  useTopPlayerMultiplier: boolean
): number {
  const copyWeight = Math.pow(0.5, pick.copyNumber - 1);
  const unpickedWeight = pick.wasPicked ? 1 : 0.5;
  const topPlayerMultiplier = useTopPlayerMultiplier && topPlayers.has(pick.drafterName) ? 2 : 1;

  return copyWeight * unpickedWeight * topPlayerMultiplier;
}

/**
 * Calculate weighted geometric mean from weights and values.
 *
 * geomean = exp(sum(weight * ln(value)) / sum(weight))
 *
 * Values must be > 0 for the logarithm to be valid.
 * Items with value <= 0 are filtered out to prevent -Infinity corruption.
 */
function weightedGeometricMean(items: Array<{ weight: number; value: number }>): number {
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
 * Calculate stats for a single card from its picks.
 */
function calculateSingleCardStats(
  cardName: string,
  cardPicks: CardPick[],
  topPlayersSet: Set<string>,
  draftMetadata: Map<string, DraftMetadata>
): CardStats {
  // Calculate weighted geomean without top player multiplier
  const regularItems = cardPicks.map((pick) => ({
    weight: calculateWeight(pick, topPlayersSet, false),
    value: pick.pickPosition,
  }));
  const weightedGeomean = weightedGeometricMean(regularItems);

  // Calculate weighted geomean with top player multiplier
  const topPlayerItems = cardPicks.map((pick) => ({
    weight: calculateWeight(pick, topPlayersSet, true),
    value: pick.pickPosition,
  }));
  const topPlayerGeomean = weightedGeometricMean(topPlayerItems);

  // Count total picks (only cards that were actually picked)
  const totalPicks = cardPicks.filter((p) => p.wasPicked).length;

  // Count times unpicked (individual copies, not drafts)
  const timesUnpicked = cardPicks.filter((p) => !p.wasPicked).length;

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

  // Build score history aggregated by date
  // First, get best pick position per draft
  const picksByDraft = groupBy(cardPicks, (p) => p.draftId);

  // Get per-draft scores with metadata
  const draftScores: Array<{
    date: string;
    draftName: string;
    pickPosition: number;
    wasPicked: boolean;
    numDrafters: number;
  }> = [];
  for (const [draftId, picks] of picksByDraft) {
    const metadata = draftMetadata.get(draftId);
    const bestPick = picks.reduce((best, pick) =>
      pick.pickPosition < best.pickPosition ? pick : best
    );
    draftScores.push({
      date: metadata?.date || "1970-01-01",
      draftName: metadata?.name || draftId,
      pickPosition: bestPick.pickPosition,
      wasPicked: bestPick.wasPicked,
      numDrafters: metadata?.numDrafters || DEFAULT_NUM_DRAFTERS,
    });
  }

  // Aggregate by date (geomean of pick positions for same-day drafts)
  const scoresByDate = groupBy(draftScores, (s) => s.date);

  const scoreHistory: DraftScore[] = [];
  for (const [date, scores] of scoresByDate) {
    // Geometric mean of pick positions: exp(avg of ln(positions))
    const logSum = scores.reduce((sum, s) => sum + Math.log(s.pickPosition), 0);
    const geomeanPosition = Math.round(Math.exp(logSum / scores.length));
    const pickedCount = scores.filter((s) => s.wasPicked).length;
    const totalCount = scores.length;
    const anyPicked = pickedCount > 0;
    const draftNames = scores.map((s) => s.draftName).join(", ");
    // Use the average numDrafters for same-day drafts (rounded)
    const avgNumDrafters = Math.round(
      scores.reduce((sum, s) => sum + s.numDrafters, 0) / scores.length
    );
    // Calculate round from the geomean position
    const avgRound = Math.ceil(geomeanPosition / avgNumDrafters);
    scoreHistory.push({
      draftId: date, // Use date as ID for aggregated scores
      date,
      draftName: scores.length > 1 ? `${scores.length} drafts` : draftNames,
      pickPosition: geomeanPosition,
      wasPicked: anyPicked,
      numDrafters: avgNumDrafters,
      round: avgRound,
      pickedCount: scores.length > 1 ? pickedCount : undefined,
      totalCount: scores.length > 1 ? totalCount : undefined,
    });
  }

  // Sort by date ascending
  scoreHistory.sort((a, b) => a.date.localeCompare(b.date));

  // Calculate pick distribution across buckets (by pick position, 30 picks per bucket)
  const pickDistribution = new Array(DISTRIBUTION_BUCKET_COUNT).fill(0);
  for (const pick of cardPicks) {
    const bucket = getDistributionBucket(pick.pickPosition);
    pickDistribution[bucket]++;
  }

  return {
    cardName,
    weightedGeomean,
    topPlayerGeomean,
    totalPicks,
    timesAvailable,
    draftsPickedIn,
    timesUnpicked,
    maxCopiesInDraft,
    colors,
    scoreHistory,
    pickDistribution,
  };
}

/**
 * Calculate stats for all cards from a collection of picks.
 *
 * @param picks - All card picks across all drafts
 * @param topPlayers - List of player names considered "top players"
 * @param draftMetadata - Map of draft IDs to metadata (for score history)
 * @returns Array of CardStats sorted by weightedGeomean (lower = better)
 */
export function calculateCardStats(
  picks: CardPick[],
  topPlayers: string[],
  draftMetadata: Map<string, DraftMetadata> = new Map()
): CardStats[] {
  if (picks.length === 0) return [];

  const topPlayersSet = new Set(topPlayers);
  const picksByCard = groupBy(picks, (p) => p.cardName);

  const stats: CardStats[] = [];
  for (const [cardName, cardPicks] of picksByCard) {
    stats.push(calculateSingleCardStats(cardName, cardPicks, topPlayersSet, draftMetadata));
  }

  // Sort by weightedGeomean ascending (lower = picked earlier = better)
  stats.sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  return stats;
}

/**
 * Extract all unique player names from picks.
 * Excludes the synthetic "Unpicked" drafter used for unpicked cards.
 *
 * @param picks - All card picks
 * @returns Array of unique player names, sorted alphabetically
 */
export function extractPlayers(picks: CardPick[]): string[] {
  const playerSet = new Set<string>();

  for (const pick of picks) {
    // Exclude "Unpicked" which is used for cards that weren't drafted
    if (pick.drafterName && pick.drafterName !== "Unpicked") {
      playerSet.add(pick.drafterName);
    }
  }

  return [...playerSet].sort();
}

/**
 * Convert metadata object to Map for use with calculateCardStats.
 */
export function metadataToMap(
  metadata: Record<string, { name: string; date: string; numDrafters?: number }>
): Map<string, DraftMetadata> {
  const map = new Map<string, DraftMetadata>();
  for (const [draftId, data] of Object.entries(metadata)) {
    map.set(draftId, { draftId, name: data.name, date: data.date, numDrafters: data.numDrafters });
  }
  return map;
}
