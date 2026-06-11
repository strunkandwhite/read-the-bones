/**
 * Query module for server-side card search.
 * Provides card data for the search API with three query paths:
 * global, draft-scoped, and available-only.
 */

import type { Client } from "@libsql/client";
import { parseBannedCards } from "./helpers";

export type SearchableCard = {
  name: string;
  scryfall_json: string;
  remaining_qty?: number;
};

type GetSearchableCardsParams = {
  draftId?: string;
  availableOnly?: boolean;
  beforePickN?: number;
};

/**
 * Fetch cards from the database for search filtering.
 *
 * Three query paths:
 * 1. Global (no draftId): all cards with scryfall_json
 * 2. Draft-scoped: cards in the draft's cube snapshot
 * 3. Available-only: draft-scoped minus picked cards and banned cards
 *
 * Returns null if draftId is provided but not found.
 */
export async function getSearchableCards(
  client: Client,
  params: GetSearchableCardsParams,
): Promise<SearchableCard[] | null> {

  // Path 1: Global search — all cards
  if (!params.draftId) {
    const result = await client.execute({
      sql: `SELECT name, scryfall_json FROM cards WHERE scryfall_json IS NOT NULL`,
      args: [],
    });
    return result.rows.map((row) => ({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
    }));
  }

  // Paths 2 & 3 need the cube snapshot (and banned cards for available-only)
  const draftResult = await client.execute({
    sql: `SELECT cube_snapshot_id, banned_cards FROM drafts WHERE draft_id = ?`,
    args: [params.draftId],
  });

  if (draftResult.rows.length === 0) {
    return null;
  }

  const cubeSnapshotId = draftResult.rows[0].cube_snapshot_id as number;

  // Parse banned cards for available-only filtering
  const bannedCards = params.availableOnly
    ? parseBannedCards(draftResult.rows[0].banned_cards as string | null)
    : new Set<string>();

  // Get all cards in the cube
  const cubeCardsResult = await client.execute({
    sql: `SELECT c.card_id, c.name, c.scryfall_json, csc.qty
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id = ? AND c.scryfall_json IS NOT NULL`,
    args: [cubeSnapshotId],
  });

  // Path 2: Draft-scoped (no availability filter)
  if (!params.availableOnly) {
    return cubeCardsResult.rows.map((row) => ({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
    }));
  }

  // Path 3: Available only — subtract picked cards
  const picksResult = await client.execute({
    sql: `SELECT card_id, COUNT(*) as pick_count
          FROM pick_events
          WHERE draft_id = ? AND pick_n < ?
          GROUP BY card_id`,
    args: [params.draftId, params.beforePickN!],
  });

  const pickedCounts = new Map<number, number>();
  for (const row of picksResult.rows) {
    pickedCounts.set(row.card_id as number, row.pick_count as number);
  }

  const available: SearchableCard[] = [];
  for (const row of cubeCardsResult.rows) {
    const cardId = row.card_id as number;
    const qty = row.qty as number;
    const picked = pickedCounts.get(cardId) || 0;
    const remaining = qty - picked;

    if (remaining <= 0) continue;
    if (bannedCards.has((row.name as string).toLowerCase())) continue;

    available.push({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
      remaining_qty: remaining,
    });
  }

  return available;
}
