import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/picks`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const emptyPicksResult = { draft_id: "", total: 0, picks: [] };

describe("GET /api/drafts/[id]/picks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes draft_id and optional filters", async () => {
    vi.mocked(queries.getPicks).mockResolvedValue(emptyPicksResult);
    const res = await GET(
      makeRequest("tarkir", { seat: "1", pick_n_min: "1", pick_n_max: "120" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.getPicks).toHaveBeenCalledWith({
      draft_id: "tarkir",
      seat: 1,
      pick_n_min: 1,
      pick_n_max: 120,
      card_name: undefined,
    });
    const body = await res.json();
    expect(body).toHaveProperty("draft_id");
    expect(body).toHaveProperty("total");
    expect(body).toHaveProperty("picks");
    expect(Array.isArray(body.picks)).toBe(true);
  });

  it("handles card_name filter", async () => {
    vi.mocked(queries.getPicks).mockResolvedValue(emptyPicksResult);
    const res = await GET(
      makeRequest("tarkir", { card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.getPicks).toHaveBeenCalledWith(
      expect.objectContaining({ card_name: "Lightning Bolt" }),
    );
  });

  it("returns 500 when query throws", async () => {
    vi.mocked(queries.getPicks).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(
      makeRequest("tarkir", { seat: "1" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
