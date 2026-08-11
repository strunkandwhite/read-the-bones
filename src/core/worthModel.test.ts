import { describe, it, expect } from "vitest";
import {
  fitPriceCurve,
  estimateTau,
  estimateTauDL,
  overdueDanger,
  shrinkQuality,
  normalCdf,
  pickCdf,
  danger,
  actBy,
  colorFlag,
  pairSupply,
} from "./worthModel";

describe("fitPriceCurve", () => {
  it("recovers known coefficients from points exactly on a line", () => {
    const a = 0.0255;
    const b = -0.007;
    const pts = [5, 20, 80, 200].map((geo, i) => ({
      lnGeo: Math.log(geo),
      delta: a + b * Math.log(geo),
      se: [0.02, 0.05, 0.01, 0.03][i],
    }));
    const fit = fitPriceCurve(pts);
    expect(fit.a).toBeCloseTo(a, 10);
    expect(fit.b).toBeCloseTo(b, 10);
  });

  it("weights by 1/se²: a huge-se outlier barely moves the fit", () => {
    const pts = [
      { lnGeo: 0, delta: 0, se: 0.1 },
      { lnGeo: 1, delta: 1, se: 0.1 },
      { lnGeo: 2, delta: 10, se: 1000 },
    ];
    const fit = fitPriceCurve(pts);
    expect(fit.a).toBeCloseTo(0, 3);
    expect(fit.b).toBeCloseTo(1, 3);
  });

  it("returns a flat zero curve for empty input", () => {
    expect(fitPriceCurve([])).toEqual({ a: 0, b: 0 });
  });

  it("returns the weighted mean with b = 0 when lnGeo has no spread", () => {
    const singlePoint = fitPriceCurve([{ lnGeo: 2, delta: 0.05, se: 0.1 }]);
    expect(singlePoint.b).toBe(0);
    expect(singlePoint.a).toBeCloseTo(0.05, 10);

    const sameX = fitPriceCurve([
      { lnGeo: 3, delta: 0.02, se: 0.1 },
      { lnGeo: 3, delta: 0.04, se: 0.1 },
    ]);
    expect(sameX.b).toBe(0);
    expect(sameX.a).toBeCloseTo(0.03, 10);
  });
});

describe("estimateTau", () => {
  it("matches the hand-computed method-of-moments value", () => {
    // mean(0.05² − 0.03², 0.05² − 0.04²) = mean(0.0016, 0.0009) = 0.00125
    const tau = estimateTau([
      { resid: 0.05, se: 0.03 },
      { resid: -0.05, se: 0.04 },
    ]);
    expect(tau).toBeCloseTo(Math.sqrt(0.00125), 10);
  });

  it("floors at 0 when sampling noise exceeds the residuals", () => {
    expect(estimateTau([{ resid: 0.01, se: 0.1 }])).toBe(0);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTau([])).toBe(0);
  });
});

describe("estimateTauDL", () => {
  it("matches a hand-computed symmetric two-group case", () => {
    // w = 100 each, fixedMean = 0, Q = 100·0.01 + 100·0.01 = 2, df = 1,
    // c = 200 − 20000/200 = 100, τ_a² = (2 − 1)/100 = 0.01 → τ_a = 0.1.
    // Random-effects weights are equal, so grandMean stays 0.
    const { tauA, grandMean } = estimateTauDL([
      { delta: 0.1, se: 0.1 },
      { delta: -0.1, se: 0.1 },
    ]);
    expect(tauA).toBeCloseTo(0.1, 10);
    expect(grandMean).toBeCloseTo(0, 10);
  });

  it("floors τ_a at 0 and falls back to fixed-effect pooling", () => {
    // w = 100, 25: fixedMean = 20/125 = 0.16,
    // Q = 100·0.04² + 25·0.16² = 0.8 < df = 1 → τ_a = 0.
    const { tauA, grandMean } = estimateTauDL([
      { delta: 0.2, se: 0.1 },
      { delta: 0.0, se: 0.2 },
    ]);
    expect(tauA).toBe(0);
    expect(grandMean).toBeCloseTo(0.16, 10);
  });

  it("handles degenerate inputs", () => {
    expect(estimateTauDL([])).toEqual({ tauA: 0, grandMean: 0 });
    expect(estimateTauDL([{ delta: 0.03, se: 0.1 }])).toEqual({
      tauA: 0,
      grandMean: 0.03,
    });
  });
});

describe("shrinkQuality", () => {
  it("gives full weight to the observation as se → 0", () => {
    const { worth, w } = shrinkQuality(0.08, 0.03, 0);
    expect(w).toBe(1);
    expect(worth).toBeCloseTo(0.08, 10);
  });

  it("shrinks fully to zero as se → ∞", () => {
    const { worth, w } = shrinkQuality(0.08, 0.03, 1e9);
    expect(w).toBeCloseTo(0, 10);
    expect(worth).toBeCloseTo(0, 10);
  });

  it("halves the observation when tau0 equals se", () => {
    const { worth, w } = shrinkQuality(0.08, 0.03, 0.03);
    expect(w).toBeCloseTo(0.5, 10);
    expect(worth).toBeCloseTo(0.04, 10);
  });

  it("preserves sign for negative deltas", () => {
    expect(shrinkQuality(-0.06, 0.03, 0.03).worth).toBeCloseTo(-0.03, 10);
  });

  it("collapses to zero when tau0 = 0, even at se = 0", () => {
    expect(shrinkQuality(0.08, 0, 0)).toEqual({ worth: 0, w: 0 });
    expect(shrinkQuality(0.08, 0, 0.05).worth).toBeCloseTo(0, 10);
  });
});

describe("normalCdf", () => {
  it("matches known values within the A&S 7.1.26 accuracy", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975002, 5);
    expect(normalCdf(-1.96)).toBeCloseTo(0.024998, 5);
  });

  it("is symmetric: Φ(x) + Φ(−x) = 1", () => {
    for (const x of [0.3, 1.1, 2.7, 4.2]) {
      expect(normalCdf(x) + normalCdf(-x)).toBeCloseTo(1, 7);
    }
  });

  it("saturates in the tails", () => {
    expect(normalCdf(10)).toBe(1);
    expect(normalCdf(-10)).toBe(0);
  });
});

describe("pickCdf", () => {
  it("is 0.5 at the geomean", () => {
    expect(pickCdf(50, 50, 0.5)).toBeCloseTo(0.5, 7);
  });

  it("is 0 at or below pick position 0", () => {
    expect(pickCdf(0, 50, 0.5)).toBe(0);
    expect(pickCdf(-5, 50, 0.5)).toBe(0);
  });

  it("is monotone increasing in pick position", () => {
    let previous = 0;
    for (const x of [1, 10, 25, 50, 100, 200]) {
      const current = pickCdf(x, 50, 0.5);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });
});

describe("danger", () => {
  const geo = 50;
  const sigma = 0.5;
  const h = 20;

  it("is monotone increasing in n approaching the geomean", () => {
    for (let n = 1; n < geo; n++) {
      expect(danger(n + 1, h, geo, sigma)).toBeGreaterThan(danger(n, h, geo, sigma));
    }
  });

  it("stays within [0, 1]", () => {
    for (let n = 1; n <= 459; n += 7) {
      const d = danger(n, h, geo, sigma);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it("clamps to exactly 1 when survival to n is essentially impossible", () => {
    expect(danger(1e9, h, geo, sigma)).toBe(1);
  });
});

describe("overdueDanger", () => {
  const geo = 50;
  const sigma = 0.5;
  const h = 20;

  it("matches danger while the card's window is still ahead", () => {
    // F(n) ≈ 0 well before the geomean, so the floor never binds there.
    for (const n of [1, 5, 10]) {
      expect(overdueDanger(n, h, geo, sigma)).toBeCloseTo(danger(n, h, geo, sigma), 6);
    }
  });

  it("floors at F(n) once the card is overdue — no wheel-again discount", () => {
    // Deep past the geomean the conditional hazard sags; the floor holds
    // at the (near-1) probability the card should already be gone.
    const n = geo * 6;
    expect(overdueDanger(n, h, geo, sigma)).toBeCloseTo(pickCdf(n, geo, sigma), 10);
    expect(overdueDanger(n, h, geo, sigma)).toBeGreaterThan(danger(n, h, geo, sigma));
  });

  it("is monotone non-decreasing over the whole draft", () => {
    // The raw conditional hazard is not monotone (it sags in the tail);
    // the overdue floor is what restores monotonicity.
    let prev = 0;
    for (let n = 1; n <= 459; n++) {
      const d = overdueDanger(n, h, geo, sigma);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(d).toBeLessThanOrEqual(1);
      prev = d;
    }
  });
});

describe("actBy", () => {
  it("returns the first pick where overdueDanger crosses 0.5", () => {
    const geo = 50;
    const sigma = 0.5;
    const h = 20;
    const n = actBy(geo, h, sigma);
    expect(n).not.toBeNull();
    expect(overdueDanger(n!, h, geo, sigma)).toBeGreaterThanOrEqual(0.5);
    expect(overdueDanger(n! - 1, h, geo, sigma)).toBeLessThan(0.5);
  });

  it("returns 1 for a card the market takes immediately", () => {
    expect(actBy(1, 20, 0.5)).toBe(1);
  });

  it("never exceeds the geomean — an overdue card is never safe to wait on", () => {
    // Even with a tiny horizon (raw danger stays low), F(n) crosses 0.5 at
    // the geomean, so actBy caps there.
    const n = actBy(100, 1, 0.5);
    expect(n).not.toBeNull();
    expect(n!).toBeLessThanOrEqual(100);
  });

  it("returns null only when the scan bound precedes the card's window", () => {
    expect(actBy(1e8, 1, 0.5)).toBeNull();
  });
});

describe("colorFlag", () => {
  // All ten pairs, best overall is UR (+2.7%); among B pairs the best is BR.
  const pairEdges = {
    WU: -0.0004,
    WB: 0.005,
    WR: 0.002,
    WG: 0.001,
    UB: 0.01,
    UR: 0.027,
    UG: 0.012,
    BR: 0.019,
    BG: -0.006,
    RG: 0.003,
  };
  const kappa = 0.5;

  describe("uncommitted", () => {
    const state = { committed: "" };

    it("costs 0 for a card in the best pair", () => {
      expect(colorFlag("U", pairEdges, state, kappa)).toBe(0);
    });

    it("charges an off-color mono card the gap to the best pair", () => {
      // Best G pair is UG (+1.2%) vs UR (+2.7%): 0.5 · (0.012 − 0.027)
      expect(colorFlag("G", pairEdges, state, kappa)).toBeCloseTo(-0.0075, 10);
    });

    it("restricts a two-color card to its exact pair", () => {
      // WG only fits WG (+0.1%): 0.5 · (0.001 − 0.027)
      expect(colorFlag("WG", pairEdges, state, kappa)).toBeCloseTo(-0.013, 10);
    });

    it("falls back to intersecting pairs for 3+ color identities", () => {
      // WBG intersects everything except UR; best intersecting is BR (+1.9%)
      expect(colorFlag("WBG", pairEdges, state, kappa)).toBeCloseTo(-0.004, 10);
      // WUBRG intersects every pair, including the best
      expect(colorFlag("WUBRG", pairEdges, state, kappa)).toBe(0);
    });
  });

  describe("one color locked", () => {
    const state = { committed: "B" };

    it("restricts pairs to those containing the locked color", () => {
      // Card U: only UB qualifies (+1.0%) vs best B pair BR (+1.9%)
      expect(colorFlag("U", pairEdges, state, kappa)).toBeCloseTo(-0.0045, 10);
    });

    it("costs 0 when the card completes the best locked pair", () => {
      expect(colorFlag("R", pairEdges, state, kappa)).toBe(0);
    });

    it("falls back to intersecting pairs when no locked pair contains the identity", () => {
      // No B pair contains {W,G}; intersecting B pairs are WB (+0.5%), BG (−0.6%)
      expect(colorFlag("WG", pairEdges, state, kappa)).toBeCloseTo(-0.007, 10);
    });
  });

  describe("pair locked", () => {
    it("costs 0 for every card", () => {
      const state = { committed: "UR" };
      expect(colorFlag("U", pairEdges, state, kappa)).toBe(0);
      expect(colorFlag("WG", pairEdges, state, kappa)).toBe(0);
      expect(colorFlag("WUBRG", pairEdges, state, kappa)).toBe(0);
    });
  });

  it("colorless cards cost 0 in every state", () => {
    for (const committed of ["", "B", "UR"]) {
      expect(colorFlag("", pairEdges, { committed }, kappa)).toBe(0);
    }
  });

  it("is never positive", () => {
    for (const colors of ["W", "U", "B", "R", "G", "WU", "BG", "WUB"]) {
      for (const committed of ["", "W", "U", "B", "R", "G", "UR", "BG"]) {
        expect(colorFlag(colors, pairEdges, { committed }, kappa)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("scales linearly with kappa", () => {
    const atHalf = colorFlag("G", pairEdges, { committed: "" }, 0.5);
    const atQuarter = colorFlag("G", pairEdges, { committed: "" }, 0.25);
    expect(atQuarter).toBeCloseTo(atHalf / 2, 10);
  });
});

describe("pairSupply", () => {
  const sigma = 0.5;

  it("greedily counts positive-worth cards that survive to each slot", () => {
    const cards = [
      { worth: 0.05, geo: 100 }, // survives both slots
      { worth: 0.03, geo: 100 }, // survives both slots
      { worth: 0.02, geo: 10 }, // long gone by pick 50
      { worth: -0.01, geo: 300 }, // negative worth: excluded
    ];
    expect(pairSupply(cards, [50, 60], 40, sigma)).toBe(2);
  });

  it("skips slots before fromPick", () => {
    const cards = [
      { worth: 0.05, geo: 100 },
      { worth: 0.03, geo: 100 },
    ];
    expect(pairSupply(cards, [10, 50], 40, sigma)).toBe(1);
  });

  it("counts 0 when nothing survives", () => {
    expect(pairSupply([{ worth: 0.02, geo: 10 }], [50], 40, sigma)).toBe(0);
  });

  it("counts 0 for empty cards or slots", () => {
    expect(pairSupply([], [50, 60], 40, sigma)).toBe(0);
    expect(pairSupply([{ worth: 0.05, geo: 100 }], [], 40, sigma)).toBe(0);
  });

  it("assigns each card at most once", () => {
    // One survivable card, three slots: it can only be obtained once.
    expect(pairSupply([{ worth: 0.05, geo: 100 }], [50, 55, 60], 40, sigma)).toBe(1);
  });
});
