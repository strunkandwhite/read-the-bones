import { describe, it, expect } from "vitest";
import {
  desireAt,
  desireCurvePoints,
  desireIndex,
  formatDesireIndex,
  maxAbsWorth,
  DESIRE_HORIZON,
  type DesireInputs,
} from "./desireCurve";
import { overdueDanger, pickCdf, type WorthCard } from "@/core/worthModel";

const SIGMA = 0.534;

function inputs(worth: number, geomean: number): DesireInputs {
  return { worth, geomean, sigma: SIGMA };
}

describe("desireAt", () => {
  it("is worth × overdueDanger at the pick", () => {
    const card = inputs(0.04, 30);
    expect(desireAt(10, card)).toBeCloseTo(0.04 * overdueDanger(10, DESIRE_HORIZON, 30, SIGMA), 12);
  });

  it("holds at full worth for a card stranded past its window", () => {
    // The wheel-again discount is gone: overdue = full (worth-capped) desire.
    const card = inputs(0.059, 32);
    expect(desireAt(200, card)).toBeCloseTo(0.059 * pickCdf(200, 32, SIGMA), 6);
    expect(desireAt(200, card) / card.worth).toBeGreaterThan(0.99);
  });

  it("preserves the sign of worth", () => {
    expect(desireAt(1, inputs(-0.03, 5))).toBeLessThan(0);
    expect(desireAt(1, inputs(0.03, 5))).toBeGreaterThan(0);
  });

  it("is near zero at pick 1 for a late-geo card", () => {
    expect(Math.abs(desireAt(1, inputs(0.05, 300)))).toBeLessThan(0.001);
  });
});

describe("desireCurvePoints", () => {
  it("returns empty for degenerate inputs", () => {
    expect(desireCurvePoints({ worth: 0.04, geomean: 30, sigma: 0 }, 450)).toEqual([]);
    expect(desireCurvePoints({ worth: 0.04, geomean: 0, sigma: SIGMA }, 450)).toEqual([]);
    expect(desireCurvePoints(inputs(0.04, 30), 0)).toEqual([]);
  });

  it("spans the full domain for a late-geo card and includes the endpoint", () => {
    // geo 257: survival stays above 1% well past pick 450.
    const points = desireCurvePoints(inputs(-0.034, 257), 450);
    expect(points[0].pickN).toBe(1);
    expect(points[points.length - 1].pickN).toBe(450);
  });

  it("truncates where survival drops below 0.1%, including the crossing point", () => {
    // geo 14.8: 0.1% survival lands near pick 77 of 450.
    const points = desireCurvePoints(inputs(-0.038, 14.8), 450);
    const lastPick = points[points.length - 1].pickN;
    expect(lastPick).toBeLessThan(100);
    // The last point is at or past the cutoff; the one before is not.
    expect(1 - pickCdf(lastPick, 14.8, SIGMA)).toBeLessThan(0.001);
    const secondToLast = points[points.length - 2].pickN;
    expect(1 - pickCdf(secondToLast, 14.8, SIGMA)).toBeGreaterThanOrEqual(0.001);
  });

  it("keeps at least two points for a first-pick-geo card", () => {
    // geo 2.2 dies almost immediately; the stub must still be drawable.
    const points = desireCurvePoints(inputs(-0.023, 2.2), 450);
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it("never draws the survival-guard cliff", () => {
    // Pre-truncation, danger() snaps to 1.0 deep in the tail; adjacent
    // sampled desires must never jump by the full worth magnitude.
    const points = desireCurvePoints(inputs(-0.038, 14.8), 450);
    for (let i = 1; i < points.length; i++) {
      expect(Math.abs(points[i].desire - points[i - 1].desire)).toBeLessThan(0.02);
    }
  });
});

describe("desire index", () => {
  const card = (
    worth: number | null,
    flags: Partial<Pick<WorthCard, "prior_only" | "is_land" | "in_current_cube">> = {}
  ) =>
    ({
      worth,
      prior_only: false,
      is_land: false,
      in_current_cube: true,
      ...flags,
    }) as WorthCard;

  it("maxAbsWorth finds the largest magnitude, ignoring null worth", () => {
    expect(maxAbsWorth([card(0.03), card(-0.08), card(null), card(0.05)])).toBe(0.08);
    expect(maxAbsWorth([])).toBe(0);
    expect(maxAbsWorth([card(null)])).toBe(0);
  });

  it("maxAbsWorth excludes untrustworthy worths from the scale", () => {
    // A prior-only card's "worth" is the unshrunk price-curve prior; lands
    // are flagged unreliable; out-of-cube cards aren't the cube's signal.
    // None of them may set the ±100 denominator.
    expect(
      maxAbsWorth([
        card(0.04),
        card(0.09, { prior_only: true }),
        card(-0.12, { is_land: true }),
        card(0.2, { in_current_cube: false }),
      ])
    ).toBe(0.04);
  });

  it("desireIndex is bounded in [-100, 100] because |desire| ≤ scale", () => {
    expect(desireIndex(0.08, 0.08)).toBe(100);
    expect(desireIndex(-0.08, 0.08)).toBe(-100);
    expect(desireIndex(0.02, 0.08)).toBe(25);
  });

  it("desireIndex clamps cards whose worth exceeds the trustworthy scale", () => {
    // Excluded-from-denominator cards (prior_only, lands) can out-magnitude
    // the scale; their display index pins at ±100 instead of overflowing.
    expect(desireIndex(0.12, 0.08)).toBe(100);
    expect(desireIndex(-0.12, 0.08)).toBe(-100);
  });

  it("desireIndex returns null on a degenerate scale", () => {
    expect(desireIndex(0.02, 0)).toBeNull();
  });

  it("formatDesireIndex renders signed integers and dashes near-zero", () => {
    expect(formatDesireIndex(41.2)).toBe("+41");
    expect(formatDesireIndex(-38.4)).toBe("-38");
    expect(formatDesireIndex(0.4)).toBe("—");
    expect(formatDesireIndex(-0.4)).toBe("—");
    expect(formatDesireIndex(0.6)).toBe("+1");
  });
});
