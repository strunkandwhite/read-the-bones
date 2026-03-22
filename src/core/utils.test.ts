import { describe, it, expect } from "vitest";
import { calculatePickWeight, weightedGeometricMean, round3 } from "./utils";

describe("round3", () => {
  it("rounds to 3 decimal places", () => {
    expect(round3(0.12345)).toBe(0.123);
    expect(round3(0.6789)).toBe(0.679);
  });

  it("returns integers unchanged", () => {
    expect(round3(5)).toBe(5);
    expect(round3(0)).toBe(0);
  });

  it("handles values already at 3 or fewer decimals", () => {
    expect(round3(0.5)).toBe(0.5);
    expect(round3(0.12)).toBe(0.12);
    expect(round3(0.123)).toBe(0.123);
  });

  it("rounds 0.5 at the 4th decimal up", () => {
    expect(round3(0.1235)).toBe(0.124);
  });

  it("handles negative numbers", () => {
    expect(round3(-0.12345)).toBe(-0.123);
  });
});

describe("calculatePickWeight", () => {
  it("returns 1 for first copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 1, wasPicked: true })).toBe(1);
  });
  it("returns 0.5 for first copy that was not picked", () => {
    expect(calculatePickWeight({ copyNumber: 1, wasPicked: false })).toBe(0.5);
  });
  it("returns 0.5 for second copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 2, wasPicked: true })).toBe(0.5);
  });
  it("returns 0.25 for second copy that was not picked", () => {
    expect(calculatePickWeight({ copyNumber: 2, wasPicked: false })).toBe(0.25);
  });
  it("returns 0.25 for third copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 3, wasPicked: true })).toBe(0.25);
  });
});

describe("weightedGeometricMean", () => {
  it("returns 0 for empty input", () => {
    expect(weightedGeometricMean([])).toBe(0);
  });
  it("returns the value for a single item with weight 1", () => {
    expect(weightedGeometricMean([{ weight: 1, value: 10 }])).toBeCloseTo(10, 10);
  });
  it("filters out items with value <= 0", () => {
    expect(
      weightedGeometricMean([
        { weight: 1, value: 10 },
        { weight: 1, value: 0 },
      ])
    ).toBeCloseTo(10, 10);
  });
  it("computes correct weighted geometric mean for equal weights", () => {
    // geomean of 4 and 16 with equal weights = sqrt(4*16) = 8
    const result = weightedGeometricMean([
      { weight: 1, value: 4 },
      { weight: 1, value: 16 },
    ]);
    expect(result).toBeCloseTo(8, 5);
  });
  it("applies weights correctly", () => {
    // weight 2 on value 4, weight 1 on value 16:
    // exp((2*ln(4) + 1*ln(16)) / 3) ≈ 6.3496
    const result = weightedGeometricMean([
      { weight: 2, value: 4 },
      { weight: 1, value: 16 },
    ]);
    expect(result).toBeCloseTo(6.3496, 3);
  });
  it("returns 0 when all items have zero weight", () => {
    expect(weightedGeometricMean([{ weight: 0, value: 10 }])).toBe(0);
  });
});
