import { describe, it, expect } from "vitest";
import { pickScore, RECENCY_HALF_LIFE_SESSIONS, type DraftObservation } from "./pickScore";

const seen = (
  pickPositions: number[],
  poolSize = 540,
  sessionsAgo = 0,
): DraftObservation => ({ sessionsAgo, pickPositions, poolSize });

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

describe("pickScore recency", () => {
  it("halves an observation's weight every RECENCY_HALF_LIFE_SESSIONS sessions", () => {
    // Recent pick at 10 (weight 1), pick four sessions back at 40 (weight 0.5):
    // exp((1*ln(10) + 0.5*ln(40)) / 1.5)
    expect(
      pickScore([seen([10], 540, 0), seen([40], 540, RECENCY_HALF_LIFE_SESSIONS)]),
    ).toBeCloseTo(15.9, 1);
  });

  it("pulls the score toward the more recent observation", () => {
    const flat = pickScore([seen([10], 540, 0), seen([40], 540, 0)]);
    const decayed = pickScore([seen([10], 540, 0), seen([40], 540, 8)]);
    expect(decayed).toBeLessThan(flat);
  });

  it("is unchanged by shifting every observation back equally", () => {
    // Weights are normalized by their sum, so a uniform shift cancels: P# moves
    // when new data lands, never merely because time passed.
    const anchored = pickScore([seen([10], 540, 0), seen([40], 540, 2)]);
    const shifted = pickScore([seen([10], 540, 3), seen([40], 540, 5)]);
    expect(shifted).toBeCloseTo(anchored, 10);
  });

  it("compounds with the copy factor", () => {
    // Four sessions back, both copies also take the 0.5 recency factor:
    // first copy 1*0.5 = 0.5, second copy 0.5*0.5 = 0.25.
    // exp((1*ln(10) + 0.5*ln(40) + 0.25*ln(40)) / 1.75) = 18.11
    expect(pickScore([seen([10], 540, 0), seen([40, 40], 540, 4)])).toBeCloseTo(18.1, 1);
    // Without decay the same observations score 22.97.
    expect(pickScore([seen([10]), seen([40, 40])])).toBeCloseTo(23.0, 1);
  });
});
