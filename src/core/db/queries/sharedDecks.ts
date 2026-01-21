/**
 * Shared deck snapshot queries (create, retrieve).
 */

import { getClient } from "../client";
import { generateDeckId } from "../../deckBuilder";
import type { DeckState } from "../../types";

export interface SharedDeckResult {
  deckId: string;
  draftId: string;
  seat: number;
  deckState: DeckState;
  createdAt: string;
}

/**
 * Create an immutable shared deck snapshot.
 * Returns the generated deck ID.
 */
export async function createSharedDeck(
  deckState: DeckState
): Promise<{ deckId: string }> {
  const client = await getClient();
  const deckId = generateDeckId();

  await client.execute({
    sql: `INSERT INTO shared_decks (deck_id, draft_id, seat, deck_state)
          VALUES (?, ?, ?, ?)`,
    args: [deckId, deckState.draftId, deckState.seat, JSON.stringify(deckState)],
  });

  return { deckId };
}

/**
 * Retrieve a shared deck snapshot by ID.
 * Returns null if not found.
 */
export async function getSharedDeck(
  deckId: string
): Promise<SharedDeckResult | null> {
  const client = await getClient();

  const result = await client.execute({
    sql: `SELECT deck_id, draft_id, seat, deck_state, created_at
          FROM shared_decks
          WHERE deck_id = ?`,
    args: [deckId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    deckId: row.deck_id as string,
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: JSON.parse(row.deck_state as string) as DeckState,
    createdAt: row.created_at as string,
  };
}
