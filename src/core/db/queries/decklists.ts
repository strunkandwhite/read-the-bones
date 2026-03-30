/**
 * Decklist queries (getDeck, getCardPlayStats, getCardWinStats, getWinningDecksByColor).
 */

import type { Client } from "@libsql/client";
import { getClient } from "../client";
import { getOptedOutSeats, getSeatsMatchingColors, parseScryfallJson } from "./helpers";
import { resolveCard } from "./cards";
import { inferDeckColor } from "../../inferDeckColor";
import { round3 } from "../../utils";

/**
 * Fetch privacy opt-outs for a set of drafts, returned as "draftId:seat" pairs.
 * Extracted so callers can pre-fetch once and share across getCardPlayStats / getCardWinStats.
 */
export async function fetchOptOuts(client: Client, draftIds: string[]): Promise<Set<string>> {
  if (draftIds.length === 0) return new Set();
  const placeholders = draftIds.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${placeholders})`,
    args: draftIds,
  });
  const optedOut = new Set<string>();
  for (const row of result.rows) {
    optedOut.add(`${row.draft_id}:${row.seat}`);
  }
  return optedOut;
}

export interface GetDeckParams {
  draft_id: string;
  seat: number;
  optedOutSeats?: Set<number>;
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
  const optedOutSeats = params.optedOutSeats ?? await getOptedOutSeats(params.draft_id);

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
  card_id?: number;
  draft_id?: string;
  exclude_draft_id?: string;
  deck_colors?: string;
  /** Pre-fetched opt-outs as "draftId:seat" pairs. When provided, skips the internal opt-outs query. */
  optedOutByDraft?: Set<string>;
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

  const draftFilter = params.draft_id
    ? "AND dc.draft_id = ?"
    : "";
  const excludeFilter = params.exclude_draft_id
    ? "AND dc.draft_id != ?"
    : "";
  const args: (string | number)[] = [card_id];
  if (params.draft_id) args.push(params.draft_id);
  if (params.exclude_draft_id) args.push(params.exclude_draft_id);

  const result = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, dc.zone
          FROM deck_cards dc
          WHERE dc.card_id = ? ${draftFilter} ${excludeFilter}`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      card_name: card_name,
      times_drafted: 0,
      times_maindecked: 0,
      play_rate: 0,
      drafts_with_decklists: 0,
    };
  }

  // Load opt-outs for relevant drafts (skip if caller already fetched them)
  const draftIds = [...new Set(result.rows.map((r) => r.draft_id as string))];
  const optedOut = params.optedOutByDraft ?? await fetchOptOuts(client, draftIds);

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
    card_name: card_name,
    times_drafted: timesDrafted,
    times_maindecked: timesMaindecked,
    play_rate: round3(playRate),
    drafts_with_decklists: draftsWithDecklists.size,
  };
}

// ============================================================================
// Card Win Stats Query
// ============================================================================

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

// ============================================================================
// Winning Decks by Color Query
// ============================================================================

export interface GetWinningDecksByColorParams {
  color_pair: string;
  draft_ids?: string[];
}

export interface WinningDeck {
  draft_id: string;
  draft_name: string;
  seat: number;
  record: {
    match_wins: number;
    match_losses: number;
    game_wins: number;
    game_losses: number;
  };
}

export interface OverlapCard {
  name: string;
  count: number;
}

export interface WinningDecksByColorResult {
  color_pair: string;
  decks: WinningDeck[];
  overlap_cards: OverlapCard[];
}

/**
 * Find the top 4 winning decks for a given color archetype across all drafts.
 *
 * 1. Find all seats with maindecked cards (optionally filtered by draft_ids)
 * 2. Exclude privacy-opted-out seats
 * 3. Infer deck color per seat using the 30% threshold
 * 4. Keep only seats matching the requested color_pair exactly
 * 5. Join with match_events for win/loss records (seats without matches excluded)
 * 6. Rank by match wins DESC, then game win rate DESC
 * 7. Take top 4
 * 8. Compute overlap cards (appearing in 2+ of the returned decks)
 */
export async function getWinningDecksByColor(
  params: GetWinningDecksByColorParams
): Promise<WinningDecksByColorResult> {
  const client = await getClient();
  const colorPair = params.color_pair.toUpperCase();

  // 1. Get all maindecked cards with Scryfall data for color inference
  const draftFilter = params.draft_ids?.length
    ? `AND dc.draft_id IN (${params.draft_ids.map(() => "?").join(", ")})`
    : "";
  const draftArgs = params.draft_ids ?? [];

  const deckResult = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, c.scryfall_json, c.name AS card_name
          FROM deck_cards dc
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck' ${draftFilter}`,
    args: draftArgs,
  });

  if (deckResult.rows.length === 0) {
    return { color_pair: colorPair, decks: [], overlap_cards: [] };
  }

  // 2. Get opt-outs for all relevant drafts
  const allDraftIds = [...new Set(deckResult.rows.map((r) => r.draft_id as string))];
  const optOutPlaceholders = allDraftIds.map(() => "?").join(", ");
  const optOutResult = await client.execute({
    sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${optOutPlaceholders})`,
    args: allDraftIds,
  });
  const optedOut = new Set<string>();
  for (const row of optOutResult.rows) {
    optedOut.add(`${row.draft_id}:${row.seat}`);
  }

  // 3. Group cards by seat, infer colors, collect card names
  const seatColors = new Map<string, Map<string, number>>();
  const seatCards = new Map<string, string[]>();

  for (const row of deckResult.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    if (optedOut.has(key)) continue;

    const scryfall = parseScryfallJson(row.scryfall_json as string | null);
    const colors = scryfall?.color_identity ?? [];

    if (!seatColors.has(key)) {
      seatColors.set(key, new Map());
      seatCards.set(key, []);
    }
    const counts = seatColors.get(key)!;
    for (const color of colors) {
      counts.set(color, (counts.get(color) || 0) + 1);
    }
    seatCards.get(key)!.push(row.card_name as string);
  }

  // 4. Filter to seats matching the requested color pair exactly
  const matchingSeats: string[] = [];
  for (const [key, counts] of seatColors) {
    const inferred = inferDeckColor(counts);
    if (inferred === colorPair) {
      matchingSeats.push(key);
    }
  }

  if (matchingSeats.length === 0) {
    return { color_pair: colorPair, decks: [], overlap_cards: [] };
  }

  // 5. Get match results for matching seats
  const matchDraftIds = [...new Set(matchingSeats.map((k) => k.split(":")[0]))];
  const matchPlaceholders = matchDraftIds.map(() => "?").join(", ");
  const matchResult = await client.execute({
    sql: `SELECT me.draft_id, me.seat1, me.seat2, me.seat1_wins, me.seat2_wins
          FROM match_events me
          WHERE me.draft_id IN (${matchPlaceholders})`,
    args: matchDraftIds,
  });

  // Aggregate match records per seat
  const seatRecords = new Map<string, { matchWins: number; matchLosses: number; gameWins: number; gameLosses: number }>();
  for (const row of matchResult.rows) {
    const draftId = row.draft_id as string;
    const seat1 = row.seat1 as number;
    const seat2 = row.seat2 as number;
    const s1Wins = row.seat1_wins as number;
    const s2Wins = row.seat2_wins as number;

    for (const seat of [seat1, seat2]) {
      const key = `${draftId}:${seat}`;
      if (!seatRecords.has(key)) {
        seatRecords.set(key, { matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 });
      }
      const rec = seatRecords.get(key)!;
      if (seat === seat1) {
        rec.gameWins += s1Wins;
        rec.gameLosses += s2Wins;
        if (s1Wins > s2Wins) rec.matchWins++;
        else if (s2Wins > s1Wins) rec.matchLosses++;
      } else {
        rec.gameWins += s2Wins;
        rec.gameLosses += s1Wins;
        if (s2Wins > s1Wins) rec.matchWins++;
        else if (s1Wins > s2Wins) rec.matchLosses++;
      }
    }
  }

  // Get draft names
  const draftNamePlaceholders = matchDraftIds.map(() => "?").join(", ");
  const draftNameResult = await client.execute({
    sql: `SELECT draft_id, draft_name FROM drafts WHERE draft_id IN (${draftNamePlaceholders})`,
    args: matchDraftIds,
  });
  const draftNames = new Map<string, string>();
  for (const row of draftNameResult.rows) {
    draftNames.set(row.draft_id as string, row.draft_name as string);
  }

  // 6. Build ranked list of matching seats with match data
  const rankedDecks: WinningDeck[] = [];
  for (const key of matchingSeats) {
    const rec = seatRecords.get(key);
    if (!rec) continue; // No match data — skip

    const [draftId, seatStr] = key.split(":");
    rankedDecks.push({
      draft_id: draftId,
      draft_name: draftNames.get(draftId) ?? draftId,
      seat: parseInt(seatStr, 10),
      record: {
        match_wins: rec.matchWins,
        match_losses: rec.matchLosses,
        game_wins: rec.gameWins,
        game_losses: rec.gameLosses,
      },
    });
  }

  // Sort by match wins DESC, then game win rate DESC
  rankedDecks.sort((a, b) => {
    if (b.record.match_wins !== a.record.match_wins) {
      return b.record.match_wins - a.record.match_wins;
    }
    const aGameTotal = a.record.game_wins + a.record.game_losses;
    const bGameTotal = b.record.game_wins + b.record.game_losses;
    const aRate = aGameTotal > 0 ? a.record.game_wins / aGameTotal : 0;
    const bRate = bGameTotal > 0 ? b.record.game_wins / bGameTotal : 0;
    return bRate - aRate;
  });

  // 7. Take top 4
  const topDecks = rankedDecks.slice(0, 4);

  // 8. Compute overlap cards
  const overlapCards: OverlapCard[] = [];
  if (topDecks.length >= 2) {
    const cardCounts = new Map<string, number>();
    for (const deck of topDecks) {
      const key = `${deck.draft_id}:${deck.seat}`;
      const cards = seatCards.get(key) ?? [];
      // Deduplicate within a single deck
      const unique = new Set(cards);
      for (const card of unique) {
        cardCounts.set(card, (cardCounts.get(card) || 0) + 1);
      }
    }
    for (const [name, count] of cardCounts) {
      if (count >= 2) {
        overlapCards.push({ name, count });
      }
    }
    overlapCards.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  return {
    color_pair: colorPair,
    decks: topDecks,
    overlap_cards: overlapCards,
  };
}
