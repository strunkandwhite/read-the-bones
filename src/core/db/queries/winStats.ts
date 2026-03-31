/**
 * Card win-rate statistics — win rate for seats that maindecked a card.
 */

import { getClient, type Client } from "../client";
import { fetchOptOuts, getSeatsMatchingColors } from "./helpers";
import { resolveCard } from "./cards";
import { round3 } from "../../utils";
import { wilsonInterval } from "../../wilsonInterval";
import { cardNameKey } from "../../cardNames";


export interface GetCardWinStatsParams {
  card_name: string;
  card_id?: number;
  draft_id?: string;
  exclude_draft_id?: string;
  deck_colors?: string;
  /** Pre-fetched opt-outs as "draftId:seat" pairs. When provided, skips the internal opt-outs query. */
  optedOutByDraft?: Set<string>;
}

export interface CardWinStatsResult {
  card_name: string;
  times_maindecked: number;
  game_wins: number;
  game_losses: number;
  win_rate: number;
  drafts_with_data: number;
}

/**
 * Get win rate for a card based on match results of seats that maindecked it.
 * Only includes data from drafts with both decklists and match results.
 */
export async function getCardWinStats(
  params: GetCardWinStatsParams
): Promise<CardWinStatsResult | null> {
  // Resolve the card (skip if card_id already provided)
  let card_id = params.card_id;
  let card_name = params.card_name;
  if (card_id === undefined) {
    const card = await resolveCard(params.card_name);
    if (!card) return null;
    card_id = card.card_id;
    card_name = card.name;
  }

  const client = await getClient();

  const draftFilter = params.draft_id ? "AND dc.draft_id = ?" : "";
  const excludeFilter = params.exclude_draft_id ? "AND dc.draft_id != ?" : "";
  const args: (string | number)[] = [card_id];
  if (params.draft_id) args.push(params.draft_id);
  if (params.exclude_draft_id) args.push(params.exclude_draft_id);

  // Find seats that maindecked this card and have match data
  const result = await client.execute({
    sql: `SELECT
            dc.draft_id,
            dc.seat,
            SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                     WHEN me.seat2 = dc.seat THEN me.seat2_wins
                     ELSE 0 END) AS game_wins,
            SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                     WHEN me.seat2 = dc.seat THEN me.seat1_wins
                     ELSE 0 END) AS game_losses
          FROM deck_cards dc
          JOIN match_events me ON me.draft_id = dc.draft_id
            AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
          WHERE dc.card_id = ? AND dc.zone = 'deck' ${draftFilter} ${excludeFilter}
          GROUP BY dc.draft_id, dc.seat`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      card_name: card_name,
      times_maindecked: 0,
      game_wins: 0,
      game_losses: 0,
      win_rate: 0,
      drafts_with_data: 0,
    };
  }

  // Get opt-outs and optional color filter for all relevant drafts (skip if caller already fetched them)
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optedOut = params.optedOutByDraft ?? await fetchOptOuts(client, draftIds);

  // If deck_colors filter is set, determine which seats match
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(draftIds, params.deck_colors);
  }

  // Aggregate, skipping opted-out and non-matching seats
  let gameWins = 0;
  let gameLosses = 0;
  let timesMaindecked = 0;
  const draftsWithData = new Set<string>();

  for (const row of result.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    if (optedOut.has(`${draftId}:${seat}`)) continue;
    if (matchingSeats && !matchingSeats.has(`${draftId}:${seat}`)) continue;

    gameWins += row.game_wins as number;
    gameLosses += row.game_losses as number;
    timesMaindecked++;
    draftsWithData.add(draftId);
  }

  const totalGames = gameWins + gameLosses;
  const winRate = totalGames > 0 ? gameWins / totalGames : 0;

  return {
    card_name: card_name,
    times_maindecked: timesMaindecked,
    game_wins: gameWins,
    game_losses: gameLosses,
    win_rate: round3(winRate),
    drafts_with_data: draftsWithData.size,
  };
}

export type BulkWinStatsEntry = {
  win_rate: number;
  ci: { lower: number; upper: number };
  sample_size: number;
};

/**
 * Get win stats for all cards at once. Same logic as getCardWinStats but
 * aggregated across all cards in a single query, with opt-out filtering.
 */
export async function getAllCardWinStats(
  client?: Client,
): Promise<Map<string, BulkWinStatsEntry>> {
  const db = client ?? await getClient();

  const result = await db.execute({
    sql: `SELECT c.name AS card_name,
                 dc.draft_id,
                 dc.seat,
                 SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                          WHEN me.seat2 = dc.seat THEN me.seat2_wins
                          ELSE 0 END) AS game_wins,
                 SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                          WHEN me.seat2 = dc.seat THEN me.seat1_wins
                          ELSE 0 END) AS game_losses
          FROM deck_cards dc
          JOIN match_events me ON me.draft_id = dc.draft_id
            AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck'
          GROUP BY c.name, dc.draft_id, dc.seat`,
    args: [],
  });

  if (result.rows.length === 0) return new Map();

  // Get opt-outs for all drafts in the result set
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optedOut = await fetchOptOuts(db, draftIds);

  // Aggregate per card, skipping opted-out seats
  const cardAgg = new Map<string, { wins: number; losses: number; seats: number }>();

  for (const row of result.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    if (optedOut.has(`${draftId}:${seat}`)) continue;

    const cardName = row.card_name as string;
    const key = cardNameKey(cardName);

    let agg = cardAgg.get(key);
    if (!agg) {
      agg = { wins: 0, losses: 0, seats: 0 };
      cardAgg.set(key, agg);
    }
    agg.wins += row.game_wins as number;
    agg.losses += row.game_losses as number;
    agg.seats++;
  }

  // Compute win rate + Wilson CI
  const stats = new Map<string, BulkWinStatsEntry>();
  for (const [key, agg] of cardAgg) {
    const total = agg.wins + agg.losses;
    if (total === 0) continue;

    const winRate = round3(agg.wins / total);
    const ci = wilsonInterval(agg.wins, total);

    stats.set(key, {
      win_rate: winRate,
      ci: { lower: ci.lower, upper: ci.upper },
      sample_size: agg.seats,
    });
  }

  return stats;
}
