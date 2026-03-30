import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockClient = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("./db/client", () => ({
  getClient: vi.fn().mockResolvedValue(mockClient),
}));

// Mock inferSeatColors (called directly, not through client)
const mockInferSeatColors = vi.hoisted(() => vi.fn());
vi.mock("./db/queries/helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/queries/helpers")>();
  return {
    ...actual,
    inferSeatColors: mockInferSeatColors,
  };
});

import { getDraftStats } from "./getDraftStats";

// --- Test helpers ---

function completedDraftRow(
  id: string,
  {
    poolHash = "ph1",
    picksHash = "pi1",
    matchesHash = "mh1",
    numSeats = 10,
  } = {},
) {
  return {
    draft_id: id,
    pool_hash: poolHash,
    picks_hash: picksHash,
    matches_hash: matchesHash,
    num_seats: numSeats,
  };
}

function matchRow(
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number,
) {
  return {
    draft_id: draftId,
    seat1,
    seat2,
    seat1_wins: seat1Wins,
    seat2_wins: seat2Wins,
  };
}

function setupMockExecute(options: {
  completedDraftRows?: ReturnType<typeof completedDraftRow>[];
  matchRows?: ReturnType<typeof matchRow>[];
  seatColors?: Map<string, string>;
}) {
  const {
    completedDraftRows = [],
    matchRows = [],
    seatColors = new Map(),
  } = options;

  mockInferSeatColors.mockResolvedValue(seatColors);

  mockClient.execute.mockImplementation(
    (query: { sql: string; args?: unknown[] } | string) => {
      const sql = typeof query === "string" ? query : query.sql;

      // Completed drafts query
      if (sql.includes("FROM drafts") && sql.includes("phase = 'complete'")) {
        return Promise.resolve({ rows: completedDraftRows });
      }

      // Win rate by seat (the big CTE query with ten_seat_drafts)
      if (sql.includes("ten_seat_drafts")) {
        // Simulate the aggregated result: group matchRows by seat across both directions
        const seatStats = new Map<number, { wins: number; losses: number }>();
        for (const m of matchRows) {
          // Only include matches from 10-seat drafts
          const draft = completedDraftRows.find((d) => d.draft_id === m.draft_id);
          if (!draft || draft.num_seats !== 10) continue;

          if (!seatStats.has(m.seat1))
            seatStats.set(m.seat1, { wins: 0, losses: 0 });
          if (!seatStats.has(m.seat2))
            seatStats.set(m.seat2, { wins: 0, losses: 0 });

          seatStats.get(m.seat1)!.wins += m.seat1_wins;
          seatStats.get(m.seat1)!.losses += m.seat2_wins;
          seatStats.get(m.seat2)!.wins += m.seat2_wins;
          seatStats.get(m.seat2)!.losses += m.seat1_wins;
        }

        const rows = [...seatStats.entries()]
          .sort(([a], [b]) => a - b)
          .map(([seat, { wins, losses }]) => ({
            seat,
            total_wins: wins,
            total_losses: losses,
          }));

        return Promise.resolve({ rows });
      }

      // Match events for color win rate
      if (sql.includes("FROM match_events") && sql.includes("seat1_wins")) {
        return Promise.resolve({ rows: matchRows });
      }

      return Promise.resolve({ rows: [] });
    },
  );
}

// --- Tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getDraftStats", () => {
  it("returns win rate by seat across all 10-seat drafts", async () => {
    const matches = [
      matchRow("d1", 1, 2, 2, 1),
      matchRow("d1", 1, 3, 1, 2),
      matchRow("d1", 2, 3, 2, 0),
    ];

    setupMockExecute({
      completedDraftRows: [completedDraftRow("d1")],
      matchRows: matches,
      seatColors: new Map(),
    });

    const result = await getDraftStats();

    expect(result.winRateBySeat.length).toBe(3);

    const seat1 = result.winRateBySeat.find((s) => s.seat === 1)!;
    expect(seat1.wins).toBe(3); // 2 + 1
    expect(seat1.losses).toBe(3); // 1 + 2
    expect(seat1.winRate).toBeCloseTo(0.5);

    const seat2 = result.winRateBySeat.find((s) => s.seat === 2)!;
    expect(seat2.wins).toBe(3); // 1 + 2
    expect(seat2.losses).toBe(2); // 2 + 0
    expect(seat2.winRate).toBeCloseTo(0.6);

    const seat3 = result.winRateBySeat.find((s) => s.seat === 3)!;
    expect(seat3.wins).toBe(2); // 2 + 0
    expect(seat3.losses).toBe(3); // 1 + 2
    expect(seat3.winRate).toBeCloseTo(0.4);

    // All seats should have confidence intervals
    for (const seat of result.winRateBySeat) {
      expect(seat.ciLower).toBeGreaterThanOrEqual(0);
      expect(seat.ciUpper).toBeLessThanOrEqual(1);
      expect(seat.ciLower).toBeLessThanOrEqual(seat.winRate);
      expect(seat.ciUpper).toBeGreaterThanOrEqual(seat.winRate);
    }
  });

  it("returns win rate by color", async () => {
    const matches = [
      matchRow("d1", 1, 2, 2, 1),
    ];

    const seatColors = new Map<string, string>();
    seatColors.set("d1:1", "UB");
    seatColors.set("d1:2", "RG");

    setupMockExecute({
      completedDraftRows: [completedDraftRow("d1")],
      matchRows: matches,
      seatColors,
    });

    const result = await getDraftStats();

    expect(result.winRateByColor.length).toBe(2);

    const ub = result.winRateByColor.find((c) => c.color === "UB")!;
    expect(ub).toBeDefined();
    expect(ub.wins).toBe(2);
    expect(ub.losses).toBe(1);
    expect(ub.winRate).toBeCloseTo(2 / 3);

    const rg = result.winRateByColor.find((c) => c.color === "RG")!;
    expect(rg).toBeDefined();
    expect(rg.wins).toBe(1);
    expect(rg.losses).toBe(2);
    expect(rg.winRate).toBeCloseTo(1 / 3);

    // Should be sorted by win rate descending
    expect(result.winRateByColor[0].winRate).toBeGreaterThanOrEqual(
      result.winRateByColor[1].winRate,
    );
  });

  it("computes ingestionHash as a hex string", async () => {
    setupMockExecute({
      completedDraftRows: [
        completedDraftRow("d1", { poolHash: "abc", picksHash: "def", matchesHash: "ghi" }),
      ],
    });

    const result = await getDraftStats();

    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
    expect(result.ingestionHash.length).toBe(16);
  });

  it("handles empty data (no completed drafts)", async () => {
    setupMockExecute({});

    const result = await getDraftStats();

    expect(result.winRateBySeat).toEqual([]);
    expect(result.winRateByColor).toEqual([]);
    expect(result.ingestionHash).toBeDefined();
    expect(typeof result.ingestionHash).toBe("string");
  });

  it("excludes non-10-seat drafts from seat win rate", async () => {
    const matches = [
      matchRow("d1", 1, 2, 2, 1), // 10-seat
      matchRow("d2", 1, 2, 0, 3), // 12-seat, should be excluded from seat stats
    ];

    const seatColors = new Map<string, string>();
    seatColors.set("d1:1", "W");
    seatColors.set("d1:2", "B");
    seatColors.set("d2:1", "R");
    seatColors.set("d2:2", "G");

    setupMockExecute({
      completedDraftRows: [
        completedDraftRow("d1", { numSeats: 10 }),
        completedDraftRow("d2", { numSeats: 12 }),
      ],
      matchRows: matches,
      seatColors,
    });

    const result = await getDraftStats();

    // Seat stats should only reflect the 10-seat draft
    const seat1 = result.winRateBySeat.find((s) => s.seat === 1)!;
    expect(seat1.wins).toBe(2);
    expect(seat1.losses).toBe(1);

    // But color stats should include both drafts
    expect(result.winRateByColor.length).toBe(4); // W, B, R, G
  });

  it("filters by draftIds when provided", async () => {
    const matches = [
      matchRow("d1", 1, 2, 2, 1),
      matchRow("d2", 1, 2, 0, 3),
    ];

    const seatColors = new Map<string, string>();
    seatColors.set("d1:1", "UB");
    seatColors.set("d1:2", "RG");
    seatColors.set("d2:1", "W");
    seatColors.set("d2:2", "B");

    setupMockExecute({
      completedDraftRows: [completedDraftRow("d1"), completedDraftRow("d2")],
      matchRows: matches,
      seatColors,
    });

    // Only include d1
    const result = await getDraftStats({ draftIds: ["d1"] });

    // inferSeatColors should have been called with only ["d1"]
    expect(mockInferSeatColors).toHaveBeenCalledWith(["d1"]);
  });
});
