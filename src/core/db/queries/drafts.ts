/**
 * Draft metadata queries.
 */

import { getClient } from "../client";

export interface DraftListItem {
  draft_id: string;
  draft_name: string;
  draft_date: string;
}

export interface ListDraftsFilters {
  date_from?: string;
  date_to?: string;
  draft_name?: string;
}

/**
 * List drafts matching optional filters.
 * Results are sorted by date descending (most recent first).
 */
export async function listDrafts(
  filters?: ListDraftsFilters
): Promise<DraftListItem[]> {
  const client = await getClient();

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters?.date_from) {
    conditions.push("d.draft_date >= ?");
    args.push(filters.date_from);
  }

  if (filters?.date_to) {
    conditions.push("d.draft_date <= ?");
    args.push(filters.date_to);
  }

  if (filters?.draft_name) {
    conditions.push("LOWER(d.draft_name) LIKE LOWER(?)");
    args.push(`%${filters.draft_name}%`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date
          FROM drafts d
          ${whereClause}
          ORDER BY d.draft_date DESC`,
    args,
  });

  return result.rows.map((row) => ({
    draft_id: row.draft_id as string,
    draft_name: row.draft_name as string,
    draft_date: row.draft_date as string,
  }));
}

export interface DraftDetails {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  num_seats: number;
  banned_cards: string[] | null;
}

/**
 * Get detailed information about a specific draft.
 * Returns null if the draft doesn't exist.
 */
export async function getDraft(draftId: string): Promise<DraftDetails | null> {
  const client = await getClient();

  const draftResult = await client.execute({
    sql: `SELECT draft_id, draft_name, draft_date, num_seats, banned_cards
          FROM drafts
          WHERE draft_id = ?`,
    args: [draftId],
  });

  if (draftResult.rows.length === 0) {
    return null;
  }

  const draft = draftResult.rows[0];

  const bannedCardsJson = draft.banned_cards as string | null;
  let bannedCards: string[] | null = null;
  if (bannedCardsJson) {
    try {
      bannedCards = JSON.parse(bannedCardsJson) as string[];
    } catch {
      // Ignore malformed JSON
    }
  }

  return {
    draft_id: draft.draft_id as string,
    draft_name: draft.draft_name as string,
    draft_date: draft.draft_date as string,
    num_seats: draft.num_seats as number,
    banned_cards: bannedCards,
  };
}
