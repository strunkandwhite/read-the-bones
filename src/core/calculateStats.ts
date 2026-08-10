/**
 * Stats calculation module for card rankings.
 * Aggregates per-card pick data; the score itself comes from pickScore.ts.
 */

import type { CardPick, CardStats } from "./types";
import { groupBy } from "./utils";
import { pickScore, type DraftObservation } from "./pickScore";
import { cardNameKey } from "./cardNames";

/**
 * Number of buckets for pick distribution histogram.
 * Each bucket covers 30 picks (1-30, 31-60, etc.)
 */
export const DISTRIBUTION_BUCKET_COUNT = 15;
export const DISTRIBUTION_BUCKET_SIZE = 30;

/**
 * Calculate stats for a single card from its picks.
 */
function calculateSingleCardStats(
  cardName: string,
  cardPicks: CardPick[],
  sessionsAgoByDraftId: Map<string, number>,
): CardStats {
  // Group by draft: the score treats each draft as one observation, and a
  // draft that took at least one copy contributes only the copies it took.
  const picksByDraft = groupBy(cardPicks, (pick) => pick.draftId);
  const observations: DraftObservation[] = [];
  for (const [draftId, draftPicks] of picksByDraft) {
    const taken = draftPicks
      .filter((pick) => pick.wasPicked)
      .sort((a, b) => a.copyNumber - b.copyNumber);
    const untaken = draftPicks.find((pick) => !pick.wasPicked);
    observations.push({
      // getCards.ts builds this map from completedDraftIds, a superset of
      // the selectedDraftIds that produce cardPicks, so every draftId
      // reaching this loop has an entry.
      sessionsAgo: sessionsAgoByDraftId.get(draftId)!,
      pickPositions: taken.map((pick) => pick.pickPosition),
      // An unpicked entry carries the pool size as its pickPosition. A draft
      // with no untaken entry never reaches pickScore's pool-size branch, so
      // the 0 fallback is unreachable rather than a silent default.
      poolSize: untaken?.pickPosition ?? 0,
    });
  }
  const weightedGeomean = pickScore(observations);

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
 * @param sessionsAgoByDraftId - How many drafting sessions back each draft is
 * @returns Array of CardStats sorted by weightedGeomean (lower = better)
 */
export function calculateCardStats(
  picks: CardPick[],
  sessionsAgoByDraftId: Map<string, number>,
): CardStats[] {
  if (picks.length === 0) return [];

  // Group by lowercase key for case-insensitive matching
  const picksByCard = groupBy(picks, (p) => cardNameKey(p.cardName));

  const stats: CardStats[] = [];
  for (const [, cardPicks] of picksByCard) {
    // Use the first occurrence's cardName for display (preserves original casing)
    const displayName = cardPicks[0].cardName;
    stats.push(calculateSingleCardStats(displayName, cardPicks, sessionsAgoByDraftId));
  }

  // Sort by weightedGeomean ascending (lower = picked earlier = better)
  stats.sort((a, b) => a.weightedGeomean - b.weightedGeomean);

  return stats;
}
