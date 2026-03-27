/**
 * Match result queries for live drafts.
 */

import type { Client } from "@libsql/client";

/**
 * Get the number of reported matches for a draft.
 */
export async function getMatchCount(
  client: Client,
  draftId: string,
): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM match_events WHERE draft_id = ?",
    args: [draftId],
  });
  return result.rows[0].cnt as number;
}

/**
 * Report (or update) a match result between two seats.
 * Uses INSERT OR REPLACE to allow corrections.
 * seat1 must be less than seat2 (caller normalizes).
 */
export async function reportMatchResult(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number,
  reportedBySeat: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT OR REPLACE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins, reported_by_seat)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins, reportedBySeat],
  });
}
