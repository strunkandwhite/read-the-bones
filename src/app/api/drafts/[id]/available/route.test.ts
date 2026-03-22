import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/available`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const emptyAvailableResult = { draft_id: "", before_pick_n: 0, cards: [] };

describe("GET /api/drafts/[id]/available", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires before_pick_n", async () => {
    const res = await GET(makeRequest("tarkir"), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(400);
  });

  it("passes filters to getAvailableCards", async () => {
    vi.mocked(queries.getAvailableCards).mockResolvedValue(emptyAvailableResult);
    const res = await GET(
      makeRequest("tarkir", { before_pick_n: "50", color: "R" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.getAvailableCards).toHaveBeenCalledWith({
      draft_id: "tarkir",
      before_pick_n: 50,
      color: "R",
      type_contains: undefined,
    });
    const body = await res.json();
    expect(body).toHaveProperty("draft_id");
    expect(body).toHaveProperty("before_pick_n");
    expect(body).toHaveProperty("cards");
    expect(Array.isArray(body.cards)).toBe(true);
  });

  it("returns 500 when query throws", async () => {
    vi.mocked(queries.getAvailableCards).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(
      makeRequest("tarkir", { before_pick_n: "50" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
