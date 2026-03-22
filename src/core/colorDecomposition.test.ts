import { describe, it, expect } from "vitest";
import { decomposeColorPairs } from "./colorDecomposition";

describe("decomposeColorPairs", () => {
  it("decomposes pair win rates into individual color buckets", () => {
    const result = decomposeColorPairs([
      { color: "WU", wins: 10, losses: 5 },
      { color: "R", wins: 3, losses: 7 },
    ]);

    const w = result.find((r) => r.color === "W")!;
    const u = result.find((r) => r.color === "U")!;
    const r = result.find((r) => r.color === "R")!;

    // Both W and U get the full wins/losses from WU
    expect(w.wins).toBe(10);
    expect(w.losses).toBe(5);
    expect(u.wins).toBe(10);
    expect(u.losses).toBe(5);
    expect(r.wins).toBe(3);
    expect(r.losses).toBe(7);
  });

  it("handles colorless as C", () => {
    const result = decomposeColorPairs([
      { color: "C", wins: 4, losses: 6 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].color).toBe("C");
    expect(result[0].wins).toBe(4);
    expect(result[0].losses).toBe(6);
  });

  it("returns results in WUBRGC order", () => {
    const result = decomposeColorPairs([
      { color: "R", wins: 1, losses: 1 },
      { color: "C", wins: 1, losses: 1 },
      { color: "W", wins: 1, losses: 1 },
      { color: "G", wins: 1, losses: 1 },
      { color: "U", wins: 1, losses: 1 },
      { color: "B", wins: 1, losses: 1 },
    ]);

    expect(result.map((r) => r.color)).toEqual(["W", "U", "B", "R", "G", "C"]);
  });

  it("handles empty input", () => {
    const result = decomposeColorPairs([]);
    expect(result).toEqual([]);
  });

  it("computes winRate and confidence intervals", () => {
    const result = decomposeColorPairs([
      { color: "G", wins: 8, losses: 2 },
    ]);

    expect(result[0].winRate).toBeCloseTo(0.8);
    expect(result[0].ciLower).toBeGreaterThan(0);
    expect(result[0].ciUpper).toBeLessThanOrEqual(1);
    expect(result[0].ciLower).toBeLessThan(result[0].winRate);
    expect(result[0].ciUpper).toBeGreaterThan(result[0].winRate);
  });

  it("aggregates across multiple pairs sharing a color", () => {
    const result = decomposeColorPairs([
      { color: "WU", wins: 5, losses: 3 },
      { color: "WR", wins: 4, losses: 6 },
    ]);

    const w = result.find((r) => r.color === "W")!;
    // W appears in both pairs, so wins/losses are summed
    expect(w.wins).toBe(9);
    expect(w.losses).toBe(9);
  });
});
