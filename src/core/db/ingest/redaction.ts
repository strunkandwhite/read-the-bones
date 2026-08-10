/**
 * Ingest-time privacy redaction.
 *
 * An opted-out player's picks and deck cards are never stored. This module is
 * the single place that enforces it, shared by the CLI sync and the cron sync.
 *
 * Redaction used to happen at read time, in each query module. That left the
 * rows in the database and made the guarantee unverifiable — it held only as
 * long as every read path remembered to mask. Enforcing it here makes it a
 * property of the data: no pick_events or deck_cards row may exist for a seat
 * in privacy_opt_outs.
 */

import type { Client } from "@libsql/client";
import type { CardPick } from "../../types";
import { getOptedOutSeats, placeholders } from "../queries/helpers";

/**
 * Drop picks belonging to opted-out seats.
 *
 * `picks[].seat` is 0-indexed as it comes off parsePickRows; `optedOutSeats`
 * holds the 1-indexed seat numbers stored in privacy_opt_outs. The conversion
 * happens here so callers never have to think about it.
 */
export function filterRedactedPicks(
  picks: CardPick[],
  optedOutSeats: Set<number>,
): CardPick[] {
  if (optedOutSeats.size === 0) return picks;
  return picks.filter((pick) => !optedOutSeats.has(pick.seat + 1));
}

/**
 * Every table holding rows that belong to a single seat and must not survive
 * an opt-out. The delete pass, the dry-run counts and any verification query
 * all derive from this list, so adding a fourth table is one edit rather than
 * three that can silently disagree.
 */
export const REDACTED_TABLES = ["pick_events", "deck_cards", "deck_hashes"] as const;

export type RedactionCounts = { picks: number; deckCards: number; deckHashes: number };

const EMPTY_COUNTS: RedactionCounts = { picks: 0, deckCards: 0, deckHashes: 0 };

/**
 * Read-only count of what reconcileRedactedRows would delete for a draft.
 */
export async function countRedactedRows(
  client: Client,
  draftId: string,
): Promise<RedactionCounts> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) return EMPTY_COUNTS;

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  const results = await Promise.all(
    REDACTED_TABLES.map((table) =>
      client.execute({
        // REDACTED_TABLES is a fixed literal tuple, never user input, so
        // interpolating a table name here introduces no injection surface.
        sql: `SELECT COUNT(*) AS n FROM ${table} WHERE draft_id = ? AND seat IN (${ph})`,
        args: [draftId, ...seats],
      }),
    ),
  );

  const [picks, deckCards, deckHashes] = results.map((r) => Number(r.rows[0].n));
  return { picks, deckCards, deckHashes };
}

/**
 * Delete any stored rows belonging to opted-out seats.
 *
 * Run before ingesting, so the pipeline is self-healing: a draft whose picks
 * landed before its opt-outs were known gets cleaned up on the next sync
 * rather than keeping the rows forever (the incremental path only ever
 * inserts). This is also what makes the one-time migration nothing more than
 * the first run of the new pipeline.
 *
 * `getOptedOutSeats` already returns 1-indexed seats, matching the 1-indexed
 * `pick_events.seat` / `deck_cards.seat` / `deck_hashes.seat` columns directly
 * — no conversion needed here (contrast `filterRedactedPicks`, which converts).
 */
export async function reconcileRedactedRows(
  client: Client,
  draftId: string,
): Promise<{ picksDeleted: number; deckCardsDeleted: number; deckHashesDeleted: number }> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) {
    return { picksDeleted: 0, deckCardsDeleted: 0, deckHashesDeleted: 0 };
  }

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  // deck_hashes is the per-seat companion of deck_cards — provenance and the
  // incremental-diff hash. Leaving it behind gives an opted-out seat a row
  // pointing at cards that no longer exist, and this runs from a cron every
  // minute, so the orphan would be created the minute after the opt-out.
  const results = await Promise.all(
    REDACTED_TABLES.map((table) =>
      client.execute({
        // REDACTED_TABLES is a fixed literal tuple, never user input, so
        // interpolating a table name here introduces no injection surface.
        sql: `DELETE FROM ${table} WHERE draft_id = ? AND seat IN (${ph})`,
        args: [draftId, ...seats],
      }),
    ),
  );

  const [picksDeleted, deckCardsDeleted, deckHashesDeleted] = results.map(
    (r) => r.rowsAffected ?? 0,
  );

  return { picksDeleted, deckCardsDeleted, deckHashesDeleted };
}
