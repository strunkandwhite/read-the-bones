import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockGetLatestPickNumber = vi.fn();
const mockGetRecentPicks = vi.fn();
vi.mock("@/core/db/queries/picks", () => ({
  getLatestPickNumber: (...args: unknown[]) => mockGetLatestPickNumber(...args),
  getRecentPicks: (...args: unknown[]) => mockGetRecentPicks(...args),
}));

const mockGetSeatDisplayNames = vi.fn();
vi.mock("@/core/db/queries/seatTokens", () => ({
  getSeatDisplayNames: (...args: unknown[]) => mockGetSeatDisplayNames(...args),
}));

const mockGetMatchCount = vi.fn();
vi.mock("@/core/db/queries/matches", () => ({
  getMatchCount: (...args: unknown[]) => mockGetMatchCount(...args),
}));

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/drafts/[id]/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns draft status with next seat", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 10, picks_per_player: 5 }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(3);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("drafting");
    expect(body.latestPickN).toBe(3);
    expect(body.nextSeat).toBe(4);
    expect(body.numSeats).toBe(10);
    expect(body.picksPerPlayer).toBe(5);
    expect(body.recentPicks).toEqual([]);
    expect(body.seatNames).toEqual({});
    expect(body.matchCount).toBe(0);
    expect(body.totalMatches).toBe(45);
  });

  it("returns 404 for missing draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/status"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });

  it("includes recent picks and seat names", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 4, picks_per_player: 10 }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(2);
    mockGetRecentPicks.mockResolvedValueOnce([
      { pickN: 2, seat: 2, cardName: "Counterspell" },
      { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    ]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({ "1": "Alice" });
    mockGetMatchCount.mockResolvedValueOnce(1);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recentPicks).toHaveLength(2);
    expect(body.recentPicks[0].cardName).toBe("Counterspell");
    expect(body.seatNames).toEqual({ "1": "Alice" });
    expect(body.matchCount).toBe(1);
  });

  it("returns null nextSeat when picksPerPlayer is null", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "setup", num_seats: 4, picks_per_player: null }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(0);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.nextSeat).toBeNull();
  });
});
