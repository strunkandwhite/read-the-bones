import { describe, it, expect } from "vitest";
import { parseMatches, aggregateSeatStats, MatchResult } from "./parseMatches";

describe("parseMatches", () => {
  // Player name to seat mapping used across tests
  const defaultPlayerMap = new Map([
    ["Alice", 0],
    ["Bob", 1],
    ["Carol", 2],
    ["Dave", 3],
  ]);

  // Minimal valid CSV with real-ish structure
  const minimalCsv = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,1,VS,2,Bob,0,1
,Carol,2,VS,1,Dave,1,0`;

  it("should parse match results from valid CSV", () => {
    const matches = parseMatches(minimalCsv, defaultPlayerMap);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      seat1: 0, // Alice
      seat2: 1, // Bob
      seat1GamesWon: 1,
      seat2GamesWon: 2,
    });
    expect(matches[1]).toEqual({
      seat1: 2, // Carol
      seat2: 3, // Dave
      seat1GamesWon: 2,
      seat2GamesWon: 1,
    });
  });

  it("should skip the first three header rows", () => {
    const matches = parseMatches(minimalCsv, defaultPlayerMap);
    // Should have parsed 2 matches successfully
    expect(matches).toHaveLength(2);
    // Seats should be valid numbers, not undefined or NaN
    expect(typeof matches[0].seat1).toBe("number");
    expect(typeof matches[0].seat2).toBe("number");
  });

  it("should handle empty CSV", () => {
    const matches = parseMatches("", defaultPlayerMap);
    expect(matches).toEqual([]);
  });

  it("should handle CSV with only headers (no match data)", () => {
    const headerOnlyCsv = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win`;
    const matches = parseMatches(headerOnlyCsv, defaultPlayerMap);
    expect(matches).toEqual([]);
  });

  it("should skip rows without VS marker", () => {
    const csvWithInvalidRow = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,1,VS,2,Bob,0,1
,Invalid,1,VERSUS,2,Row,0,1
,Carol,2,VS,1,Dave,1,0`;

    // Add Invalid and Row to the map for this test
    const playerMap = new Map([
      ...defaultPlayerMap,
      ["Invalid", 4],
      ["Row", 5],
    ]);
    const matches = parseMatches(csvWithInvalidRow, playerMap);
    expect(matches).toHaveLength(2);
    // Invalid row should not be present (seat 4 should not appear)
    expect(matches.some((m) => m.seat1 === 4)).toBe(false);
  });

  it("should skip rows with invalid game counts", () => {
    const csvWithInvalidCounts = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,1,VS,2,Bob,0,1
,Invalid,abc,VS,xyz,Row,0,1
,Carol,2,VS,1,Dave,1,0`;

    // Add Invalid and Row to the map for this test
    const playerMap = new Map([
      ...defaultPlayerMap,
      ["Invalid", 4],
      ["Row", 5],
    ]);
    const matches = parseMatches(csvWithInvalidCounts, playerMap);
    expect(matches).toHaveLength(2);
    // Invalid row should not be present (seat 4 should not appear)
    expect(matches.some((m) => m.seat1 === 4)).toBe(false);
  });

  it("should skip rows with missing player names", () => {
    const csvWithMissingNames = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,1,VS,2,Bob,0,1
,,1,VS,2,Bob,0,1
,Carol,2,VS,1,,1,0
,Valid,2,VS,1,Player,1,0`;

    const playerMap = new Map([
      ...defaultPlayerMap,
      ["Valid", 4],
      ["Player", 5],
    ]);
    const matches = parseMatches(csvWithMissingNames, playerMap);
    expect(matches).toHaveLength(2);
    expect(matches[0].seat1).toBe(0); // Alice
    expect(matches[1].seat1).toBe(4); // Valid
  });

  it("should skip rows with unknown player names", () => {
    const csvWithUnknownPlayer = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,1,VS,2,Bob,0,1
,Unknown,1,VS,2,Bob,0,1`;

    // Unknown is not in the map, so that row should be skipped
    const matches = parseMatches(csvWithUnknownPlayer, defaultPlayerMap);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1).toBe(0); // Alice
  });

  it("should handle 0-0 ties", () => {
    const csvWithTie = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,0,VS,0,Bob,0,0`;

    const matches = parseMatches(csvWithTie, defaultPlayerMap);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1GamesWon).toBe(0);
    expect(matches[0].seat2GamesWon).toBe(0);
  });

  it("should handle high game counts (best of 5, etc)", () => {
    const csvWithBestOf5 = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Alice,3,VS,2,Bob,1,0`;

    const matches = parseMatches(csvWithBestOf5, defaultPlayerMap);
    expect(matches).toHaveLength(1);
    expect(matches[0].seat1GamesWon).toBe(3);
    expect(matches[0].seat2GamesWon).toBe(2);
  });

  it("should ignore columns beyond the match data (aggregated standings)", () => {
    // Real CSV structure has aggregated standings data in columns J+
    const csvWithStandings = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win,,Alice,Carol,Dave,Bob,Total Wins
,Alice,1,VS,2,Bob,0,1,,X,2-1,1-2,1-2,4-5
,Carol,2,VS,1,Dave,1,0,,1-2,X,2-0,2-1,5-3`;

    const matches = parseMatches(csvWithStandings, defaultPlayerMap);
    expect(matches).toHaveLength(2);
    // Verify we only got the match data, not standings
    expect(matches[0].seat1).toBe(0); // Alice
    expect(matches[0].seat2).toBe(1); // Bob
  });

  it("should trim whitespace from player names", () => {
    const csvWithWhitespace = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,  Alice  ,1,VS,2,  Bob  ,0,1`;

    const matches = parseMatches(csvWithWhitespace, defaultPlayerMap);
    expect(matches[0].seat1).toBe(0); // Alice (trimmed)
    expect(matches[0].seat2).toBe(1); // Bob (trimmed)
  });
});

describe("aggregateSeatStats", () => {
  it("should aggregate stats for a single match", () => {
    const matches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 1, seat2GamesWon: 2 },
    ];

    const stats = aggregateSeatStats(matches);

    expect(stats.get(0)).toEqual({ gamesWon: 1, gamesLost: 2 }); // seat 0 (Alice)
    expect(stats.get(1)).toEqual({ gamesWon: 2, gamesLost: 1 }); // seat 1 (Bob)
  });

  it("should aggregate stats across multiple matches", () => {
    const matches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 1, seat2GamesWon: 2 }, // Alice vs Bob
      { seat1: 0, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 0 }, // Alice vs Carol
      { seat1: 1, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 1 }, // Bob vs Carol
    ];

    const stats = aggregateSeatStats(matches);

    // Seat 0 (Alice): 1-2 vs Bob, 2-0 vs Carol = 3 won, 2 lost
    expect(stats.get(0)).toEqual({ gamesWon: 3, gamesLost: 2 });

    // Seat 1 (Bob): 2-1 vs Alice, 2-1 vs Carol = 4 won, 2 lost
    expect(stats.get(1)).toEqual({ gamesWon: 4, gamesLost: 2 });

    // Seat 2 (Carol): 0-2 vs Alice, 1-2 vs Bob = 1 won, 4 lost
    expect(stats.get(2)).toEqual({ gamesWon: 1, gamesLost: 4 });
  });

  it("should handle empty match list", () => {
    const stats = aggregateSeatStats([]);
    expect(stats.size).toBe(0);
  });

  it("should track all unique seats", () => {
    const matches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 1, seat2GamesWon: 0 },
      { seat1: 2, seat2: 3, seat1GamesWon: 1, seat2GamesWon: 0 },
    ];

    const stats = aggregateSeatStats(matches);
    expect(stats.size).toBe(4);
    expect(stats.has(0)).toBe(true);
    expect(stats.has(1)).toBe(true);
    expect(stats.has(2)).toBe(true);
    expect(stats.has(3)).toBe(true);
  });

  it("should handle 0-0 matches correctly", () => {
    const matches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 0, seat2GamesWon: 0 },
    ];

    const stats = aggregateSeatStats(matches);
    expect(stats.get(0)).toEqual({ gamesWon: 0, gamesLost: 0 });
    expect(stats.get(1)).toEqual({ gamesWon: 0, gamesLost: 0 });
  });
});

describe("integration: parseMatches + aggregateSeatStats", () => {
  // Player name to seat mapping
  const playerMap = new Map([
    ["Alice", 0],
    ["Bob", 1],
    ["Carol", 2],
    ["Dave", 3],
  ]);

  // Simulates a real round robin with 4 players
  const roundRobinCsv = `Round Robin Tournament Results
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win,,Standings
,Alice,2,VS,1,Bob,1,0
,Alice,2,VS,0,Carol,1,0
,Alice,1,VS,2,Dave,0,1
,Bob,2,VS,1,Carol,1,0
,Bob,0,VS,2,Dave,0,1
,Carol,1,VS,2,Dave,0,1`;

  it("should correctly parse and aggregate a full round robin", () => {
    const matches = parseMatches(roundRobinCsv, playerMap);
    expect(matches).toHaveLength(6); // 4 players = 6 matches in round robin

    const stats = aggregateSeatStats(matches);
    expect(stats.size).toBe(4);

    // Seat 0 (Alice): 2-1, 2-0, 1-2 = 5 won, 3 lost
    expect(stats.get(0)).toEqual({ gamesWon: 5, gamesLost: 3 });

    // Seat 1 (Bob): 1-2, 2-1, 0-2 = 3 won, 5 lost
    expect(stats.get(1)).toEqual({ gamesWon: 3, gamesLost: 5 });

    // Seat 2 (Carol): 0-2, 1-2, 1-2 = 2 won, 6 lost
    expect(stats.get(2)).toEqual({ gamesWon: 2, gamesLost: 6 });

    // Seat 3 (Dave): 2-1, 2-0, 2-1 = 6 won, 2 lost
    expect(stats.get(3)).toEqual({ gamesWon: 6, gamesLost: 2 });
  });

  it("should produce consistent total game counts", () => {
    const matches = parseMatches(roundRobinCsv, playerMap);
    const stats = aggregateSeatStats(matches);

    // Total games won should equal total games lost across all seats
    let totalWon = 0;
    let totalLost = 0;
    for (const seatStats of stats.values()) {
      totalWon += seatStats.gamesWon;
      totalLost += seatStats.gamesLost;
    }
    expect(totalWon).toBe(totalLost);
  });
});
