import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(async () => ({}) as never),
}));

const getAllCardWinStats = vi.fn();
vi.mock("@/core/db/queries", () => ({
  getAllCardWinStats: (...args: unknown[]) => getAllCardWinStats(...args),
}));

const ORIGINAL_ENV = process.env.NODE_ENV;

beforeEach(() => {
  vi.resetModules();
  getAllCardWinStats.mockReset();
});

afterEach(() => {
  vi.stubEnv("NODE_ENV", ORIGINAL_ENV ?? "test");
});

describe("GET /api/cards/win-stats", () => {
  it("returns 404 in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(404);
    expect(getAllCardWinStats).not.toHaveBeenCalled();
  });

  it("returns the bulk map as a plain object outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    getAllCardWinStats.mockResolvedValue(
      new Map([["bolt", { win_rate: 0.6, ci: { lower: 0.4, upper: 0.8 }, sample_size: 12 }]])
    );
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cards.bolt).toEqual({
      win_rate: 0.6,
      ci: { lower: 0.4, upper: 0.8 },
      sample_size: 12,
    });
  });
});
