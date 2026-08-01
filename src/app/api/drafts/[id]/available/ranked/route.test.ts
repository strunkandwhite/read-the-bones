import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000/api/drafts/${id}/available/ranked`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const emptyResult = {
  draft_id: "tarkir",
  before_pick_n: 50,
  total_available: 0,
  cards: [],
};

describe("GET /api/drafts/[id]/available/ranked", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires before_pick_n", async () => {
    const res = await GET(makeRequest("tarkir"), {
      params: Promise.resolve({ id: "tarkir" }),
    });
    expect(res.status).toBe(400);
  });

  it("passes all ranking options", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
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

  it("clamps negative limit to 1 (prevents slice(0, negative) returning wrong results)", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
    await GET(
      makeRequest("tarkir", { before_pick_n: "50", limit: "-5" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(queries.rankAvailableCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 }),
    );
  });

  it("clamps limit to 1000 maximum", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
    await GET(
      makeRequest("tarkir", { before_pick_n: "50", limit: "9999" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(queries.rankAvailableCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000 }),
    );
  });

  it("uses default limit of 50 when limit is not provided", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
    await GET(
      makeRequest("tarkir", { before_pick_n: "50" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(queries.rankAvailableCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("silently ignores unrecognized sort_by values without enabling worth (documented quirk)", async () => {
    vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
    const res = await GET(
      makeRequest("tarkir", { before_pick_n: "50", sort_by: "bogus" }),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    const callArgs = vi.mocked(queries.rankAvailableCards).mock.calls[0][0];
    expect(callArgs.sort_by).toBeUndefined();
    expect(callArgs.include_worth).toBeUndefined();
  });

  describe("worth-model params (dev environment)", () => {
    it("passes seat, committed_colors, and the new sort_by values with include_worth", async () => {
      vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
      const res = await GET(
        makeRequest("tarkir", {
          before_pick_n: "50",
          seat: "3",
          committed_colors: "UR",
          sort_by: "pick_value",
        }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(res.status).toBe(200);
      expect(queries.rankAvailableCards).toHaveBeenCalledWith(
        expect.objectContaining({
          seat: 3,
          committed_colors: "UR",
          sort_by: "pick_value",
          include_worth: true,
        }),
      );
    });

    it("enables worth when only seat is provided", async () => {
      vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
      await GET(
        makeRequest("tarkir", { before_pick_n: "50", seat: "7" }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(queries.rankAvailableCards).toHaveBeenCalledWith(
        expect.objectContaining({
          seat: 7,
          sort_by: undefined,
          include_worth: true,
        }),
      );
    });

    it("accepts first_pick_score as a sort_by value", async () => {
      vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
      await GET(
        makeRequest("tarkir", { before_pick_n: "50", sort_by: "first_pick_score" }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(queries.rankAvailableCards).toHaveBeenCalledWith(
        expect.objectContaining({
          sort_by: "first_pick_score",
          include_worth: true,
        }),
      );
    });

    it("treats empty committed_colors as valid (uncommitted state)", async () => {
      vi.mocked(queries.rankAvailableCards).mockResolvedValue(emptyResult);
      const res = await GET(
        makeRequest("tarkir", { before_pick_n: "50", committed_colors: "" }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(res.status).toBe(200);
      expect(queries.rankAvailableCards).toHaveBeenCalledWith(
        expect.objectContaining({
          committed_colors: "",
          include_worth: true,
        }),
      );
    });

    it.each(["WUB", "XY", "ur"])(
      "rejects invalid committed_colors %j with 400",
      async (committedColors) => {
        const res = await GET(
          makeRequest("tarkir", {
            before_pick_n: "50",
            committed_colors: committedColors,
          }),
          { params: Promise.resolve({ id: "tarkir" }) },
        );
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toBe(
          "committed_colors must be at most two letters from WUBRG",
        );
        expect(queries.rankAvailableCards).not.toHaveBeenCalled();
      },
    );
  });

  describe("production gating (NODE_ENV, not Host header)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    async function importProductionRoute() {
      // WORTH_ENABLED is read at module load, so re-import under the stub.
      vi.stubEnv("NODE_ENV", "production");
      vi.resetModules();
      const freshQueries = await import("@/core/db/queries");
      vi.mocked(freshQueries.rankAvailableCards).mockResolvedValue(emptyResult);
      const { GET: productionGet } = await import("./route");
      return { productionGet, freshQueries };
    }

    it.each<Record<string, string>>([
      { seat: "1" },
      { committed_colors: "UR" },
      { sort_by: "pick_value" },
      { sort_by: "first_pick_score" },
    ])("returns 400 for worth params %j in production", async (params) => {
      const { productionGet, freshQueries } = await importProductionRoute();
      const res = await productionGet(
        makeRequest("tarkir", { before_pick_n: "50", ...params }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("worth model is not available in production");
      expect(freshQueries.rankAvailableCards).not.toHaveBeenCalled();
    });

    it("still serves plain rankings in production", async () => {
      const { productionGet, freshQueries } = await importProductionRoute();
      const res = await productionGet(
        makeRequest("tarkir", { before_pick_n: "50", sort_by: "win_rate" }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(res.status).toBe(200);
      expect(freshQueries.rankAvailableCards).toHaveBeenCalledWith(
        expect.objectContaining({ sort_by: "win_rate" }),
      );
      const callArgs = vi.mocked(freshQueries.rankAvailableCards).mock.calls[0][0];
      expect(callArgs.include_worth).toBeUndefined();
    });

    it("keeps ignoring OLD invalid sort_by values in production (quirk unchanged)", async () => {
      const { productionGet, freshQueries } = await importProductionRoute();
      const res = await productionGet(
        makeRequest("tarkir", { before_pick_n: "50", sort_by: "bogus" }),
        { params: Promise.resolve({ id: "tarkir" }) },
      );
      expect(res.status).toBe(200);
      const callArgs = vi.mocked(freshQueries.rankAvailableCards).mock.calls[0][0];
      expect(callArgs.sort_by).toBeUndefined();
      expect(callArgs.include_worth).toBeUndefined();
    });
  });
});
