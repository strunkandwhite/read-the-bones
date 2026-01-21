/**
 * CSV parsing utilities for match result data.
 *
 * Parses the specific CSV format exported from round robin tournament spreadsheets:
 * - Row 1: Title row (skip)
 * - Row 2: Empty (skip)
 * - Row 3: Header row (skip)
 * - Row 4+: Match data in columns B-H
 */

import Papa from "papaparse";
import type { MatchResult } from "./types";

// Re-export for backwards compatibility with existing imports
export type { MatchResult };

/**
 * Aggregated match statistics for a single seat (player position).
 */
export type SeatMatchStats = {
  gamesWon: number;
  gamesLost: number;
};

// Alias for backwards compatibility
export type PlayerMatchStats = SeatMatchStats;

/**
 * Parse a matches.csv file from a round robin tournament.
 *
 * CSV Format:
 * - Row 1: Title row (skip)
 * - Row 2: Empty (skip)
 * - Row 3: Header row (skip)
 * - Row 4+: Match data
 *   - Column B (index 1): Player1 name
 *   - Column C (index 2): Player1 games won
 *   - Column D (index 3): "VS" (literal, skip)
 *   - Column E (index 4): Player2 games won
 *   - Column F (index 5): Player2 name
 *   - Columns G-H: Match win indicators (not needed)
 *   - Columns J+: Aggregated standings (ignored)
 *
 * @param csvContent - Raw CSV content as string
 * @param playerNameToSeat - Map from player name to seat number (0-indexed)
 * @returns Array of MatchResult objects with seat numbers
 */
export function parseMatches(
  csvContent: string,
  playerNameToSeat: Map<string, number>
): MatchResult[] {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  // Note: Papa Parse may report recoverable errors (e.g., missing quotes, field count mismatch).
  // These don't prevent parsing - the data is still usable, so we continue silently.

  const rows = result.data;
  if (rows.length < 4) {
    return []; // Not enough rows for valid data (need 3 header rows + at least 1 data row)
  }

  const matches: MatchResult[] = [];

  // Process match rows starting from row 4 (index 3)
  for (let rowIndex = 3; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!row || row.length < 6) continue;

    // Extract match data from columns B-F (indices 1-5)
    const player1Name = row[1]?.trim();
    const player1GamesStr = row[2]?.trim();
    const vsMarker = row[3]?.trim();
    const player2GamesStr = row[4]?.trim();
    const player2Name = row[5]?.trim();

    // Validate row has required data
    if (!player1Name || !player2Name) continue;

    // Validate VS marker (sanity check)
    if (vsMarker !== "VS") continue;

    // Parse game counts
    const seat1GamesWon = parseInt(player1GamesStr, 10);
    const seat2GamesWon = parseInt(player2GamesStr, 10);

    // Skip rows with invalid game counts
    if (isNaN(seat1GamesWon) || isNaN(seat2GamesWon)) continue;

    // Look up seat numbers for player names
    const seat1 = playerNameToSeat.get(player1Name);
    const seat2 = playerNameToSeat.get(player2Name);

    // Skip rows where player names can't be mapped to seats
    if (seat1 === undefined || seat2 === undefined) continue;

    matches.push({
      seat1,
      seat2,
      seat1GamesWon,
      seat2GamesWon,
    });
  }

  return matches;
}

/**
 * Aggregate match results into per-seat statistics.
 *
 * For each seat, sums up:
 * - gamesWon: Total games won across all matches
 * - gamesLost: Total games lost across all matches
 *
 * @param matches - Array of parsed match results
 * @returns Map of seat number to their aggregated stats
 */
export function aggregateSeatStats(matches: MatchResult[]): Map<number, SeatMatchStats> {
  const stats = new Map<number, SeatMatchStats>();

  // Helper to ensure a seat exists in the map
  const ensureSeat = (seat: number): SeatMatchStats => {
    if (!stats.has(seat)) {
      stats.set(seat, { gamesWon: 0, gamesLost: 0 });
    }
    return stats.get(seat)!;
  };

  for (const match of matches) {
    // Update seat1's stats
    const s1Stats = ensureSeat(match.seat1);
    s1Stats.gamesWon += match.seat1GamesWon;
    s1Stats.gamesLost += match.seat2GamesWon;

    // Update seat2's stats
    const s2Stats = ensureSeat(match.seat2);
    s2Stats.gamesWon += match.seat2GamesWon;
    s2Stats.gamesLost += match.seat1GamesWon;
  }

  return stats;
}

// Alias for backwards compatibility
export const aggregatePlayerStats = aggregateSeatStats;
