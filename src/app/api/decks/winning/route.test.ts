import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/decks/winning");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/decks/winning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires color_pair parameter", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("color_pair is required");
  });

  it("rejects invalid color_pair", async () => {
    const res = await GET(makeRequest({ color_pair: "XY" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("1-2 characters from WUBRG");
  });

  it("rejects three-color input", async () => {
    const res = await GET(makeRequest({ color_pair: "WUB" }));
    expect(res.status).toBe(400);
  });

  it("accepts valid color pairs", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockResolvedValue({
      color_pair: "UB",
      decks: [],
      overlap_cards: [],
    });
    const res = await GET(makeRequest({ color_pair: "UB" }));
    expect(res.status).toBe(200);
    expect(queries.getWinningDecksByColor).toHaveBeenCalledWith({
      color_pair: "UB",
      draft_ids: undefined,
    });
  });

  it("accepts colorless (C)", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockResolvedValue({
      color_pair: "C",
      decks: [],
      overlap_cards: [],
    });
    const res = await GET(makeRequest({ color_pair: "C" }));
    expect(res.status).toBe(200);
  });

  it("normalizes lowercase input", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockResolvedValue({
      color_pair: "UB",
      decks: [],
      overlap_cards: [],
    });
    const res = await GET(makeRequest({ color_pair: "ub" }));
    expect(res.status).toBe(200);
    expect(queries.getWinningDecksByColor).toHaveBeenCalledWith({
      color_pair: "UB",
      draft_ids: undefined,
    });
  });

  it("passes draft_ids when provided", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockResolvedValue({
      color_pair: "R",
      decks: [],
      overlap_cards: [],
    });
    const res = await GET(makeRequest({ color_pair: "R", draft_ids: "tarkir,dominaria" }));
    expect(res.status).toBe(200);
    expect(queries.getWinningDecksByColor).toHaveBeenCalledWith({
      color_pair: "R",
      draft_ids: ["tarkir", "dominaria"],
    });
  });

  it("returns full response shape", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockResolvedValue({
      color_pair: "UB",
      decks: [
        {
          draft_id: "tarkir",
          draft_name: "Tarkir",
          seat: 3,
          record: { match_wins: 7, match_losses: 2, game_wins: 14, game_losses: 7 },
        },
      ],
      overlap_cards: [{ name: "Counterspell", count: 2 }],
    });
    const res = await GET(makeRequest({ color_pair: "UB" }));
    const body = await res.json();
    expect(body.color_pair).toBe("UB");
    expect(body.decks).toHaveLength(1);
    expect(body.decks[0]).toHaveProperty("draft_id", "tarkir");
    expect(body.decks[0]).toHaveProperty("seat", 3);
    expect(body.decks[0].record).toHaveProperty("match_wins", 7);
    expect(body.decks[0].record).toHaveProperty("game_wins", 14);
    expect(body.overlap_cards).toHaveLength(1);
    expect(body.overlap_cards[0]).toEqual({ name: "Counterspell", count: 2 });
  });

  it("returns 500 when query throws", async () => {
    vi.mocked(queries.getWinningDecksByColor).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(makeRequest({ color_pair: "UB" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
