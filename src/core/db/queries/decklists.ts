/**
 * Decklist queries (getDeck, getCardPlayStats, getCardWinStats).
 */

import { getClient } from "../client";
import { getOptedOutSeats, getSeatsMatchingColors } from "./helpers";
import { resolveCard } from "./cards";

export interface GetDeckParams {
  draft_id: string;
  seat: number;
}

export interface DeckResult {
  draft_id: string;
  seat: number | "[REDACTED]";
  deck: string[];
  sideboard: string[];
}

/**
 * Get the decklist for a specific seat in a draft.
 * Returns maindecked and sideboarded card names.
 * Redacts data for opted-out seats.
 */
export async function getDeck(params: GetDeckParams): Promise<DeckResult> {
  const client = await getClient();
  const optedOutSeats = await getOptedOutSeats(params.draft_id);

  if (optedOutSeats.has(params.seat)) {
    return {
      draft_id: params.draft_id,
      seat: "[REDACTED]",
      deck: [],
      sideboard: [],
    };
  }

  const result = await client.execute({
    sql: `SELECT c.name AS card_name, dc.zone
          FROM deck_cards dc
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.draft_id = ? AND dc.seat = ?
          ORDER BY c.name ASC`,
    args: [params.draft_id, params.seat],
  });

  const deck: string[] = [];
  const sideboard: string[] = [];

  for (const row of result.rows) {
    const name = row.card_name as string;
    const zone = row.zone as string;
    if (zone === "deck") {
      deck.push(name);
    } else {
      sideboard.push(name);
    }
  }

  return {
    draft_id: params.draft_id,
    seat: params.seat,
    deck,
    sideboard,
  };
}

export interface GetCardPlayStatsParams {
  card_name: string;
  draft_id?: string;
  deck_colors?: string;
}

export interface CardPlayStatsResult {
  card_name: string;
  times_drafted: number;
  times_maindecked: number;
  play_rate: number;
  drafts_with_decklists: number;
}

/**
 * Get play rate for a card: how often it's maindecked vs drafted,
 * across all drafts with decklist data.
 */
export async function getCardPlayStats(
  params: GetCardPlayStatsParams
): Promise<CardPlayStatsResult | null> {
  const card = await resolveCard(params.card_name);
  if (!card) return null;

  const client = await getClient();

  const draftFilter = params.draft_id
    ? "AND dc.draft_id = ?"
    : "";
  const args: (string | number)[] = [card.card_id];
  if (params.draft_id) args.push(params.draft_id);

  const result = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, dc.zone
          FROM deck_cards dc
          WHERE dc.card_id = ? ${draftFilter}`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      card_name: card.name,
      times_drafted: 0,
      times_maindecked: 0,
      play_rate: 0,
      drafts_with_decklists: 0,
    };
  }

  // Load opt-outs for relevant drafts
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optOutPlaceholders = draftIds.map(() => "?").join(", ");
  const optOutResult = await client.execute({
    sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${optOutPlaceholders})`,
    args: draftIds,
  });

  const optedOut = new Set<string>();
  for (const row of optOutResult.rows) {
    optedOut.add(`${row.draft_id}:${row.seat}`);
  }

  // If deck_colors filter is set, determine which seats match
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(draftIds, params.deck_colors);
  }

  const draftsWithDecklists = new Set<string>();
  let timesMaindecked = 0;
  let timesDrafted = 0;

  for (const row of result.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    // Skip opted-out seats
    if (optedOut.has(`${draftId}:${seat}`)) continue;
    // Skip seats that don't match the color filter
    if (matchingSeats && !matchingSeats.has(`${draftId}:${seat}`)) continue;

    timesDrafted++;
    draftsWithDecklists.add(draftId);
    if ((row.zone as string) === "deck") {
      timesMaindecked++;
    }
  }

  const playRate = timesDrafted > 0 ? timesMaindecked / timesDrafted : 0;

  return {
    card_name: card.name,
    times_drafted: timesDrafted,
    times_maindecked: timesMaindecked,
    play_rate: Math.round(playRate * 1000) / 1000,
    drafts_with_decklists: draftsWithDecklists.size,
  };
}

// ============================================================================
// Card Win Stats Query
// ============================================================================

export interface GetCardWinStatsParams {
  card_name: string;
  draft_id?: string;
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
  params: GetCardWinStatsParams
): Promise<CardWinStatsResult | null> {
  const card = await resolveCard(params.card_name);
  if (!card) return null;

  const client = await getClient();

  const draftFilter = params.draft_id ? "AND dc.draft_id = ?" : "";
  const args: (string | number)[] = [card.card_id];
  if (params.draft_id) args.push(params.draft_id);

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
          WHERE dc.card_id = ? AND dc.zone = 'deck' ${draftFilter}
          GROUP BY dc.draft_id, dc.seat`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      card_name: card.name,
      times_maindecked: 0,
      game_wins: 0,
      game_losses: 0,
      win_rate: 0,
      drafts_with_data: 0,
    };
  }

  // Get opt-outs and optional color filter for all relevant drafts
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optOutPlaceholders = draftIds.map(() => "?").join(", ");
  const optOutResult = await client.execute({
    sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${optOutPlaceholders})`,
    args: draftIds,
  });

  const optedOut = new Set<string>();
  for (const row of optOutResult.rows) {
    optedOut.add(`${row.draft_id}:${row.seat}`);
  }

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
    card_name: card.name,
    times_maindecked: timesMaindecked,
    game_wins: gameWins,
    game_losses: gameLosses,
    win_rate: Math.round(winRate * 1000) / 1000,
    drafts_with_data: draftsWithData.size,
  };
}
