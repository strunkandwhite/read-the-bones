import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/pool`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/drafts/[id]/pool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes all pool options", async () => {
    vi.mocked(queries.getDraftPool).mockResolvedValue({
      draft_id: "tarkir",
      draft_name: "Tarkir",
      draft_date: "2025-01-01",
      total_cards: 0,
      cards: [],
      grouped: null,
    });
    const res = await GET(
      makeRequest("tarkir", {
        group_by: "color_identity",
        color: "R",
        type_contains: "Creature",
        include_draft_results: "true",
      }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.getDraftPool).toHaveBeenCalledWith(expect.anything(), {
      draft_id: "tarkir",
      include_draft_results: true,
      include_card_details: false,
      group_by: "color_identity",
      color: "R",
      type_contains: "Creature",
      name_contains: undefined,
    });
    const body = await res.json();
    expect(body).toHaveProperty("draft_id", "tarkir");
    expect(body).toHaveProperty("draft_name", "Tarkir");
    expect(body).toHaveProperty("draft_date");
    expect(body).toHaveProperty("total_cards");
    expect(body).toHaveProperty("cards");
    expect(Array.isArray(body.cards)).toBe(true);
  });

  it("returns 404 when draft pool not found", async () => {
    vi.mocked(queries.getDraftPool).mockResolvedValue(null);
    const res = await GET(makeRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });

  it("returns 500 when query throws", async () => {
    vi.mocked(queries.getDraftPool).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(makeRequest("tarkir"), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
