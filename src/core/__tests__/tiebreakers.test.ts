import { describe, it, expect } from "vitest";
import { computeTiebreakers } from "../db/queries/matches";
import type { SeatRecord } from "../db/queries/matches";

describe("computeTiebreakers", () => {
  it("returns empty map for no matches", () => {
    const stats = new Map<number, SeatRecord>();
    const matches: Array<{ seat1: number; seat2: number; seat1Wins: number; seat2Wins: number }> = [];

    const result = computeTiebreakers(stats, matches);

    expect(result.size).toBe(0);
  });

  it("computes OMW% as average of opponents match win rates", () => {
    // Seat 1 beat seat 2 (2-1) and seat 3 (2-0)
    // Seat 2 beat seat 3 (2-1)
    // Records: seat 1 = 2-0, seat 2 = 1-1, seat 3 = 0-2
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 2, matchLosses: 0, gameWins: 4, gameLosses: 1 }],
      [2, { matchWins: 1, matchLosses: 1, gameWins: 3, gameLosses: 3 }],
      [3, { matchWins: 0, matchLosses: 2, gameWins: 1, gameLosses: 4 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 1 },
      { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 0 },
      { seat1: 2, seat2: 3, seat1Wins: 2, seat2Wins: 1 },
    ];

    const result = computeTiebreakers(stats, matches);

    // Seat 1's opponents: seat 2 (1/2 = 0.5), seat 3 (0/2 = 0, floored to 1/3)
    // OMW% = (0.5 + 1/3) / 2 = 5/12 ≈ 0.4167
    expect(result.get(1)!.omwPct).toBeCloseTo(5 / 12, 10);

    // Seat 2's opponents: seat 1 (2/2 = 1.0), seat 3 (0/2 = 0, floored to 1/3)
    // OMW% = (1.0 + 1/3) / 2 = 2/3 ≈ 0.6667
    expect(result.get(2)!.omwPct).toBeCloseTo(2 / 3, 10);

    // Seat 3's opponents: seat 1 (2/2 = 1.0), seat 2 (1/2 = 0.5)
    // OMW% = (1.0 + 0.5) / 2 = 0.75
    expect(result.get(3)!.omwPct).toBeCloseTo(0.75, 10);
  });

  it("floors opponent win rate at 1/3", () => {
    // Seat 1 beat seat 2. Seat 2 has 0 match wins (0/1 = 0%, floored to 1/3).
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 },
    ];

    const result = computeTiebreakers(stats, matches);

    // Seat 1's only opponent is seat 2 with 0% win rate, floored to 1/3
    expect(result.get(1)!.omwPct).toBeCloseTo(1 / 3, 10);

    // Seat 2's only opponent is seat 1 with 100% win rate
    expect(result.get(2)!.omwPct).toBeCloseTo(1.0, 10);
  });

  it("computes OGW% with game win rates", () => {
    // Seat 1 beat seat 2 (2-1) and seat 3 (2-0)
    // Seat 2 beat seat 3 (2-1)
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 2, matchLosses: 0, gameWins: 4, gameLosses: 1 }],
      [2, { matchWins: 1, matchLosses: 1, gameWins: 3, gameLosses: 3 }],
      [3, { matchWins: 0, matchLosses: 2, gameWins: 1, gameLosses: 4 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 1 },
      { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 0 },
      { seat1: 2, seat2: 3, seat1Wins: 2, seat2Wins: 1 },
    ];

    const result = computeTiebreakers(stats, matches);

    // Seat 1's opponents game win rates:
    //   seat 2: 3/6 = 0.5, seat 3: 1/5 = 0.2 (floored to 1/3)
    // OGW% = (0.5 + 1/3) / 2 = 5/12
    expect(result.get(1)!.ogwPct).toBeCloseTo(5 / 12, 10);

    // Seat 2's opponents game win rates:
    //   seat 1: 4/5 = 0.8, seat 3: 1/5 = 0.2 (floored to 1/3)
    // OGW% = (0.8 + 1/3) / 2 = 17/30
    expect(result.get(2)!.ogwPct).toBeCloseTo(17 / 30, 10);

    // Seat 3's opponents game win rates:
    //   seat 1: 4/5 = 0.8, seat 2: 3/6 = 0.5
    // OGW% = (0.8 + 0.5) / 2 = 0.65
    expect(result.get(3)!.ogwPct).toBeCloseTo(0.65, 10);
  });
});
