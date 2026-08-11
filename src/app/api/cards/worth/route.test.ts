import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GET } from "./route";
import * as queries from "@/core/db/queries";
import type { WorthTableResult } from "@/core/db/queries";

vi.mock("@/core/db/queries");
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

const worthTableFixture: WorthTableResult = {
  cards: [
    {
      card_name: "Lightning Bolt",
      colors: "R",
      is_land: false,
      in_current_cube: true,
      geomean: 12.3,
      games: 120,
      wins: 70,
      losses: 50,
      wr: 70 / 120,
      se: 0.045,
      delta: 0.06,
      expected: 0.04,
      pvi: 0.44,
      worth: 0.05,
      prior_only: false,
      no_data: false,
      act_by: 18,
    },
  ],
  model: {
    a: 0.12,
    b: -0.03,
    tau: 0.02,
    tau0: 0.025,
    sigma: 0.9,
    tauA: 0.015,
    grandMean: 0.51,
    kappa: 0.5,
    baselines: { W: 0.48, U: 0.52 },
    pairEdges: { UR: 0.01 },
  },
  computedAt: "2026-08-01T00:00:00.000Z",
  cardsFit: 42,
};

describe("GET /api/cards/worth", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the worth table with the model snake_cased at the boundary", async () => {
    vi.mocked(queries.getWorthTable).mockResolvedValue(worthTableFixture);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(queries.getWorthTable).toHaveBeenCalledWith();
    const body = await res.json();
    expect(body.cards).toEqual(worthTableFixture.cards);
    expect(body.model).toEqual({
      a: 0.12,
      b: -0.03,
      tau: 0.02,
      tau0: 0.025,
      sigma: 0.9,
      tau_a: 0.015,
      kappa: 0.5,
      grand_mean: 0.51,
      baselines: { W: 0.48, U: 0.52 },
      pair_edges: { UR: 0.01 },
    });
    expect(body.cards_fit).toBe(42);
    expect(body.computed_at).toBe("2026-08-01T00:00:00.000Z");
    // camelCase internals must not leak through the boundary.
    expect(body.model).not.toHaveProperty("tauA");
    expect(body.model).not.toHaveProperty("grandMean");
    expect(body.model).not.toHaveProperty("pairEdges");
    expect(body).not.toHaveProperty("cardsFit");
    expect(body).not.toHaveProperty("computedAt");
  });

  it("sets no cache-control header (dev-only, always fresh)", async () => {
    vi.mocked(queries.getWorthTable).mockResolvedValue(worthTableFixture);

    const res = await GET();

    expect(res.headers.get("Cache-Control")).toBeNull();
  });

  describe("NODE_ENV gating (env check, not Host header)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it("route is enabled based on NODE_ENV", async () => {
      // In test environment NODE_ENV !== 'production', so WORTH_ENABLED is true.
      // This verifies we're using env-based gating, not header-based.
      vi.mocked(queries.getWorthTable).mockResolvedValue(worthTableFixture);

      const res = await GET();

      expect(res.status).toBe(200);
      expect(queries.getWorthTable).toHaveBeenCalled();
    });

    it("returns 404 in production", async () => {
      // WORTH_ENABLED is read at module load, so re-import under the stubbed env.
      vi.stubEnv("NODE_ENV", "production");
      vi.resetModules();
      const { GET: productionGet } = await import("./route");

      const res = await productionGet();

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "Not found" });
      expect(queries.getWorthTable).not.toHaveBeenCalled();
    });
  });

  it("returns 500 when the query throws", async () => {
    vi.mocked(queries.getWorthTable).mockRejectedValueOnce(new Error("DB error"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET();

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Internal server error" });
    expect(consoleError).toHaveBeenCalledWith("[/api/cards/worth] Error:", expect.any(Error));
    consoleError.mockRestore();
  });
});
