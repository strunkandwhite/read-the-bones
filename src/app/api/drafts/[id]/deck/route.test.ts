import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/deck`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/drafts/[id]/deck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires seat parameter", async () => {
    const res = await GET(makeRequest("tarkir"), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns deck for seat", async () => {
    vi.mocked(queries.getDeck).mockResolvedValue({
      draft_id: "tarkir",
      seat: 3,
      deck: [],
      sideboard: [],
    });
    const res = await GET(makeRequest("tarkir", { seat: "3" }), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(200);
    expect(queries.getDeck).toHaveBeenCalledWith({ draft_id: "tarkir", seat: 3 });
  });
});
