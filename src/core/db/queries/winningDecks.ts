/**
 * Winning decks by color archetype — top-performing decks for a given color pair.
 */

import type { Client } from "@libsql/client";
import { inferSeatColors, placeholders } from "./helpers";
import { aggregateMatchRecords } from "./matches";


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
 * 2. Infer deck color per seat using the 30% threshold
 * 3. Keep only seats matching the requested color_pair exactly
 * 4. Join with match_events for win/loss records (seats without matches excluded)
 * 5. Rank by match wins DESC, then game win rate DESC
 * 6. Take top 4
 * 7. Compute overlap cards (appearing in 2+ of the returned decks)
 */
export async function getWinningDecksByColor(
  client: Client,
  params: GetWinningDecksByColorParams
): Promise<WinningDecksByColorResult> {
  const colorPair = params.color_pair.toUpperCase();

  // 1. Get all maindecked cards with Scryfall data for color inference
  const draftFilter = params.draft_ids?.length
    ? `AND dc.draft_id IN (${placeholders(params.draft_ids.length)})`
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

  // 2. Collect card names per seat
  const allDraftIds = [...new Set(deckResult.rows.map((r) => r.draft_id as string))];
  const seatCards = new Map<string, string[]>();
  for (const row of deckResult.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    if (!seatCards.has(key)) seatCards.set(key, []);
    seatCards.get(key)!.push(row.card_name as string);
  }

  // 3. Infer deck colors and filter to seats matching the requested color pair exactly
  const seatToColor = await inferSeatColors(client, allDraftIds);
  const matchingSeats: string[] = [];
  for (const key of seatCards.keys()) {
    const inferred = seatToColor.get(key);
    if (inferred === colorPair) {
      matchingSeats.push(key);
    }
  }

  if (matchingSeats.length === 0) {
    return { color_pair: colorPair, decks: [], overlap_cards: [] };
  }

  // 4. Get match results for matching seats
  const matchDraftIds = [...new Set(matchingSeats.map((k) => k.split(":")[0]))];
  const matchResult = await client.execute({
    sql: `SELECT me.draft_id, me.seat1, me.seat2, me.seat1_wins, me.seat2_wins
          FROM match_events me
          WHERE me.draft_id IN (${placeholders(matchDraftIds.length)})`,
    args: matchDraftIds,
  });

  // Aggregate match records per seat
  const seatRecords = aggregateMatchRecords(matchResult.rows);

  // Get draft names
  const draftNameResult = await client.execute({
    sql: `SELECT draft_id, draft_name FROM drafts WHERE draft_id IN (${placeholders(matchDraftIds.length)})`,
    args: matchDraftIds,
  });
  const draftNames = new Map<string, string>();
  for (const row of draftNameResult.rows) {
    draftNames.set(row.draft_id as string, row.draft_name as string);
  }

  // 5. Build ranked list of matching seats with match data
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

  // 6. Take top 4
  const topDecks = rankedDecks.slice(0, 4);

  // 7. Compute overlap cards
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
