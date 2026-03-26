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

describe("GET /api/drafts/[id]/board", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns board data with picks", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        draft_id: "test",
        num_seats: 4,
        picks_per_player: 10,
        phase: "drafting",
        banned_cards: null,
      }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Lightning Bolt",
        oracle_id: "abc-123",
        scryfall_json: JSON.stringify({ color_identity: ["R"], mana_cost: "{R}" }),
      }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ seat: 1, display_name: "Alice" }],
    });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/board"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.draftId).toBe("test");
    expect(body.numSeats).toBe(4);
    expect(body.phase).toBe("drafting");
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].cardName).toBe("Lightning Bolt");
    expect(body.picks[0].colorIdentity).toEqual(["R"]);
    expect(body.picks[0].manaCost).toBe("{R}");
    expect(body.seatNames).toEqual({ "1": "Alice" });
    expect(body.bannedCards).toEqual([]);
  });

  it("returns 404 for missing draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/board"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });

  it("parses banned cards", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        draft_id: "test",
        num_seats: 2,
        picks_per_player: 5,
        phase: "drafting",
        banned_cards: JSON.stringify(["Sol Ring", "Black Lotus"]),
      }],
    });
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/board"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.bannedCards).toEqual(["Sol Ring", "Black Lotus"]);
  });

  it("handles invalid scryfall_json gracefully", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        draft_id: "test",
        num_seats: 2,
        picks_per_player: 5,
        phase: "drafting",
        banned_cards: null,
      }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        scryfall_json: "not valid json",
      }],
    });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/board"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.picks[0].colorIdentity).toEqual([]);
    expect(body.picks[0].manaCost).toBe("");
  });
});
