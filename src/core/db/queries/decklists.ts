/**
 * Deck fetching query (getDeck).
 *
 * Play stats, win stats, and winning decks live in dedicated modules:
 * playStats.ts, winStats.ts, winningDecks.ts.
 */

import { getClient } from "../client";

export interface GetDeckParams {
  draft_id: string;
  seat: number;
}

export interface DeckResult {
  draft_id: string;
  seat: number;
  deck: string[];
  sideboard: string[];
}

/**
 * Get the decklist for a specific seat in a draft.
 * Returns maindecked and sideboarded card names.
 */
export async function getDeck(params: GetDeckParams): Promise<DeckResult> {
  const client = await getClient();

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
