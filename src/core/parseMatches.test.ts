import { describe, it, expect } from "vitest";
import { parseMatches, aggregatePlayerStats, MatchResult } from "./parseMatches";

describe("parseMatches", () => {
  // Minimal valid CSV with real-ish structure
  const minimalCsv = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,1,VS,2,Keith,0,1
,Jack,2,VS,1,Aspi,1,0`;

  it("should parse match results from valid CSV", () => {
    const matches = parseMatches(minimalCsv);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toEqual({
      player1: "Ray Bees",
      player2: "Keith",
      player1GamesWon: 1,
      player2GamesWon: 2,
    });
    expect(matches[1]).toEqual({
      player1: "Jack",
      player2: "Aspi",
      player1GamesWon: 2,
      player2GamesWon: 1,
    });
  });

  it("should skip the first three header rows", () => {
    const matches = parseMatches(minimalCsv);
    // Should not include any header data
    const playerNames = matches.flatMap((m) => [m.player1, m.player2]);
    expect(playerNames).not.toContain("Player 1");
    expect(playerNames).not.toContain("Player 2");
  });

  it("should handle empty CSV", () => {
    const matches = parseMatches("");
    expect(matches).toEqual([]);
  });

  it("should handle CSV with only headers (no match data)", () => {
    const headerOnlyCsv = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win`;
    const matches = parseMatches(headerOnlyCsv);
    expect(matches).toEqual([]);
  });

  it("should skip rows without VS marker", () => {
    const csvWithInvalidRow = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,1,VS,2,Keith,0,1
,Invalid,1,VERSUS,2,Row,0,1
,Jack,2,VS,1,Aspi,1,0`;

    const matches = parseMatches(csvWithInvalidRow);
    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.player1 === "Invalid")).toBe(false);
  });

  it("should skip rows with invalid game counts", () => {
    const csvWithInvalidCounts = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,1,VS,2,Keith,0,1
,Invalid,abc,VS,xyz,Row,0,1
,Jack,2,VS,1,Aspi,1,0`;

    const matches = parseMatches(csvWithInvalidCounts);
    expect(matches).toHaveLength(2);
    expect(matches.some((m) => m.player1 === "Invalid")).toBe(false);
  });

  it("should skip rows with missing player names", () => {
    const csvWithMissingNames = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,1,VS,2,Keith,0,1
,,1,VS,2,Keith,0,1
,Jack,2,VS,1,,1,0
,Valid,2,VS,1,Player,1,0`;

    const matches = parseMatches(csvWithMissingNames);
    expect(matches).toHaveLength(2);
    expect(matches[0].player1).toBe("Ray Bees");
    expect(matches[1].player1).toBe("Valid");
  });

  it("should handle 0-0 ties", () => {
    const csvWithTie = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,0,VS,0,Keith,0,0`;

    const matches = parseMatches(csvWithTie);
    expect(matches).toHaveLength(1);
    expect(matches[0].player1GamesWon).toBe(0);
    expect(matches[0].player2GamesWon).toBe(0);
  });

  it("should handle high game counts (best of 5, etc)", () => {
    const csvWithBestOf5 = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,Ray Bees,3,VS,2,Keith,1,0`;

    const matches = parseMatches(csvWithBestOf5);
    expect(matches).toHaveLength(1);
    expect(matches[0].player1GamesWon).toBe(3);
    expect(matches[0].player2GamesWon).toBe(2);
  });

  it("should ignore columns beyond the match data (aggregated standings)", () => {
    // Real CSV structure has aggregated standings data in columns J+
    const csvWithStandings = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win,,Ray Bees,Jack,Aspi,Keith,Total Wins
,Ray Bees,1,VS,2,Keith,0,1,,X,2-1,1-2,1-2,4-5
,Jack,2,VS,1,Aspi,1,0,,1-2,X,2-0,2-1,5-3`;

    const matches = parseMatches(csvWithStandings);
    expect(matches).toHaveLength(2);
    // Verify we only got the match data, not standings
    expect(matches[0].player1).toBe("Ray Bees");
    expect(matches[0].player2).toBe("Keith");
  });

  it("should trim whitespace from player names", () => {
    const csvWithWhitespace = `Round Robin Tournament
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win
,  Ray Bees  ,1,VS,2,  Keith  ,0,1`;

    const matches = parseMatches(csvWithWhitespace);
    expect(matches[0].player1).toBe("Ray Bees");
    expect(matches[0].player2).toBe("Keith");
  });
});

describe("aggregatePlayerStats", () => {
  it("should aggregate stats for a single match", () => {
    const matches: MatchResult[] = [
      { player1: "Ray Bees", player2: "Keith", player1GamesWon: 1, player2GamesWon: 2 },
    ];

    const stats = aggregatePlayerStats(matches);

    expect(stats.get("Ray Bees")).toEqual({ gamesWon: 1, gamesLost: 2 });
    expect(stats.get("Keith")).toEqual({ gamesWon: 2, gamesLost: 1 });
  });

  it("should aggregate stats across multiple matches", () => {
    const matches: MatchResult[] = [
      { player1: "Ray Bees", player2: "Keith", player1GamesWon: 1, player2GamesWon: 2 },
      { player1: "Ray Bees", player2: "Jack", player1GamesWon: 2, player2GamesWon: 0 },
      { player1: "Keith", player2: "Jack", player1GamesWon: 2, player2GamesWon: 1 },
    ];

    const stats = aggregatePlayerStats(matches);

    // Ray Bees: 1-2 vs Keith, 2-0 vs Jack = 3 won, 2 lost
    expect(stats.get("Ray Bees")).toEqual({ gamesWon: 3, gamesLost: 2 });

    // Keith: 2-1 vs Ray Bees, 2-1 vs Jack = 4 won, 2 lost
    expect(stats.get("Keith")).toEqual({ gamesWon: 4, gamesLost: 2 });

    // Jack: 0-2 vs Ray Bees, 1-2 vs Keith = 1 won, 4 lost
    expect(stats.get("Jack")).toEqual({ gamesWon: 1, gamesLost: 4 });
  });

  it("should handle empty match list", () => {
    const stats = aggregatePlayerStats([]);
    expect(stats.size).toBe(0);
  });

  it("should track all unique players", () => {
    const matches: MatchResult[] = [
      { player1: "A", player2: "B", player1GamesWon: 1, player2GamesWon: 0 },
      { player1: "C", player2: "D", player1GamesWon: 1, player2GamesWon: 0 },
    ];

    const stats = aggregatePlayerStats(matches);
    expect(stats.size).toBe(4);
    expect(stats.has("A")).toBe(true);
    expect(stats.has("B")).toBe(true);
    expect(stats.has("C")).toBe(true);
    expect(stats.has("D")).toBe(true);
  });

  it("should handle 0-0 matches correctly", () => {
    const matches: MatchResult[] = [
      { player1: "Ray Bees", player2: "Keith", player1GamesWon: 0, player2GamesWon: 0 },
    ];

    const stats = aggregatePlayerStats(matches);
    expect(stats.get("Ray Bees")).toEqual({ gamesWon: 0, gamesLost: 0 });
    expect(stats.get("Keith")).toEqual({ gamesWon: 0, gamesLost: 0 });
  });
});

describe("integration: parseMatches + aggregatePlayerStats", () => {
  // Simulates a real round robin with 4 players
  const roundRobinCsv = `Round Robin Tournament Results
,
,Player 1,P1 Games,VS,P2 Games,Player 2,P1 Win,P2 Win,,Standings
,Ray Bees,2,VS,1,Keith,1,0
,Ray Bees,2,VS,0,Jack,1,0
,Ray Bees,1,VS,2,Aspi,0,1
,Keith,2,VS,1,Jack,1,0
,Keith,0,VS,2,Aspi,0,1
,Jack,1,VS,2,Aspi,0,1`;

  it("should correctly parse and aggregate a full round robin", () => {
    const matches = parseMatches(roundRobinCsv);
    expect(matches).toHaveLength(6); // 4 players = 6 matches in round robin

    const stats = aggregatePlayerStats(matches);
    expect(stats.size).toBe(4);

    // Ray Bees: 2-1, 2-0, 1-2 = 5 won, 3 lost
    expect(stats.get("Ray Bees")).toEqual({ gamesWon: 5, gamesLost: 3 });

    // Keith: 1-2, 2-1, 0-2 = 3 won, 5 lost
    expect(stats.get("Keith")).toEqual({ gamesWon: 3, gamesLost: 5 });

    // Jack: 0-2, 1-2, 1-2 = 2 won, 6 lost
    expect(stats.get("Jack")).toEqual({ gamesWon: 2, gamesLost: 6 });

    // Aspi: 2-1, 2-0, 2-1 = 6 won, 2 lost
    expect(stats.get("Aspi")).toEqual({ gamesWon: 6, gamesLost: 2 });
  });

  it("should produce consistent total game counts", () => {
    const matches = parseMatches(roundRobinCsv);
    const stats = aggregatePlayerStats(matches);

    // Total games won should equal total games lost across all players
    let totalWon = 0;
    let totalLost = 0;
    for (const playerStats of stats.values()) {
      totalWon += playerStats.gamesWon;
      totalLost += playerStats.gamesLost;
    }
    expect(totalWon).toBe(totalLost);
  });
});
