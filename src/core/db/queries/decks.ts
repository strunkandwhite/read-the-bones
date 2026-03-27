/**
 * Unified deck queries: mutable WIP state and immutable shared snapshots.
 * Replaces sharedDecks.ts.
 */

import type { Client } from "@libsql/client";
import { generateDeckId, migrateDeckState } from "../../deckBuilder";
import type { DeckState } from "../../types";

export interface WipDeckResult {
  draftId: string;
  seat: number;
  deckState: DeckState;
  updatedAt: string;
}

export interface SnapshotResult {
  deckId: string;
  draftId: string;
  seat: number;
  deckState: DeckState;
  createdAt: string;
}

/**
 * Get the WIP deck state for a seat in a draft.
 * Returns null if no WIP exists.
 */
export async function getWipDeck(
  client: Client,
  draftId: string,
  seat: number,
): Promise<WipDeckResult | null> {
  const result = await client.execute({
    sql: `SELECT draft_id, seat, deck_state, updated_at
          FROM decks
          WHERE draft_id = ? AND seat = ? AND kind = 'wip'`,
    args: [draftId, seat],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: migrateDeckState(JSON.parse(row.deck_state as string) as DeckState),
    updatedAt: row.updated_at as string,
  };
}

/**
 * Upsert the WIP deck state for a seat in a draft.
 * Creates if new, updates if exists.
 */
export async function upsertWipDeck(
  client: Client,
  draftId: string,
  seat: number,
  deckState: DeckState,
): Promise<void> {
  const id = generateDeckId();
  await client.execute({
    sql: `INSERT INTO decks (id, draft_id, seat, deck_state, kind, updated_at)
          VALUES (?, ?, ?, ?, 'wip', datetime('now'))
          ON CONFLICT (draft_id, seat) WHERE kind = 'wip'
          DO UPDATE SET deck_state = excluded.deck_state, updated_at = datetime('now')`,
    args: [id, draftId, seat, JSON.stringify(deckState)],
  });
}

/**
 * Create an immutable shared deck snapshot.
 * Returns the generated deck ID.
 */
export async function createSnapshot(
  client: Client,
  deckState: DeckState,
): Promise<{ deckId: string }> {
  const deckId = generateDeckId();
  await client.execute({
    sql: `INSERT INTO decks (id, draft_id, seat, deck_state, kind)
          VALUES (?, ?, ?, ?, 'snapshot')`,
    args: [deckId, deckState.draftId, deckState.seat, JSON.stringify(deckState)],
  });
  return { deckId };
}

/**
 * Retrieve a shared deck snapshot by ID.
 * Returns null if not found.
 */
export async function getSnapshot(
  client: Client,
  deckId: string,
): Promise<SnapshotResult | null> {
  const result = await client.execute({
    sql: `SELECT id, draft_id, seat, deck_state, created_at
          FROM decks
          WHERE id = ? AND kind = 'snapshot'`,
    args: [deckId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    deckId: row.id as string,
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: migrateDeckState(JSON.parse(row.deck_state as string) as DeckState),
    createdAt: row.created_at as string,
  };
}
