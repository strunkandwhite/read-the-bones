import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getMatchCount,
  reportMatchResult,
  aggregateMatchRecords,
  computeTiebreakers,
} from "./matches";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

describe("getMatchCount", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("returns the count of matches", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 7 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(7);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("COUNT(*)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no matches exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("reportMatchResult", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("persists the match result with all seats, games, and reporter fields", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    await reportMatchResult(client, "draft-1", 1, 3, 2, 1, 3);

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["draft-1", 1, 3, 2, 1, 3],
      })
    );
  });
});

// ============================================================================
// aggregateMatchRecords Tests
// ============================================================================

describe("aggregateMatchRecords", () => {
  it("returns empty map for no rows", () => {
    const result = aggregateMatchRecords([]);
    expect(result.size).toBe(0);
  });

  it("correctly tracks match wins and losses for each seat", () => {
    const rows = [{ draft_id: "d1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 }];
    const result = aggregateMatchRecords(rows);

    const seat1 = result.get("d1:1")!;
    expect(seat1.matchWins).toBe(1);
    expect(seat1.matchLosses).toBe(0);
    expect(seat1.gameWins).toBe(2);
    expect(seat1.gameLosses).toBe(0);

    const seat2 = result.get("d1:2")!;
    expect(seat2.matchWins).toBe(0);
    expect(seat2.matchLosses).toBe(1);
    expect(seat2.gameWins).toBe(0);
    expect(seat2.gameLosses).toBe(2);
  });

  it("handles draws (equal wins) — no match win or loss awarded", () => {
    const rows = [{ draft_id: "d1", seat1: 1, seat2: 2, seat1_wins: 1, seat2_wins: 1 }];
    const result = aggregateMatchRecords(rows);

    const seat1 = result.get("d1:1")!;
    expect(seat1.matchWins).toBe(0);
    expect(seat1.matchLosses).toBe(0);
    expect(seat1.gameWins).toBe(1);
    expect(seat1.gameLosses).toBe(1);
  });

  it("accumulates results across multiple matches for the same seat", () => {
    const rows = [
      { draft_id: "d1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 },
      { draft_id: "d1", seat1: 1, seat2: 3, seat1_wins: 2, seat2_wins: 1 },
      { draft_id: "d1", seat1: 2, seat2: 3, seat1_wins: 0, seat2_wins: 2 },
    ];
    const result = aggregateMatchRecords(rows);

    // Seat 1: 2-0, 2-1 → 2 match wins, 0 losses, 4 game wins, 1 game loss
    const seat1 = result.get("d1:1")!;
    expect(seat1.matchWins).toBe(2);
    expect(seat1.matchLosses).toBe(0);
    expect(seat1.gameWins).toBe(4);
    expect(seat1.gameLosses).toBe(1);

    // Seat 3: beat seat 2 (2-0), lost to seat 1 (1-2) → 1-1
    // game wins: 1 (vs seat1) + 2 (vs seat2) = 3
    // game losses: 2 (vs seat1) + 0 (vs seat2) = 2
    const seat3 = result.get("d1:3")!;
    expect(seat3.matchWins).toBe(1);
    expect(seat3.matchLosses).toBe(1);
    expect(seat3.gameWins).toBe(3);
    expect(seat3.gameLosses).toBe(2);
  });

  it("keys results by draftId:seat to support multi-draft scenarios", () => {
    const rows = [
      { draft_id: "d1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 },
      { draft_id: "d2", seat1: 1, seat2: 2, seat1_wins: 0, seat2_wins: 2 },
    ];
    const result = aggregateMatchRecords(rows);

    // Same seat numbers in different drafts should be independent entries
    expect(result.get("d1:1")!.matchWins).toBe(1);
    expect(result.get("d2:1")!.matchWins).toBe(0);
    expect(result.get("d2:2")!.matchWins).toBe(1);
  });
});

// ============================================================================
// computeTiebreakers Tests
// ============================================================================

describe("computeTiebreakers", () => {
  it("returns empty map for no matches", () => {
    const result = computeTiebreakers(new Map(), []);
    expect(result.size).toBe(0);
  });

  it("applies the 1/3 floor when opponent win rate is below threshold", () => {
    // Seat 2 went 0-1 (0 match wins, 1 match loss); raw MWR = 0
    // Seat 1's OMW% should be floored at 1/3
    const stats = new Map([
      [1, { matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
    ]);
    const matches = [{ seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 }];

    const result = computeTiebreakers(stats, matches);

    // Seat 1's only opponent (seat 2) has MWR = 0, floored at 1/3
    expect(result.get(1)!.omwPct).toBeCloseTo(1 / 3, 5);
    // Seat 2's GWR for seat 2 = 0/(0+2) = 0, floored at 1/3
    expect(result.get(1)!.ogwPct).toBeCloseTo(1 / 3, 5);
  });

  it("computes average OMW% across multiple opponents", () => {
    // Seat 1 played seat 2 (1-0) and seat 3 (0-1)
    // Seat 2: 1 win, 1 loss → MWR = 0.5
    // Seat 3: 1 win, 1 loss → MWR = 0.5
    // Seat 1's OMW% = avg(0.5, 0.5) = 0.5
    const stats = new Map([
      [1, { matchWins: 1, matchLosses: 1, gameWins: 2, gameLosses: 2 }],
      [2, { matchWins: 1, matchLosses: 1, gameWins: 2, gameLosses: 2 }],
      [3, { matchWins: 1, matchLosses: 1, gameWins: 2, gameLosses: 2 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 },
      { seat1: 1, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
    ];

    const result = computeTiebreakers(stats, matches);

    expect(result.get(1)!.omwPct).toBeCloseTo(0.5, 5);
  });

  it("does not compute tiebreakers for seats with no recorded opponents", () => {
    // Seat 3 never played anyone recorded
    const stats = new Map([
      [1, { matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
    ]);
    const matches = [{ seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 }];

    const result = computeTiebreakers(stats, matches);

    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(true);
    // Seat 3 not in matches at all — not computed
    expect(result.has(3)).toBe(false);
  });
});
