/**
 * Color pair breakdown query — finds which color pair archetypes typically play a given card.
 */

import type { Client } from "@libsql/client";
import { parseScryfallJson } from "../helpers";
import { inferDeckColor } from "../../../inferDeckColor";

export interface ColorPairEntry {
  colorPair: string;
  percentage: number;
  deckCount: number;
}

/**
 * For a given card, find all decks that maindecked it,
 * infer each deck's color pair, and return the top 4
 * color pairs by frequency.
 */
export async function getColorPairBreakdown(
  client: Client,
  cardName: string,
  draftId?: string,
  excludeDraftId?: string,
  cardId?: number
): Promise<ColorPairEntry[]> {
  const draftFilter = draftId ? "AND dc.draft_id = ?" : "";
  const excludeFilter = excludeDraftId ? "AND dc.draft_id != ?" : "";

  // When card_id is provided, filter deck_cards directly by ID (skips the name→id join).
  const useCardId = cardId !== undefined;
  const cardFilter = useCardId ? "dc.card_id = ?" : "c.name = ?";
  const cardJoin = useCardId ? "" : "JOIN cards c ON c.card_id = dc.card_id";

  const args: (string | number)[] = [useCardId ? cardId : cardName];
  if (draftId) args.push(draftId);
  if (excludeDraftId) args.push(excludeDraftId);

  // Get all maindecked cards' Scryfall data for decks containing the target card.
  // Self-join: dc finds decks containing the target card, dc2 gets all cards in those decks.
  const result = await client.execute({
    sql: `SELECT dc2.draft_id, dc2.seat, c2.scryfall_json
          FROM deck_cards dc
          ${cardJoin}
          JOIN deck_cards dc2 ON dc2.draft_id = dc.draft_id AND dc2.seat = dc.seat
            AND dc2.zone = 'deck'
          JOIN cards c2 ON c2.card_id = dc2.card_id
          WHERE ${cardFilter} AND dc.zone = 'deck' ${draftFilter} ${excludeFilter}`,
    args,
  });

  if (result.rows.length === 0) return [];

  // Group by deck (draft_id + seat), aggregate color counts
  const deckColors = new Map<string, Map<string, number>>();
  for (const row of result.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    if (!deckColors.has(key)) deckColors.set(key, new Map());
    const colors = deckColors.get(key)!;

    const scryfall = parseScryfallJson(row.scryfall_json as string | null);
    const colorIdentity = scryfall?.color_identity ?? [];
    for (const c of colorIdentity) {
      colors.set(c, (colors.get(c) || 0) + 1);
    }
  }

  // Infer color pair for each deck
  const pairCounts = new Map<string, number>();
  for (const colors of deckColors.values()) {
    const pair = inferDeckColor(colors);
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
  }

  const totalDecks = deckColors.size;

  // Sort by count descending, top 4
  return Array.from(pairCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([colorPair, deckCount]) => ({
      colorPair,
      percentage: Math.round((deckCount / totalDecks) * 100),
      deckCount,
    }));
}
