/**
 * Card win-rate statistics — win rate for seats that maindecked a card.
 */

import type { Client } from "@libsql/client";
import { getSeatsMatchingColors } from "./helpers";
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
  client: Client,
  params: GetCardWinStatsParams
): Promise<CardWinStatsResult | null> {
  // Resolve the card (skip if card_id already provided)
  let card_id = params.card_id;
  let card_name = params.card_name;
  if (card_id === undefined) {
    const card = await resolveCard(client, params.card_name);
    if (!card) return null;
    card_id = card.card_id;
    card_name = card.name;
  }

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

  // Get optional color filter for all relevant drafts
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];

  // If deck_colors filter is set, determine which seats match
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(client, draftIds, params.deck_colors);
  }

  // Aggregate, skipping non-matching seats
  let gameWins = 0;
  let gameLosses = 0;
  let timesMaindecked = 0;
  const draftsWithData = new Set<string>();

  for (const row of result.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

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
 * aggregated across all cards in a single query.
 */
export async function getAllCardWinStats(
  client: Client,
): Promise<Map<string, BulkWinStatsEntry>> {
  const db = client;

  const result = await db.execute({
    // Pre-aggregating match results per (draft_id, seat) is what makes this
    // affordable. Joining deck_cards directly to match_events needs
    // `(me.seat1 = dc.seat OR me.seat2 = dc.seat)`, which no index can serve:
    // the planner scans deck_cards and re-reads every match row of the draft
    // for each one. Folding the two seat columns into one via UNION ALL first
    // yields ~one row per drafted seat, which the planner then drives the join
    // from, seeking deck_cards on its full (draft_id, seat) key.
    sql: `WITH seat_totals AS (
            SELECT draft_id, seat, SUM(w) AS game_wins, SUM(l) AS game_losses
            FROM (
              SELECT draft_id, seat1 AS seat, seat1_wins AS w, seat2_wins AS l FROM match_events
              UNION ALL
              SELECT draft_id, seat2 AS seat, seat2_wins AS w, seat1_wins AS l FROM match_events
            )
            GROUP BY draft_id, seat
          )
          SELECT c.name AS card_name,
                 dc.draft_id,
                 dc.seat,
                 st.game_wins,
                 st.game_losses
          FROM deck_cards dc
          JOIN seat_totals st ON st.draft_id = dc.draft_id AND st.seat = dc.seat
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck'`,
    args: [],
  });

  if (result.rows.length === 0) return new Map();

  // Aggregate per card
  const cardAgg = new Map<string, { wins: number; losses: number; seats: number }>();

  for (const row of result.rows) {
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
