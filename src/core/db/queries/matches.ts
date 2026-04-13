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

export interface Tiebreakers {
  omwPct: number;
  ogwPct: number;
}

/**
 * Compute WotC Swiss tiebreakers (OMW% and OGW%) for all seats.
 *
 * OMW% = average of each opponent's match win percentage (floored at 1/3).
 * OGW% = average of each opponent's game win percentage (floored at 1/3).
 */
export function computeTiebreakers(
  stats: Map<number, SeatRecord>,
  matches: Array<{ seat1: number; seat2: number; seat1Wins: number; seat2Wins: number }>,
): Map<number, Tiebreakers> {
  const result = new Map<number, Tiebreakers>();
  if (matches.length === 0) return result;

  // Build opponent adjacency: seat → set of opponent seats
  const opponents = new Map<number, Set<number>>();
  for (const m of matches) {
    if (!opponents.has(m.seat1)) opponents.set(m.seat1, new Set());
    if (!opponents.has(m.seat2)) opponents.set(m.seat2, new Set());
    opponents.get(m.seat1)!.add(m.seat2);
    opponents.get(m.seat2)!.add(m.seat1);
  }

  const FLOOR = 1 / 3;

  for (const [seat, opps] of opponents) {
    let omwSum = 0;
    let ogwSum = 0;
    let count = 0;

    for (const opp of opps) {
      const oppRec = stats.get(opp);
      if (!oppRec) continue;

      const totalMatches = oppRec.matchWins + oppRec.matchLosses;
      const mwr = totalMatches > 0 ? oppRec.matchWins / totalMatches : 0;
      omwSum += Math.max(mwr, FLOOR);

      const totalGames = oppRec.gameWins + oppRec.gameLosses;
      const gwr = totalGames > 0 ? oppRec.gameWins / totalGames : 0;
      ogwSum += Math.max(gwr, FLOOR);

      count++;
    }

    if (count > 0) {
      result.set(seat, {
        omwPct: omwSum / count,
        ogwPct: ogwSum / count,
      });
    }
  }

  return result;
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
