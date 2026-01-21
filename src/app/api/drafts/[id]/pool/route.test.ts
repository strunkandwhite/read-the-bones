import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

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
    expect(queries.getDraftPool).toHaveBeenCalledWith({
      draft_id: "tarkir",
      include_draft_results: true,
      include_card_details: false,
      group_by: "color_identity",
      color: "R",
      type_contains: "Creature",
      name_contains: undefined,
    });
  });

  it("returns 404 when draft pool not found", async () => {
    vi.mocked(queries.getDraftPool).mockResolvedValue(null);
    const res = await GET(makeRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });
    expect(res.status).toBe(404);
  });
});
