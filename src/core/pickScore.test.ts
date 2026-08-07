import { describe, it, expect } from "vitest";
import { pickScore, type DraftObservation } from "./pickScore";

const seen = (pickPositions: number[], poolSize = 540): DraftObservation => ({
  pickPositions,
  poolSize,
});

describe("pickScore", () => {
  it("returns 0 when there is nothing to average", () => {
    expect(pickScore([])).toBe(0);
  });

  it("returns the position itself for a single taken copy", () => {
    expect(pickScore([seen([10])])).toBeCloseTo(10, 10);
  });

  it("averages equally-weighted first copies geometrically", () => {
    // sqrt(4 * 16) = 8
    expect(pickScore([seen([4]), seen([16])])).toBeCloseTo(8, 5);
  });

  it("halves the weight of each successive copy", () => {
    // exp((1*ln(10) + 0.5*ln(20) + 0.25*ln(30)) / 1.75)
    expect(pickScore([seen([10, 20, 30])])).toBeCloseTo(14.27, 1);
  });

  it("scores a draft nobody took the card in at pool size, half weight", () => {
    // exp((1*ln(10) + 0.5*ln(540)) / 1.5) = 37.80
    expect(pickScore([seen([10]), seen([], 540)])).toBeCloseTo(37.8, 1);
  });

  it("ignores leftover copies when at least one copy was taken", () => {
    // A qty-2 card taken once contributes only that pick — the untaken copy
    // says demand was not two deep, not that the card is unwanted.
    expect(pickScore([seen([10])])).toBeCloseTo(10, 10);
  });

  it("uses each draft's own pool size for its unpicked penalty", () => {
    // exp((0.5*ln(533) + 0.5*ln(540)) / 1)
    expect(pickScore([seen([], 533), seen([], 540)])).toBeCloseTo(536.5, 1);
  });

  it("drops non-positive positions rather than letting ln(0) corrupt the score", () => {
    expect(pickScore([seen([0]), seen([10])])).toBeCloseTo(10, 10);
    expect(pickScore([seen([-5]), seen([20])])).toBeCloseTo(20, 10);
  });

  it("returns 0 when every position is invalid", () => {
    expect(pickScore([seen([0]), seen([-10])])).toBe(0);
  });

  it("stays finite for very large positions", () => {
    const result = pickScore([seen([10000])]);
    expect(result).toBeCloseTo(10000, 10);
    expect(Number.isFinite(result)).toBe(true);
  });
});
