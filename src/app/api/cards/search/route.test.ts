import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";
import * as localSearch from "@/core/localSearch";

vi.mock("@/core/db/queries");
vi.mock("@/core/localSearch");
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/cards/search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const BOLT_JSON = JSON.stringify({
  name: "Lightning Bolt",
  colors: ["R"],
  color_identity: ["R"],
  type_line: "Instant",
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  mana_cost: "{R}",
  cmc: 1,
  image_uris: { normal: "https://img/bolt.jpg" },
});

const BOLT_SCRYCARD = {
  name: "Lightning Bolt",
  imageUri: "https://img/bolt.jpg",
  manaCost: "{R}",
  manaValue: 1,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText: "Lightning Bolt deals 3 damage to any target.",
};

describe("GET /api/cards/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires q parameter", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("q parameter is required");
  });

  it("returns 400 when available_only set without draft_id", async () => {
    const res = await GET(makeRequest({ q: "t:creature", available_only: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("available_only requires draft_id");
  });

  it("returns 400 when before_pick_n set without available_only", async () => {
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "tarkir", before_pick_n: "50" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("before_pick_n requires available_only");
  });

  it("returns 400 when available_only set without before_pick_n", async () => {
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "tarkir", available_only: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("before_pick_n is required");
  });

  it("returns 404 when draft not found", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce(null);
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "nonexistent" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Draft not found");
  });

  it("performs global search", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({ q: "t:instant" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.query).toBe("t:instant");
    expect(body.total).toBe(1);
    expect(body.draft_id).toBeNull();
    expect(body.before_pick_n).toBeNull();
    expect(body.cards[0]).toEqual({
      name: "Lightning Bolt",
      image_uri: "https://img/bolt.jpg",
      mana_cost: "{R}",
      mana_value: 1,
      type_line: "Instant",
      colors: ["R"],
      color_identity: ["R"],
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
    });

    expect(queries.getSearchableCards).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("performs draft-scoped search", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({ q: "t:instant", draft_id: "tarkir" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.draft_id).toBe("tarkir");
    expect(queries.getSearchableCards).toHaveBeenCalledWith(expect.anything(), { draftId: "tarkir" });
  });

  it("performs available-only search with remaining_qty", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON, remaining_qty: 2 },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({
      q: "t:instant",
      draft_id: "tarkir",
      available_only: "true",
      before_pick_n: "50",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.before_pick_n).toBe(50);
    expect(body.cards[0].remaining_qty).toBe(2);
    expect(queries.getSearchableCards).toHaveBeenCalledWith(expect.anything(), {
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });
  });

  it("sets 5-minute cache for global queries", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([]);

    const res = await GET(makeRequest({ q: "bolt" }));
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
  });

  it("sets no-store cache for draft-scoped queries", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([]);

    const res = await GET(makeRequest({ q: "bolt", draft_id: "tarkir" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(queries.getSearchableCards).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(makeRequest({ q: "bolt" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
