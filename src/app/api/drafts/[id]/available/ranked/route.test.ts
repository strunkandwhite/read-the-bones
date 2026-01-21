import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/available/ranked`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/drafts/[id]/available/ranked", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires before_pick_n", async () => {
    const res = await GET(makeRequest("tarkir"), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(400);
  });

  it("passes all ranking options", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue({
      draft_id: "tarkir",
      before_pick_n: 50,
      total_available: 0,
      cards: [],
    });
    const res = await GET(
      makeRequest("tarkir", {
        before_pick_n: "50",
        color: "R",
        deck_colors: "RW",
        limit: "10",
        sort_by: "win_rate",
      }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.rankAvailableCards).toHaveBeenCalledWith({
      draft_id: "tarkir",
      before_pick_n: 50,
      color: "R",
      type_contains: undefined,
      deck_colors: "RW",
      limit: 10,
      sort_by: "win_rate",
    });
  });
});
