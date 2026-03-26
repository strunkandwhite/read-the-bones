import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
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
    mockExecute.mockResolvedValueOnce({ rows: [{ latest: 3 }] });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

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
    mockExecute.mockResolvedValueOnce({ rows: [{ latest: 2 }] });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { seat: 1, display_name: "Alice" },
        { seat: 2, display_name: null },
      ],
    });
    mockExecute.mockResolvedValueOnce({ rows: [{ cnt: 1 }] });

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
    mockExecute.mockResolvedValueOnce({ rows: [{ latest: 0 }] });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.nextSeat).toBeNull();
  });
});
