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

describe("calculateCardStats", () => {
  it("should return empty array for no picks", () => {
    expect(calculateCardStats([])).toEqual([]);
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

    const stats = calculateCardStats(picks);

    expect(stats).toHaveLength(1);
    expect(stats[0].cardName).toBe("Lightning Bolt");
    expect(stats[0].totalPicks).toBe(1);
    expect(stats[0].timesAvailable).toBe(1);
    expect(stats[0].timesUnpicked).toBe(0);
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

    const stats = calculateCardStats(picks);

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

      const stats = calculateCardStats(picks);

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

      const stats = calculateCardStats(picks);

      // weight1 = 1 (picked), weight2 = 0.5 (unpicked)
      // geomean = exp((1*ln(10) + 0.5*ln(100)) / 1.5)
      //         = exp((2.303 + 2.303) / 1.5)
      //         = exp(3.071)
      //         ≈ 21.54
      expect(stats[0].weightedGeomean).toBeCloseTo(21.54, 1);
    });

  });

  describe("aggregation stats", () => {
    it("should count total picks correctly", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", wasPicked: true, draftId: "d1" }),
        createPick({ cardName: "Card A", wasPicked: true, draftId: "d2" }),
        createPick({
          cardName: "Card A",
          wasPicked: false,
          draftId: "d3",
        }),
      ];

      const stats = calculateCardStats(picks);
      expect(stats[0].totalPicks).toBe(2);
    });

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

      const stats = calculateCardStats(picks);
      expect(stats[0].timesAvailable).toBe(3);
    });

    it("should count times unpicked correctly", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", wasPicked: true, draftId: "d1" }),
        createPick({
          cardName: "Card A",
          wasPicked: false,
          draftId: "d2",
        }),
        createPick({
          cardName: "Card A",
          wasPicked: false,
          draftId: "d3",
        }),
      ];

      const stats = calculateCardStats(picks);
      expect(stats[0].timesUnpicked).toBe(2);
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

      const stats = calculateCardStats(picks);
      expect(stats[0].maxCopiesInDraft).toBe(3);
    });

    it("should collect unique colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "W", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "U", draftId: "d2" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d3" }), // duplicate
        createPick({ cardName: "Card A", color: "WU", draftId: "d4" }),
      ];

      const stats = calculateCardStats(picks);
      expect(stats[0].colors).toEqual(["U", "W", "WU"]);
    });

    it("should handle empty colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks);
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

      const stats = calculateCardStats(picks);
      expect(stats[0].totalPicks).toBe(0);
      expect(stats[0].timesUnpicked).toBe(2);
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

      const stats = calculateCardStats(picks);

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

      const stats = calculateCardStats(picks);

      // weights: 1, 0.5, 0.25
      // geomean = exp((1*ln(10) + 0.5*ln(20) + 0.25*ln(30)) / 1.75)
      //         = exp((2.303 + 1.498 + 0.850) / 1.75)
      //         = exp(2.658)
      //         ≈ 14.27
      expect(stats[0].weightedGeomean).toBeCloseTo(14.27, 1);
    });

    it("should handle combined copy and unpicked weights", () => {
      // Second copy that went unpicked: weight = 0.5 * 0.5 = 0.25
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

      const stats = calculateCardStats(picks);

      // weight1 = 1, weight2 = 0.5 * 0.5 = 0.25
      // geomean = exp((1*ln(10) + 0.25*ln(400)) / 1.25)
      //         = exp((2.303 + 1.498) / 1.25)
      //         = exp(3.041)
      //         ≈ 20.9
      expect(stats[0].weightedGeomean).toBeCloseTo(20.9, 1);
    });

    it("should handle combined copy and unpicked weights for third copy", () => {
      // Third copy, unpicked: weight = 0.25 * 0.5 = 0.125
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 10,
          copyNumber: 3,
          wasPicked: false,
          draftId: "d1",
        }),
      ];

      const stats = calculateCardStats(picks);

      // Single value, so geomean = 10
      expect(stats[0].weightedGeomean).toBeCloseTo(10, 10);
    });

    it("should handle pick position of 1 correctly", () => {
      const picks: CardPick[] = [createPick({ cardName: "First Pick", pickPosition: 1 })];

      const stats = calculateCardStats(picks);

      expect(stats[0].weightedGeomean).toBe(1);
    });

    it("should handle very large pick positions", () => {
      const picks: CardPick[] = [createPick({ cardName: "Large Pool Card", pickPosition: 10000 })];

      const stats = calculateCardStats(picks);

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

      const stats = calculateCardStats(picks);

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

      const stats = calculateCardStats(picks);

      // Should ignore the negative value and return geomean of 20 only
      expect(stats[0].weightedGeomean).toBeCloseTo(20, 10);
      expect(Number.isFinite(stats[0].weightedGeomean)).toBe(true);
    });

    it("should return 0 when all pick positions are invalid", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "All Bad", pickPosition: 0, draftId: "d1" }),
        createPick({ cardName: "All Bad", pickPosition: -10, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks);

      // When all values are invalid, return 0 as a sensible default
      expect(stats[0].weightedGeomean).toBe(0);
    });
  });

  describe("pickDistribution", () => {
    // Helper to create expected 15-element distribution array
    const dist = (counts: Record<number, number>) => {
      const arr = new Array(15).fill(0);
      for (const [bucket, count] of Object.entries(counts)) {
        arr[Number(bucket)] = count;
      }
      return arr;
    };

    it("should bucket picks into correct ranges (30 picks per bucket)", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 3, draftId: "d1" }),   // bucket 0: 1-30
        createPick({ cardName: "Card A", pickPosition: 28, draftId: "d2" }),  // bucket 0: 1-30
        createPick({ cardName: "Card A", pickPosition: 45, draftId: "d3" }),  // bucket 1: 31-60
        createPick({ cardName: "Card A", pickPosition: 120, draftId: "d4" }), // bucket 3: 91-120
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].pickDistribution).toEqual(dist({ 0: 2, 1: 1, 3: 1 }));
    });

    it("should handle boundary values correctly", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 1, draftId: "d1" }),   // bucket 0
        createPick({ cardName: "Card A", pickPosition: 30, draftId: "d2" }),  // bucket 0 (boundary)
        createPick({ cardName: "Card A", pickPosition: 31, draftId: "d3" }),  // bucket 1 (boundary)
        createPick({ cardName: "Card A", pickPosition: 60, draftId: "d4" }),  // bucket 1 (boundary)
        createPick({ cardName: "Card A", pickPosition: 61, draftId: "d5" }),  // bucket 2 (boundary)
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].pickDistribution).toEqual(dist({ 0: 2, 1: 2, 2: 1 }));
    });

    it("should handle picks spread across buckets", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 100, draftId: "d1" }), // bucket 3: 91-120
        createPick({ cardName: "Card A", pickPosition: 200, draftId: "d2" }), // bucket 6: 181-210
        createPick({ cardName: "Card A", pickPosition: 300, draftId: "d3" }), // bucket 9: 271-300
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].pickDistribution).toEqual(dist({ 3: 1, 6: 1, 9: 1 }));
    });

    it("should handle single pick", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 25, draftId: "d1" }), // bucket 0: 1-30
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].pickDistribution).toEqual(dist({ 0: 1 }));
    });

    it("should include unpicked cards in distribution", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 5, draftId: "d1", wasPicked: true }),
        createPick({
          cardName: "Card A",
          pickPosition: 450,
          draftId: "d2",
          wasPicked: false,
                  }),
      ];

      const stats = calculateCardStats(picks);

      // position 5 -> bucket 0, position 450 -> bucket 14 (421-450)
      expect(stats[0].pickDistribution).toEqual(dist({ 0: 1, 14: 1 }));
    });

    it("should count multiple copies separately", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 5, copyNumber: 1, draftId: "d1" }),  // bucket 0
        createPick({ cardName: "Card A", pickPosition: 35, copyNumber: 2, draftId: "d1" }), // bucket 1
        createPick({ cardName: "Card A", pickPosition: 65, copyNumber: 3, draftId: "d1" }), // bucket 2
      ];

      const stats = calculateCardStats(picks);

      expect(stats[0].pickDistribution).toEqual(dist({ 0: 1, 1: 1, 2: 1 }));
    });
  });

  describe("scoreHistory and round calculation", () => {
    it("should compute round from pickPosition and numDrafters", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 15, draftId: "draft-1" }),
      ];
      const metadata = new Map([
        ["draft-1", { draftId: "draft-1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // pickPosition 15 / 10 drafters = ceil(1.5) = round 2
      expect(stats[0].scoreHistory).toHaveLength(1);
      expect(stats[0].scoreHistory[0].round).toBe(2);
    });

    it("should compute round 1 for early picks", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 3, draftId: "draft-1" }),
      ];
      const metadata = new Map([
        ["draft-1", { draftId: "draft-1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // pickPosition 3 / 10 drafters = ceil(0.3) = round 1
      expect(stats[0].scoreHistory[0].round).toBe(1);
    });

    it("should compute correct round for unpicked cards", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 540, // pool size penalty
          wasPicked: false,
          draftId: "draft-1",
        }),
      ];
      const metadata = new Map([
        ["draft-1", { draftId: "draft-1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // pickPosition 540 / 10 drafters = ceil(54) = round 54
      expect(stats[0].scoreHistory[0].round).toBe(54);
    });

    it("should use geomean for same-day drafts", () => {
      // Simulating the Uro case: positions [3, 540, 5, 1, 6] on same date
      const picks: CardPick[] = [
        createPick({ cardName: "Uro", pickPosition: 3, draftId: "innistrad" }),
        createPick({ cardName: "Uro", pickPosition: 540, wasPicked: false, draftId: "lorwyn" }),
        createPick({ cardName: "Uro", pickPosition: 5, draftId: "ravnica" }),
        createPick({ cardName: "Uro", pickPosition: 1, draftId: "tarkir" }),
        createPick({ cardName: "Uro", pickPosition: 6, draftId: "zendikar" }),
      ];
      const metadata = new Map([
        ["innistrad", { draftId: "innistrad", name: "Innistrad", date: "2025-12-01", numDrafters: 10 }],
        ["lorwyn", { draftId: "lorwyn", name: "Lorwyn", date: "2025-12-01", numDrafters: 10 }],
        ["ravnica", { draftId: "ravnica", name: "Ravnica", date: "2025-12-01", numDrafters: 10 }],
        ["tarkir", { draftId: "tarkir", name: "Tarkir", date: "2025-12-01", numDrafters: 10 }],
        ["zendikar", { draftId: "zendikar", name: "Zendikar", date: "2025-12-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // Geomean of [3, 540, 5, 1, 6] = exp((ln3+ln540+ln5+ln1+ln6)/5) ≈ 8.65 → rounds to 9
      // Round = ceil(9/10) = 1
      expect(stats[0].scoreHistory).toHaveLength(1);
      expect(stats[0].scoreHistory[0].pickPosition).toBe(9);
      expect(stats[0].scoreHistory[0].round).toBe(1);
      expect(stats[0].scoreHistory[0].draftName).toBe("5 drafts");
    });

    it("should set pickedCount and totalCount for aggregated dates", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 3, draftId: "d1" }),
        createPick({ cardName: "Test", pickPosition: 540, wasPicked: false, draftId: "d2" }),
        createPick({ cardName: "Test", pickPosition: 5, draftId: "d3" }),
      ];
      const metadata = new Map([
        ["d1", { draftId: "d1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
        ["d2", { draftId: "d2", name: "Draft 2", date: "2025-01-01", numDrafters: 10 }],
        ["d3", { draftId: "d3", name: "Draft 3", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      expect(stats[0].scoreHistory[0].pickedCount).toBe(2);
      expect(stats[0].scoreHistory[0].totalCount).toBe(3);
    });

    it("should not set pickedCount/totalCount for single-draft dates", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 5, draftId: "d1" }),
      ];
      const metadata = new Map([
        ["d1", { draftId: "d1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      expect(stats[0].scoreHistory[0].pickedCount).toBeUndefined();
      expect(stats[0].scoreHistory[0].totalCount).toBeUndefined();
    });

    it("should handle different numDrafters across drafts", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 16, draftId: "d1" }), // 16/8 = round 2
        createPick({ cardName: "Test", pickPosition: 24, draftId: "d2" }), // 24/12 = round 2
      ];
      const metadata = new Map([
        ["d1", { draftId: "d1", name: "Draft 1", date: "2025-01-01", numDrafters: 8 }],
        ["d2", { draftId: "d2", name: "Draft 2", date: "2025-01-01", numDrafters: 12 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // Both are round 2, so average is 2
      expect(stats[0].scoreHistory[0].round).toBe(2);
    });

    it("should sort scoreHistory by date ascending", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 5, draftId: "d3" }),
        createPick({ cardName: "Test", pickPosition: 10, draftId: "d1" }),
        createPick({ cardName: "Test", pickPosition: 15, draftId: "d2" }),
      ];
      const metadata = new Map([
        ["d1", { draftId: "d1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
        ["d2", { draftId: "d2", name: "Draft 2", date: "2025-02-01", numDrafters: 10 }],
        ["d3", { draftId: "d3", name: "Draft 3", date: "2025-03-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      expect(stats[0].scoreHistory).toHaveLength(3);
      expect(stats[0].scoreHistory[0].date).toBe("2025-01-01");
      expect(stats[0].scoreHistory[1].date).toBe("2025-02-01");
      expect(stats[0].scoreHistory[2].date).toBe("2025-03-01");
    });

    it("should use best pick position per draft for scoreHistory", () => {
      // Multiple copies in same draft - should use best (lowest) position
      const picks: CardPick[] = [
        createPick({ cardName: "Test", pickPosition: 20, copyNumber: 2, draftId: "d1" }),
        createPick({ cardName: "Test", pickPosition: 5, copyNumber: 1, draftId: "d1" }),
      ];
      const metadata = new Map([
        ["d1", { draftId: "d1", name: "Draft 1", date: "2025-01-01", numDrafters: 10 }],
      ]);

      const stats = calculateCardStats(picks, metadata);

      // Should use position 5 (best), not 20
      expect(stats[0].scoreHistory[0].round).toBe(1); // ceil(5/10) = 1
    });
  });
});
