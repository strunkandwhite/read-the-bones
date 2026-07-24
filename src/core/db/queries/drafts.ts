/**
 * Draft metadata queries.
 */

import type { Client } from "@libsql/client";
import { parseBannedCardNames, parseBannedCards } from "./helpers";

export interface DraftListItem {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  phase: string;
  sheet_id: string | null;
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
  client: Client,
  filters?: ListDraftsFilters
): Promise<DraftListItem[]> {
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
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.phase, d.sheet_id
          FROM drafts d
          ${whereClause}
          ORDER BY d.draft_date DESC`,
    args,
  });

  return result.rows.map((row) => ({
    draft_id: row.draft_id as string,
    draft_name: row.draft_name as string,
    draft_date: row.draft_date as string,
    phase: row.phase as string,
    sheet_id: row.sheet_id as string | null,
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
export async function getDraft(
  client: Client,
  draftId: string,
): Promise<DraftDetails | null> {

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

  const bannedCards = parseBannedCardNames(draft.banned_cards as string | null);

  return {
    draft_id: draft.draft_id as string,
    draft_name: draft.draft_name as string,
    draft_date: draft.draft_date as string,
    num_seats: draft.num_seats as number,
    banned_cards: bannedCards.length > 0 ? bannedCards : null,
  };
}

// ============================================================================
// Live Draft Queries
// ============================================================================

export interface DraftMeta {
  phase: string;
  numSeats: number;
  picksPerPlayer: number;
  /** Google Sheet id for sheet-synced drafts; null for live (in-app) drafts. */
  sheetId: string | null;
  /**
   * Last single-pick round ("Double Picks After:" from the sheet). Null for
   * live drafts, which derive the double-pick region heuristically.
   */
  doublePickAfterRound: number | null;
  /** Lowercase Set for fast membership testing (e.g. banned card checks). */
  bannedCards: Set<string>;
  /** Original-cased names for display in API responses. */
  bannedCardsDisplay: string[];
}

/**
 * Get live-draft metadata needed by pick processing and match routes.
 * Returns null if the draft doesn't exist.
 */
export async function getDraftMeta(
  client: Client,
  draftId: string,
): Promise<DraftMeta | null> {
  const result = await client.execute({
    sql: "SELECT phase, num_seats, picks_per_player, banned_cards, sheet_id, double_pick_after_round FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const bannedCardsRaw = row.banned_cards as string | null;
  return {
    phase: row.phase as string,
    numSeats: row.num_seats as number,
    picksPerPlayer: row.picks_per_player as number,
    sheetId: (row.sheet_id as string | null) ?? null,
    doublePickAfterRound: (row.double_pick_after_round as number | null) ?? null,
    bannedCards: parseBannedCards(bannedCardsRaw),
    bannedCardsDisplay: parseBannedCardNames(bannedCardsRaw),
  };
}

/**
 * Get the current phase of a draft.
 * Returns null if the draft doesn't exist.
 */
export async function getDraftPhase(
  client: Client,
  draftId: string,
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT phase FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].phase as string;
}
