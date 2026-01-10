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

/**
 * Represents a single match result between two players.
 */
export type MatchResult = {
  player1: string;
  player2: string;
  player1GamesWon: number;
  player2GamesWon: number;
};

/**
 * Aggregated match statistics for a single player.
 */
export type PlayerMatchStats = {
  gamesWon: number;
  gamesLost: number;
};

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
 * @returns Array of MatchResult objects
 */
export function parseMatches(csvContent: string): MatchResult[] {
  const result = Papa.parse<string[]>(csvContent, {
    skipEmptyLines: false,
  });

  if (result.errors.length > 0) {
    console.warn("CSV parsing warnings:", result.errors);
  }

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
    const player1 = row[1]?.trim();
    const player1GamesStr = row[2]?.trim();
    const vsMarker = row[3]?.trim();
    const player2GamesStr = row[4]?.trim();
    const player2 = row[5]?.trim();

    // Validate row has required data
    if (!player1 || !player2) continue;

    // Validate VS marker (sanity check)
    if (vsMarker !== "VS") continue;

    // Parse game counts
    const player1GamesWon = parseInt(player1GamesStr, 10);
    const player2GamesWon = parseInt(player2GamesStr, 10);

    // Skip rows with invalid game counts
    if (isNaN(player1GamesWon) || isNaN(player2GamesWon)) continue;

    matches.push({
      player1,
      player2,
      player1GamesWon,
      player2GamesWon,
    });
  }

  return matches;
}

/**
 * Aggregate match results into per-player statistics.
 *
 * For each player, sums up:
 * - gamesWon: Total games won across all matches
 * - gamesLost: Total games lost across all matches
 *
 * @param matches - Array of parsed match results
 * @returns Map of player name to their aggregated stats
 */
export function aggregatePlayerStats(matches: MatchResult[]): Map<string, PlayerMatchStats> {
  const stats = new Map<string, PlayerMatchStats>();

  // Helper to ensure a player exists in the map
  const ensurePlayer = (name: string): PlayerMatchStats => {
    if (!stats.has(name)) {
      stats.set(name, { gamesWon: 0, gamesLost: 0 });
    }
    return stats.get(name)!;
  };

  for (const match of matches) {
    // Update player1's stats
    const p1Stats = ensurePlayer(match.player1);
    p1Stats.gamesWon += match.player1GamesWon;
    p1Stats.gamesLost += match.player2GamesWon;

    // Update player2's stats
    const p2Stats = ensurePlayer(match.player2);
    p2Stats.gamesWon += match.player2GamesWon;
    p2Stats.gamesLost += match.player1GamesWon;
  }

  return stats;
}
