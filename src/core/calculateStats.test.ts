import { describe, it, expect } from "vitest";
import { calculateCardStats, extractPlayers } from "./calculateStats";
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
    drafterName: "Player1",
    color: "W",
    ...overrides,
  };
}

describe("extractPlayers", () => {
  it("should return empty array for no picks", () => {
    expect(extractPlayers([])).toEqual([]);
  });

  it("should extract unique player names", () => {
    const picks: CardPick[] = [
      createPick({ drafterName: "Alice" }),
      createPick({ drafterName: "Bob" }),
      createPick({ drafterName: "Alice" }),
      createPick({ drafterName: "Charlie" }),
    ];

    const players = extractPlayers(picks);
    expect(players).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("should exclude 'Unpicked' drafter", () => {
    const picks: CardPick[] = [
      createPick({ drafterName: "Alice" }),
      createPick({ drafterName: "Unpicked", wasPicked: false }),
      createPick({ drafterName: "Bob" }),
    ];

    const players = extractPlayers(picks);
    expect(players).toEqual(["Alice", "Bob"]);
    expect(players).not.toContain("Unpicked");
  });

  it("should sort players alphabetically", () => {
    const picks: CardPick[] = [
      createPick({ drafterName: "Zack" }),
      createPick({ drafterName: "Alice" }),
      createPick({ drafterName: "Mike" }),
    ];

    const players = extractPlayers(picks);
    expect(players).toEqual(["Alice", "Mike", "Zack"]);
  });

  it("should handle empty drafter names", () => {
    const picks: CardPick[] = [
      createPick({ drafterName: "Alice" }),
      createPick({ drafterName: "" }),
      createPick({ drafterName: "Bob" }),
    ];

    const players = extractPlayers(picks);
    expect(players).toEqual(["Alice", "Bob"]);
  });
});

describe("calculateCardStats", () => {
  it("should return empty array for no picks", () => {
    expect(calculateCardStats([], [])).toEqual([]);
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

    const stats = calculateCardStats(picks, []);

    expect(stats).toHaveLength(1);
    expect(stats[0].cardName).toBe("Lightning Bolt");
    expect(stats[0].totalPicks).toBe(1);
    expect(stats[0].timesAvailable).toBe(1);
    expect(stats[0].timesUnpicked).toBe(0);
    expect(stats[0].maxCopiesInDraft).toBe(1);
    expect(stats[0].colors).toEqual(["R"]);
    // Single pick at position 5, weight 1: geomean = 5
    expect(stats[0].weightedGeomean).toBe(5);
    expect(stats[0].topPlayerGeomean).toBe(5);
  });

  it("should sort results by weightedGeomean ascending", () => {
    const picks: CardPick[] = [
      createPick({ cardName: "Card A", pickPosition: 10 }),
      createPick({ cardName: "Card B", pickPosition: 5 }),
      createPick({ cardName: "Card C", pickPosition: 20 }),
    ];

    const stats = calculateCardStats(picks, []);

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

      const stats = calculateCardStats(picks, []);

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
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, []);

      // weight1 = 1 (picked), weight2 = 0.5 (unpicked)
      // geomean = exp((1*ln(10) + 0.5*ln(100)) / 1.5)
      //         = exp((2.303 + 2.303) / 1.5)
      //         = exp(3.071)
      //         ≈ 21.54
      expect(stats[0].weightedGeomean).toBeCloseTo(21.54, 1);
    });

    it("should apply top player multiplier only to topPlayerGeomean", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Test Card",
          pickPosition: 10,
          copyNumber: 1,
          drafterName: "TopPlayer",
          draftId: "draft-1",
        }),
        createPick({
          cardName: "Test Card",
          pickPosition: 20,
          copyNumber: 1,
          drafterName: "RegularPlayer",
          draftId: "draft-2",
        }),
      ];

      const stats = calculateCardStats(picks, ["TopPlayer"]);

      // Regular geomean (no top player multiplier):
      // weights: 1, 1; geomean = exp((ln(10) + ln(20)) / 2) = sqrt(200) ≈ 14.14
      expect(stats[0].weightedGeomean).toBeCloseTo(14.14, 1);

      // Top player geomean (with multiplier):
      // weights: 2 (top player), 1 (regular)
      // geomean = exp((2*ln(10) + 1*ln(20)) / 3)
      //         = exp((4.605 + 2.996) / 3)
      //         = exp(2.534)
      //         ≈ 12.6
      expect(stats[0].topPlayerGeomean).toBeCloseTo(12.6, 1);
    });
  });

  describe("example calculation from spec", () => {
    it("should match the example calculation", () => {
      // Draft A: Picked 5th (1st copy, top player) → weight = 1 × 1 × 2 = 2
      // Draft B: Picked 12th (1st copy, regular player) → weight = 1 × 1 × 1 = 1
      // Draft C: Unpicked, pool size 450 → weight = 1 × 0.5 × 1 = 0.5
      // topPlayerGeomean = exp((2×ln(5) + 1×ln(12) + 0.5×ln(450)) / 3.5) ≈ 12.2

      const picks: CardPick[] = [
        createPick({
          cardName: "Example Card",
          pickPosition: 5,
          copyNumber: 1,
          wasPicked: true,
          draftId: "draft-A",
          drafterName: "TopPlayer",
        }),
        createPick({
          cardName: "Example Card",
          pickPosition: 12,
          copyNumber: 1,
          wasPicked: true,
          draftId: "draft-B",
          drafterName: "RegularPlayer",
        }),
        createPick({
          cardName: "Example Card",
          pickPosition: 450,
          copyNumber: 1,
          wasPicked: false,
          draftId: "draft-C",
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, ["TopPlayer"]);

      expect(stats[0].topPlayerGeomean).toBeCloseTo(12.2, 1);
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
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, []);
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

      const stats = calculateCardStats(picks, []);
      expect(stats[0].timesAvailable).toBe(3);
    });

    it("should count times unpicked correctly", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", wasPicked: true, draftId: "d1" }),
        createPick({
          cardName: "Card A",
          wasPicked: false,
          draftId: "d2",
          drafterName: "Unpicked",
        }),
        createPick({
          cardName: "Card A",
          wasPicked: false,
          draftId: "d3",
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, []);
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

      const stats = calculateCardStats(picks, []);
      expect(stats[0].maxCopiesInDraft).toBe(3);
    });

    it("should collect unique colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "W", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "U", draftId: "d2" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d3" }), // duplicate
        createPick({ cardName: "Card A", color: "WU", draftId: "d4" }),
      ];

      const stats = calculateCardStats(picks, []);
      expect(stats[0].colors).toEqual(["U", "W", "WU"]);
    });

    it("should handle empty colors", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", color: "", draftId: "d1" }),
        createPick({ cardName: "Card A", color: "W", draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, []);
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
          drafterName: "Unpicked",
        }),
        createPick({
          cardName: "Bad Card",
          pickPosition: 450,
          wasPicked: false,
          draftId: "d2",
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, []);
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
          drafterName: "P1",
        }),
        createPick({
          cardName: "Card A",
          pickPosition: 2,
          draftId: "d2",
          drafterName: "P2",
        }),
        // Card B - picked late
        createPick({
          cardName: "Card B",
          pickPosition: 100,
          draftId: "d1",
          drafterName: "P3",
        }),
        createPick({
          cardName: "Card B",
          pickPosition: 150,
          draftId: "d2",
          drafterName: "P4",
        }),
        // Card C - mixed
        createPick({
          cardName: "Card C",
          pickPosition: 50,
          draftId: "d1",
          drafterName: "P5",
        }),
        createPick({
          cardName: "Card C",
          pickPosition: 50,
          draftId: "d2",
          drafterName: "P6",
        }),
      ];

      const stats = calculateCardStats(picks, []);

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

      const stats = calculateCardStats(picks, []);

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
          drafterName: "Unpicked",
        }),
      ];

      const stats = calculateCardStats(picks, []);

      // weight1 = 1, weight2 = 0.5 * 0.5 = 0.25
      // geomean = exp((1*ln(10) + 0.25*ln(400)) / 1.25)
      //         = exp((2.303 + 1.498) / 1.25)
      //         = exp(3.041)
      //         ≈ 20.9
      expect(stats[0].weightedGeomean).toBeCloseTo(20.9, 1);
    });

    it("should handle all weights combined: copy, unpicked, and top player", () => {
      // Third copy, unpicked, top player (for topPlayerGeomean)
      // weight = 0.25 * 0.5 * 2 = 0.25
      const picks: CardPick[] = [
        createPick({
          cardName: "Test",
          pickPosition: 10,
          copyNumber: 3,
          wasPicked: false,
          drafterName: "TopGuy",
          draftId: "d1",
        }),
      ];

      const statsWithTopPlayer = calculateCardStats(picks, ["TopGuy"]);

      // For regular weightedGeomean: weight = 0.25 * 0.5 * 1 = 0.125
      // Single value, so geomean = 10
      expect(statsWithTopPlayer[0].weightedGeomean).toBeCloseTo(10, 10);

      // For topPlayerGeomean: weight = 0.25 * 0.5 * 2 = 0.25
      // Single value, so geomean = 10
      expect(statsWithTopPlayer[0].topPlayerGeomean).toBeCloseTo(10, 10);
    });

    it("should handle pick position of 1 correctly", () => {
      const picks: CardPick[] = [createPick({ cardName: "First Pick", pickPosition: 1 })];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].weightedGeomean).toBe(1);
    });

    it("should handle very large pick positions", () => {
      const picks: CardPick[] = [createPick({ cardName: "Large Pool Card", pickPosition: 10000 })];

      const stats = calculateCardStats(picks, []);

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

      const stats = calculateCardStats(picks, []);

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

      const stats = calculateCardStats(picks, []);

      // Should ignore the negative value and return geomean of 20 only
      expect(stats[0].weightedGeomean).toBeCloseTo(20, 10);
      expect(Number.isFinite(stats[0].weightedGeomean)).toBe(true);
    });

    it("should return 0 when all pick positions are invalid", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "All Bad", pickPosition: 0, draftId: "d1" }),
        createPick({ cardName: "All Bad", pickPosition: -10, draftId: "d2" }),
      ];

      const stats = calculateCardStats(picks, []);

      // When all values are invalid, return 0 as a sensible default
      expect(stats[0].weightedGeomean).toBe(0);
      expect(stats[0].topPlayerGeomean).toBe(0);
    });
  });

  describe("pickDistribution", () => {
    it("should bucket picks into correct ranges", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 3, draftId: "d1" }),   // bucket 0: 1-10
        createPick({ cardName: "Card A", pickPosition: 8, draftId: "d2" }),   // bucket 0: 1-10
        createPick({ cardName: "Card A", pickPosition: 15, draftId: "d3" }),  // bucket 1: 11-20
        createPick({ cardName: "Card A", pickPosition: 42, draftId: "d4" }),  // bucket 4: 41+
      ];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].pickDistribution).toEqual([2, 1, 0, 0, 1]);
    });

    it("should handle boundary values correctly", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 1, draftId: "d1" }),   // bucket 0
        createPick({ cardName: "Card A", pickPosition: 10, draftId: "d2" }),  // bucket 0 (boundary)
        createPick({ cardName: "Card A", pickPosition: 11, draftId: "d3" }),  // bucket 1 (boundary)
        createPick({ cardName: "Card A", pickPosition: 20, draftId: "d4" }),  // bucket 1 (boundary)
        createPick({ cardName: "Card A", pickPosition: 21, draftId: "d5" }),  // bucket 2 (boundary)
        createPick({ cardName: "Card A", pickPosition: 30, draftId: "d6" }),  // bucket 2 (boundary)
        createPick({ cardName: "Card A", pickPosition: 31, draftId: "d7" }),  // bucket 3 (boundary)
        createPick({ cardName: "Card A", pickPosition: 40, draftId: "d8" }),  // bucket 3 (boundary)
        createPick({ cardName: "Card A", pickPosition: 41, draftId: "d9" }),  // bucket 4 (boundary)
      ];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].pickDistribution).toEqual([2, 2, 2, 2, 1]);
    });

    it("should handle all picks in single bucket", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 100, draftId: "d1" }),
        createPick({ cardName: "Card A", pickPosition: 200, draftId: "d2" }),
        createPick({ cardName: "Card A", pickPosition: 300, draftId: "d3" }),
      ];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].pickDistribution).toEqual([0, 0, 0, 0, 3]);
    });

    it("should handle single pick", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 25, draftId: "d1" }),
      ];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].pickDistribution).toEqual([0, 0, 1, 0, 0]);
    });

    it("should include unpicked cards in distribution", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 5, draftId: "d1", wasPicked: true }),
        createPick({
          cardName: "Card A",
          pickPosition: 450,
          draftId: "d2",
          wasPicked: false,
          drafterName: "Unpicked"
        }),
      ];

      const stats = calculateCardStats(picks, []);

      // Both picks count: position 5 -> bucket 0, position 450 -> bucket 4
      expect(stats[0].pickDistribution).toEqual([1, 0, 0, 0, 1]);
    });

    it("should count multiple copies separately", () => {
      const picks: CardPick[] = [
        createPick({ cardName: "Card A", pickPosition: 5, copyNumber: 1, draftId: "d1" }),
        createPick({ cardName: "Card A", pickPosition: 15, copyNumber: 2, draftId: "d1" }),
        createPick({ cardName: "Card A", pickPosition: 25, copyNumber: 3, draftId: "d1" }),
      ];

      const stats = calculateCardStats(picks, []);

      expect(stats[0].pickDistribution).toEqual([1, 1, 1, 0, 0]);
    });
  });

  describe("multiple top players", () => {
    it("should apply top player weight to multiple top players", () => {
      const picks: CardPick[] = [
        createPick({
          cardName: "Card",
          pickPosition: 10,
          drafterName: "Top1",
          draftId: "d1",
        }),
        createPick({
          cardName: "Card",
          pickPosition: 20,
          drafterName: "Top2",
          draftId: "d2",
        }),
        createPick({
          cardName: "Card",
          pickPosition: 30,
          drafterName: "Regular",
          draftId: "d3",
        }),
      ];

      const stats = calculateCardStats(picks, ["Top1", "Top2"]);

      // Regular: weights all 1, geomean = (10*20*30)^(1/3) = 18.17
      expect(stats[0].weightedGeomean).toBeCloseTo(18.17, 1);

      // Top player: weights 2, 2, 1 (total 5)
      // geomean = exp((2*ln(10) + 2*ln(20) + 1*ln(30)) / 5)
      //         = exp((4.605 + 5.991 + 3.401) / 5)
      //         = exp(2.799)
      //         ≈ 16.43
      expect(stats[0].topPlayerGeomean).toBeCloseTo(16.43, 1);
    });
  });
});
