import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockGetLatestPickNumber = vi.fn();
const mockGetRecentPicks = vi.fn();
const mockGetPicksWithCardDetails = vi.fn();
vi.mock("@/core/db/queries/picks", () => ({
  getLatestPickNumber: (...args: unknown[]) => mockGetLatestPickNumber(...args),
  getRecentPicks: (...args: unknown[]) => mockGetRecentPicks(...args),
  getPicksWithCardDetails: (...args: unknown[]) => mockGetPicksWithCardDetails(...args),
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

describe("GET /api/drafts/[id]/live", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns merged status + board data", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        phase: "drafting",
        num_seats: 10,
        picks_per_player: 5,
        banned_cards: null,
      }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(3);
    mockGetRecentPicks.mockResolvedValueOnce([
      { pickN: 3, seat: 3, cardName: "Counterspell" },
    ]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({ "1": "Alice" });
    mockGetMatchCount.mockResolvedValueOnce(0);
    mockGetPicksWithCardDetails.mockResolvedValueOnce([{
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    }]);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/live"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    // Status fields
    expect(body.phase).toBe("drafting");
    expect(body.numSeats).toBe(10);
    expect(body.picksPerPlayer).toBe(5);
    expect(body.latestPickN).toBe(3);
    expect(body.nextSeat).toBe(4);
    expect(body.recentPicks).toHaveLength(1);
    expect(body.recentPicks[0].cardName).toBe("Counterspell");
    expect(body.seatNames).toEqual({ "1": "Alice" });
    expect(body.matchCount).toBe(0);
    expect(body.totalMatches).toBe(45);
    // Board fields
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].cardName).toBe("Lightning Bolt");
    expect(body.picks[0].colorIdentity).toEqual(["R"]);
    expect(body.bannedCards).toEqual([]);
  });

  it("returns 404 for unknown draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/live"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });

  it("sets no-cache header", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        phase: "drafting",
        num_seats: 4,
        picks_per_player: 10,
        banned_cards: null,
      }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(0);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);
    mockGetPicksWithCardDetails.mockResolvedValueOnce([]);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/live"),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("parses banned cards correctly", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        phase: "drafting",
        num_seats: 2,
        picks_per_player: 5,
        banned_cards: JSON.stringify(["Sol Ring", "Black Lotus"]),
      }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(0);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);
    mockGetPicksWithCardDetails.mockResolvedValueOnce([]);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/live"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(body.bannedCards).toEqual(["Sol Ring", "Black Lotus"]);
  });

  it("returns null nextSeat when picksPerPlayer is null", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        phase: "setup",
        num_seats: 4,
        picks_per_player: null,
        banned_cards: null,
      }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(0);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);
    mockGetPicksWithCardDetails.mockResolvedValueOnce([]);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/live"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.nextSeat).toBeNull();
  });
});
