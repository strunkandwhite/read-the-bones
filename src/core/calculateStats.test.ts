import { describe, it, expect } from "vitest";
import { calculateCardStats } from "./calculateStats";
import type { CardPick } from "./types";

/**
 * Helper to create a CardPick with sensible defaults.
 */
function createPick(overrides: Partial<CardPick> = {}): CardPick {
  return {
    cardName: "Test Card",
    pickPosition: 1,
    copyNumber: 1,
    wasPicked: true,
    draftId: "draft-1",
    seat: 0,
    color: "W",
    ...overrides,
  };
}

/** All picks in one session unless a test says otherwise. */
const oneSession = (picks: CardPick[]) =>
  new Map([...new Set(picks.map((p) => p.draftId))].map((id) => [id, 0]));

describe("calculateCardStats", () => {
  it("should return empty array for no picks", () => {
    expect(calculateCardStats([], oneSession([]))).toEqual([]);
  });

  it("should calculate basic stats for a single card", () => {
    const picks: CardPick[] = [
      createPick({
        cardName: "Lightning Bolt",
        pickPosition: 5,
        copyNumber: 1,
        wasPicked: true,
        draftId: "draft-1",
        color: "R",
      }),
    ];

    const stats = calculateCardStats(picks, oneSession(picks));

    expect(stats).toHaveLength(1);
    expect(stats[0].cardName).toBe("Lightning Bolt");
    expect(stats[0].timesAvailable).toBe(1);
    expect(stats[0].maxCopiesInDraft).toBe(1);
    expect(stats[0].colors).toEqual(["R"]);
    // Single pick at position 5, weight 1: geomean = 5
    expect(stats[0].weightedGeomean).toBe(5);
  });

  it("should sort results by weightedGeomean ascending", () => {
    const picks: CardPick[] = [
      createPick({ cardName: "Card A", pickPosition: 10 }),
      createPick({ cardName: "Card B", pickPosition: 5 }),
      createPick({ cardName: "Card C", pickPosition: 20 }),
    ];

    const stats = calculateCardStats(picks, oneSession(picks));

    expect(stats[0].cardName).toBe("Card B"); // geomean 5
    expect(stats[1].cardName).toBe("Card A"); // geomean 10
    expect(stats[2].cardName).toBe("Card C"); // geomean 20
  });

  describe("weight calculations", () => {
    it("should apply copy weight (0.5^(copyNumber-1))", () => {
      // Two copies of same card in same draft
      const picks: CardPick[] = [
        createPick({
          cardName: "Scalding Tarn",
          pickPosition: 10,
          copyNumber: 1,
          draftId: "draft-1",
        }),
        createPick({
          cardName: "Scalding Tarn",
          pickPosition: 20,
          copyNumber: 2,
          draftId: "draft-1",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // weight1 = 1 (0.5^0), weight2 = 0.5 (0.5^1)
      // geomean = exp((1*ln(10) + 0.5*ln(20)) / 1.5)
      //         = exp((2.303 + 1.498) / 1.5)
      //         = exp(2.534)
      //         ≈ 12.6
      expect(stats[0].weightedGeomean).toBeCloseTo(12.6, 1);
    });

    it("should apply unpicked weight (0.5 for unpicked)", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Test Card",
          pickPosition: 10,
          copyNumber: 1,
          wasPicked: true,
        }),
        createPick({
          cardName: "Test Card",
          pickPosition: 100,
          copyNumber: 1,
          wasPicked: false,
          draftId: "draft-2",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // weight1 = 1 (picked), weight2 = 0.5 (unpicked)
      // geomean = exp((1*ln(10) + 0.5*ln(100)) / 1.5)
      //         = exp((2.303 + 2.303) / 1.5)
      //         = exp(3.071)
      //         ≈ 21.54
      expect(stats[0].weightedGeomean).toBeCloseTo(21.54, 1);
    });

    it("discounts picks from older sessions", () => {
      // pick 10 this session, pick 100 four sessions back:
      // exp((1*ln(10) + 0.5*ln(100)) / 1.5) = 21.5
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 10, draftId: "recent" }),
        createPick({ cardName: "Test", pickPosition: 100, draftId: "older" }),
      ];

      const stats = calculateCardStats(
        picks,
        new Map([["recent", 0], ["older", 4]]),
      );

      expect(stats[0].weightedGeomean).toBeCloseTo(21.5, 1);
    });

  });

  describe("aggregation stats", () => {
    it("should count times available (unique drafts)", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Card A",
          copyNumber: 1,
          draftId: "draft-1",
        }),
        createPick({
          cardName: "Card A",
          copyNumber: 2,
          draftId: "draft-1",
        }),
        createPick({ cardName: "Card A", copyNumber: 1, draftId: "draft-2" }),
        createPick({ cardName: "Card A", copyNumber: 1, draftId: "draft-3" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));
      expect(stats[0].timesAvailable).toBe(3);
    });

    it("should track max copies in any draft", () => {
      const picks: CardPick[] = [
        // Draft 1: 2 copies
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 1,
          draftId: "draft-1",
        }),
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 2,
          draftId: "draft-1",
        }),
        // Draft 2: 3 copies
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 1,
          draftId: "draft-2",
        }),
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 2,
          draftId: "draft-2",
        }),
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 3,
          draftId: "draft-2",
        }),
        // Draft 3: 1 copy
        createPick({
          cardName: "Scalding Tarn",
          copyNumber: 1,
          draftId: "draft-3",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));
      expect(stats[0].maxCopiesInDraft).toBe(3);
    });

    it("should collect unique colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "W", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "U", draftId: "d2" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d3" }), // duplicate
        createPick({ cardName: "Card A", color: "WU", draftId: "d4" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));
      expect(stats[0].colors).toEqual(["U", "W", "WU"]);
    });

    it("should handle empty colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));
      expect(stats[0].colors).toEqual(["W"]);
    });
  });

  describe("edge cases", () => {
    it("should handle card appearing only as unpicked", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Bad Card",
          pickPosition: 400,
          wasPicked: false,
          draftId: "d1",
        }),
        createPick({
          cardName: "Bad Card",
          pickPosition: 450,
          wasPicked: false,
          draftId: "d2",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));
      expect(stats[0].timesAvailable).toBe(2);
    });

    it("should handle multiple cards across multiple drafts", () => {
      const picks: CardPick[] = [
        // Card A - picked early
        createPick({
          cardName: "Card A",
          pickPosition: 1,
          draftId: "d1",
                  }),
        createPick({
          cardName: "Card A",
          pickPosition: 2,
          draftId: "d2",
                  }),
        // Card B - picked late
        createPick({
          cardName: "Card B",
          pickPosition: 100,
          draftId: "d1",
                  }),
        createPick({
          cardName: "Card B",
          pickPosition: 150,
          draftId: "d2",
                  }),
        // Card C - mixed
        createPick({
          cardName: "Card C",
          pickPosition: 50,
          draftId: "d1",
                  }),
        createPick({
          cardName: "Card C",
          pickPosition: 50,
          draftId: "d2",
                  }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats).toHaveLength(3);
      // Card A should be first (lowest geomean)
      expect(stats[0].cardName).toBe("Card A");
      // Card C should be second
      expect(stats[1].cardName).toBe("Card C");
      // Card B should be last
      expect(stats[2].cardName).toBe("Card B");
    });

    it("should handle third copy with correct weight", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Multi Copy",
          pickPosition: 10,
          copyNumber: 1,
          draftId: "d1",
        }),
        createPick({
          cardName: "Multi Copy",
          pickPosition: 20,
          copyNumber: 2,
          draftId: "d1",
        }),
        createPick({
          cardName: "Multi Copy",
          pickPosition: 30,
          copyNumber: 3,
          draftId: "d1",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // weights: 1, 0.5, 0.25
      // geomean = exp((1*ln(10) + 0.5*ln(20) + 0.25*ln(30)) / 1.75)
      //         = exp((2.303 + 1.498 + 0.850) / 1.75)
      //         = exp(2.658)
      //         ≈ 14.27
      expect(stats[0].weightedGeomean).toBeCloseTo(14.27, 1);
    });

    it("ignores an untaken copy when another copy was taken in that draft", () => {
      // A qty-2 card taken once says demand was one deep, not that the card
      // went unwanted — so only the taken copy is scored.
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 10,
          copyNumber: 1,
          wasPicked: true,
          draftId: "d1",
        }),
        createPick({
          cardName: "Test",
          pickPosition: 400,
          copyNumber: 2,
          wasPicked: false,
          draftId: "d1",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats[0].weightedGeomean).toBeCloseTo(10, 10);
      // The untaken copy still proves the card was in that draft's pool.
      expect(stats[0].timesAvailable).toBe(1);
    });

    it("handles unpicked third copy: weight factors combine but single-value geomean is the pick position", () => {
      // A draft that took no copy contributes one observation; with nothing to average against, the score is that value.
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 10,
          copyNumber: 3,
          wasPicked: false,
          draftId: "d1",
        }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats[0].weightedGeomean).toBeCloseTo(10, 10);
    });

    it("scores a draft that took no copy at pool size, at half weight", () => {
      // exp((1*ln(10) + 0.5*ln(80)) / 1.5) = 20.00
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 10, copyNumber: 1, wasPicked: true, draftId: "d1" }),
        createPick({ cardName: "Test", pickPosition: 80, copyNumber: 1, wasPicked: false, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats[0].weightedGeomean).toBeCloseTo(20.0, 1);
    });

    it("should handle pick position of 1 correctly", () => {
      const picks: CardPick[] = [createPick({ cardName: "First Pick", pickPosition: 1 })];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats[0].weightedGeomean).toBe(1);
    });

    it("should handle very large pick positions", () => {
      const picks: CardPick[] = [createPick({ cardName: "Large Pool Card", pickPosition: 10000 })];

      const stats = calculateCardStats(picks, oneSession(picks));

      expect(stats[0].weightedGeomean).toBeCloseTo(10000, 10);
      expect(Number.isFinite(stats[0].weightedGeomean)).toBe(true);
    });

    it("should handle pick position of 0 without corrupting calculation", () => {
      // Pick position 0 would cause Math.log(0) = -Infinity, corrupting the geomean
      // The function should filter out invalid values
      const picks: CardPick[] = [
        createPick({ cardName: "Edge Card", pickPosition: 0, draftId: "d1" }),
        createPick({ cardName: "Edge Card", pickPosition: 10, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // Should ignore the 0 value and return geomean of 10 only
      expect(stats[0].weightedGeomean).toBeCloseTo(10, 10);
      expect(Number.isFinite(stats[0].weightedGeomean)).toBe(true);
    });

    it("should handle negative pick positions without corrupting calculation", () => {
      // Negative pick position would cause Math.log(-n) = NaN
      const picks: CardPick[] = [
        createPick({ cardName: "Edge Card", pickPosition: -5, draftId: "d1" }),
        createPick({ cardName: "Edge Card", pickPosition: 20, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // Should ignore the negative value and return geomean of 20 only
      expect(stats[0].weightedGeomean).toBeCloseTo(20, 10);
      expect(Number.isFinite(stats[0].weightedGeomean)).toBe(true);
    });

    it("should return 0 when all pick positions are invalid", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "All Bad", pickPosition: 0, draftId: "d1" }),
        createPick({ cardName: "All Bad", pickPosition: -10, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, oneSession(picks));

      // When all values are invalid, return 0 as a sensible default
      expect(stats[0].weightedGeomean).toBe(0);
    });
  });

});
