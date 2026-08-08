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
 * Delete any stored rows belonging to opted-out seats.
 *
 * Run before ingesting, so the pipeline is self-healing: a draft whose picks
 * landed before its opt-outs were known gets cleaned up on the next sync
 * rather than keeping the rows forever (the incremental path only ever
 * inserts). This is also what makes the one-time migration nothing more than
 * the first run of the new pipeline.
 */
export async function reconcileRedactedRows(
  client: Client,
  draftId: string,
): Promise<{ picksDeleted: number; deckCardsDeleted: number }> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) {
    return { picksDeleted: 0, deckCardsDeleted: 0 };
  }

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  const picksResult = await client.execute({
    sql: `DELETE FROM pick_events WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });
  const deckCardsResult = await client.execute({
    sql: `DELETE FROM deck_cards WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });

  return {
    picksDeleted: picksResult.rowsAffected ?? 0,
    deckCardsDeleted: deckCardsResult.rowsAffected ?? 0,
  };
}
