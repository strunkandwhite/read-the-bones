import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/cards/stats");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/cards/stats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires card_name", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it("returns stats for a card", async () => {
    vi.mocked(queries.getCardStats).mockResolvedValue({
      card_name: "Lightning Bolt",
      oracle_text: null,
      type_line: null,
      mana_cost: null,
      color_identity: [],
      pick: { drafts_in_pool: 3, times_picked: 3, avg_pick: 12, median_pick: 10, geomean_pick: 12 },
      play: null,
      wins: null,
    });
    const res = await GET(makeRequest({ card_name: "Lightning Bolt" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.card_name).toBe("Lightning Bolt");
  });

  it("returns 404 with suggestions when card not found", async () => {
    vi.mocked(queries.getCardStats).mockResolvedValue(null);
    vi.mocked(queries.resolveCardFuzzy).mockResolvedValue({
      match: null,
      candidates: ["Lightning Bolt", "Lightning Helix"],
    });
    const res = await GET(makeRequest({ card_name: "Lightning" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.candidates).toContain("Lightning Bolt");
  });

  it("passes optional filters", async () => {
    vi.mocked(queries.getCardStats).mockResolvedValue({
      card_name: "Bolt",
      oracle_text: null,
      type_line: null,
      mana_cost: null,
      color_identity: [],
      pick: { drafts_in_pool: 1, times_picked: 1, avg_pick: 5, median_pick: 5, geomean_pick: 5 },
      play: null,
      wins: null,
    });
    await GET(makeRequest({ card_name: "Bolt", deck_colors: "RW", draft_id: "tarkir" }));
    expect(queries.getCardStats).toHaveBeenCalledWith(
      expect.objectContaining({ deck_colors: "RW", draft_id: "tarkir" }),
    );
  });
});
