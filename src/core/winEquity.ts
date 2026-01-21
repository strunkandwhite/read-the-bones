/**
 * Win Equity calculation module.
 *
 * Calculates probability-weighted win attribution for cards based on:
 * - Position in draft (higher picks = more likely to be played)
 * - Card type (lands always play, others decay by pick position)
 * - Player match results (wins/losses distributed across pool)
 */

import type { CardPick, ScryCard } from "./types";
import type { SeatMatchStats } from "./parseMatches";
import { cardNameKey } from "./parseCsv";

/** Play probability for land cards - always played */
export const LAND_PLAY_PROBABILITY = 1.0;

/** Pick position thresholds for probability tiers */
export const PICK_THRESHOLD_EARLY = 15;
export const PICK_THRESHOLD_MID = 23;
export const PICK_THRESHOLD_LATE = 30;

/** Play probabilities for each tier */
export const PLAY_PROBABILITY_EARLY = 0.95;
export const PLAY_PROBABILITY_MID = 0.8;
export const PLAY_PROBABILITY_LATE = 0.4;
export const PLAY_PROBABILITY_VERY_LATE = 0.1;

/**
 * Win equity result for a single card.
 */
export type WinEquityResult = {
  /** Probability-weighted wins attributed to this card */
  wins: number;
  /** Probability-weighted losses attributed to this card */
  losses: number;
  /** Win rate: wins / (wins + losses), or 0 if no games */
  winRate: number;
};

/**
 * Raw win rate result for a single card.
 * Unlike WinEquityResult, this divides wins/losses equally among all cards in a pool.
 */
export type RawWinRateResult = {
  /** Wins attributed to this card (equally distributed among pool) */
  wins: number;
  /** Losses attributed to this card (equally distributed among pool) */
  losses: number;
  /** Win rate: wins / (wins + losses), or 0 if no games */
  winRate: number;
};

/**
 * Get the play probability for a card based on its pick position and type.
 *
 * Lands are always played (probability 1.0).
 * Non-lands decay based on pick position:
 * - Picks 1-15: 0.95 (almost certain to play)
 * - Picks 16-23: 0.80 (likely to play)
 * - Picks 24-30: 0.40 (might play)
 * - Picks 31+: 0.10 (unlikely to play)
 *
 * @param pickPosition - The position at which the card was picked (1-indexed)
 * @param isLand - Whether the card is a land
 * @returns Probability (0-1) that the card will be played
 */
export function getPlayProbability(pickPosition: number, isLand: boolean): number {
  if (isLand) {
    return LAND_PLAY_PROBABILITY;
  }

  if (pickPosition <= PICK_THRESHOLD_EARLY) {
    return PLAY_PROBABILITY_EARLY;
  }
  if (pickPosition <= PICK_THRESHOLD_MID) {
    return PLAY_PROBABILITY_MID;
  }
  if (pickPosition <= PICK_THRESHOLD_LATE) {
    return PLAY_PROBABILITY_LATE;
  }
  return PLAY_PROBABILITY_VERY_LATE;
}

/**
 * Check if a card is a land based on its Scryfall type line.
 *
 * @param typeLine - The type line from Scryfall (e.g., "Basic Land - Mountain")
 * @returns true if the card is any type of land
 */
function isLand(typeLine: string | undefined): boolean {
  if (!typeLine) return false;
  return typeLine.includes("Land");
}

/**
 * Group picks by draft and seat, filtering out unpicked cards.
 *
 * @param picks - All card picks from all drafts
 * @returns Nested map: draftId -> seat -> CardPick[]
 */
function groupPicksByDraftAndSeat(
  picks: CardPick[]
): Map<string, Map<number, CardPick[]>> {
  const picksByDraftAndSeat = new Map<string, Map<number, CardPick[]>>();

  for (const pick of picks) {
    // Skip unpicked cards (they're not in anyone's pool)
    if (!pick.wasPicked) continue;

    if (!picksByDraftAndSeat.has(pick.draftId)) {
      picksByDraftAndSeat.set(pick.draftId, new Map());
    }
    const draftPicks = picksByDraftAndSeat.get(pick.draftId)!;

    if (!draftPicks.has(pick.seat)) {
      draftPicks.set(pick.seat, []);
    }
    draftPicks.get(pick.seat)!.push(pick);
  }

  return picksByDraftAndSeat;
}

/**
 * Calculate win equity attribution for all cards across drafts.
 *
 * Algorithm:
 * 1. For each card in each seat's pool, calculate play probability
 * 2. Distribute seat wins/losses proportionally to each card
 * 3. Aggregate equity across all drafts
 *
 * @param picks - All card picks from all drafts
 * @param matchStats - Map of draftId -> seat -> { gamesWon, gamesLost }
 * @param scryfallData - Map of card name -> Scryfall data (for land detection)
 * @returns Map of card name -> win equity result
 */
export function calculateWinEquity(
  picks: CardPick[],
  matchStats: Map<string, Map<number, SeatMatchStats>>,
  scryfallData: Map<string, ScryCard>
): Map<string, WinEquityResult> {
  // Aggregate equity per card
  const cardEquity = new Map<string, { wins: number; losses: number }>();

  // Group picks by draft and seat
  const picksByDraftAndSeat = groupPicksByDraftAndSeat(picks);

  // Process each draft that has match data
  for (const [draftId, seatStats] of matchStats) {
    const draftPicks = picksByDraftAndSeat.get(draftId);
    if (!draftPicks) continue;

    // Process each seat in this draft
    for (const [seat, stats] of seatStats) {
      const seatPicks = draftPicks.get(seat);
      if (!seatPicks || seatPicks.length === 0) continue;

      // Calculate play probability for each card in the seat's pool
      const cardWeights: { cardName: string; weight: number }[] = [];
      let totalWeight = 0;

      for (const pick of seatPicks) {
        const scryData = scryfallData.get(cardNameKey(pick.cardName));
        const cardIsLand = isLand(scryData?.typeLine);
        const weight = getPlayProbability(pick.pickPosition, cardIsLand);

        cardWeights.push({ cardName: pick.cardName, weight });
        totalWeight += weight;
      }

      // Skip if no weighted cards (shouldn't happen with valid data)
      if (totalWeight === 0) continue;

      // Distribute wins and losses to each card proportionally
      for (const { cardName, weight } of cardWeights) {
        const proportion = weight / totalWeight;
        const cardWins = proportion * stats.gamesWon;
        const cardLosses = proportion * stats.gamesLost;

        // Use cardNameKey for case-insensitive aggregation
        const key = cardNameKey(cardName);
        if (!cardEquity.has(key)) {
          cardEquity.set(key, { wins: 0, losses: 0 });
        }
        const equity = cardEquity.get(key)!;
        equity.wins += cardWins;
        equity.losses += cardLosses;
      }
    }
  }

  // Calculate win rates (keys are already normalized)
  const results = new Map<string, WinEquityResult>();

  for (const [key, { wins, losses }] of cardEquity) {
    const total = wins + losses;
    const winRate = total > 0 ? wins / total : 0;

    results.set(key, {
      wins,
      losses,
      winRate,
    });
  }

  return results;
}

/**
 * Calculate raw win rate attribution for all cards across drafts.
 *
 * Unlike calculateWinEquity, this distributes wins/losses equally among
 * all cards in a seat's pool (no play probability weighting).
 *
 * Algorithm:
 * 1. For each card in each seat's pool, weight = 1 / pool_size
 * 2. Distribute seat wins/losses equally to each card
 * 3. Aggregate across all drafts
 *
 * @param picks - All card picks from all drafts
 * @param matchStats - Map of draftId -> seat -> { gamesWon, gamesLost }
 * @returns Map of card name -> raw win rate result
 */
export function calculateRawWinRate(
  picks: CardPick[],
  matchStats: Map<string, Map<number, SeatMatchStats>>
): Map<string, RawWinRateResult> {
  // Aggregate wins/losses per card
  const cardStats = new Map<string, { wins: number; losses: number }>();

  // Group picks by draft and seat
  const picksByDraftAndSeat = groupPicksByDraftAndSeat(picks);

  // Process each draft that has match data
  for (const [draftId, seatStats] of matchStats) {
    const draftPicks = picksByDraftAndSeat.get(draftId);
    if (!draftPicks) continue;

    // Process each seat in this draft
    for (const [seat, stats] of seatStats) {
      const seatPicks = draftPicks.get(seat);
      if (!seatPicks || seatPicks.length === 0) continue;

      const poolSize = seatPicks.length;

      // Distribute wins and losses equally to each card
      for (const pick of seatPicks) {
        const cardWins = stats.gamesWon / poolSize;
        const cardLosses = stats.gamesLost / poolSize;

        // Use cardNameKey for case-insensitive aggregation
        const key = cardNameKey(pick.cardName);
        if (!cardStats.has(key)) {
          cardStats.set(key, { wins: 0, losses: 0 });
        }
        const cardStat = cardStats.get(key)!;
        cardStat.wins += cardWins;
        cardStat.losses += cardLosses;
      }
    }
  }

  // Calculate win rates (keys are already normalized)
  const results = new Map<string, RawWinRateResult>();

  for (const [key, { wins, losses }] of cardStats) {
    const total = wins + losses;
    const winRate = total > 0 ? wins / total : 0;

    results.set(key, {
      wins,
      losses,
      winRate,
    });
  }

  return results;
}
