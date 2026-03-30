/**
 * Match result queries for live drafts.
 */

import type { Client } from "@libsql/client";

export interface SeatRecord {
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
}

/**
 * Aggregate match results from raw match_events rows into per-seat records.
 *
 * Each row must have draft_id, seat1, seat2, seat1_wins, seat2_wins columns.
 * Returns a Map keyed by "draftId:seat" with cumulative match/game win/loss counts.
 */
export function aggregateMatchRecords(
  rows: Array<Record<string, unknown>>
): Map<string, SeatRecord> {
  const seatRecords = new Map<string, SeatRecord>();

  for (const row of rows) {
    const draftId = row.draft_id as string;
    const seat1 = row.seat1 as number;
    const seat2 = row.seat2 as number;
    const s1Wins = row.seat1_wins as number;
    const s2Wins = row.seat2_wins as number;

    for (const seat of [seat1, seat2]) {
      const key = `${draftId}:${seat}`;
      if (!seatRecords.has(key)) {
        seatRecords.set(key, { matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 });
      }
      const rec = seatRecords.get(key)!;
      if (seat === seat1) {
        rec.gameWins += s1Wins;
        rec.gameLosses += s2Wins;
        if (s1Wins > s2Wins) rec.matchWins++;
        else if (s2Wins > s1Wins) rec.matchLosses++;
      } else {
        rec.gameWins += s2Wins;
        rec.gameLosses += s1Wins;
        if (s2Wins > s1Wins) rec.matchWins++;
        else if (s1Wins > s2Wins) rec.matchLosses++;
      }
    }
  }

  return seatRecords;
}

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
