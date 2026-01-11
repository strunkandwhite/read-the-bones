import { describe, it, expect } from "vitest";
import {
  getPlayProbability,
  calculateWinEquity,
  calculateRawWinRate,
  LAND_PLAY_PROBABILITY,
  PICK_THRESHOLD_EARLY,
  PICK_THRESHOLD_MID,
  PICK_THRESHOLD_LATE,
  PLAY_PROBABILITY_EARLY,
  PLAY_PROBABILITY_MID,
  PLAY_PROBABILITY_LATE,
  PLAY_PROBABILITY_VERY_LATE,
} from "./winEquity";
import type { CardPick, ScryCard } from "./types";
import type { PlayerMatchStats } from "./parseMatches";

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

/**
 * Helper to create a minimal ScryCard for testing.
 */
function createScryCard(overrides: Partial<ScryCard> = {}): ScryCard {
  return {
    name: "Test Card",
    imageUri: "",
    manaCost: "{1}",
    manaValue: 1,
    typeLine: "Creature - Test",
    colors: [],
    colorIdentity: [],
    oracleText: "",
    ...overrides,
  };
}

describe("getPlayProbability", () => {
  describe("land cards", () => {
    it("should return LAND_PLAY_PROBABILITY for lands regardless of pick position", () => {
      expect(getPlayProbability(1, true)).toBe(LAND_PLAY_PROBABILITY);
      expect(getPlayProbability(PICK_THRESHOLD_EARLY, true)).toBe(LAND_PLAY_PROBABILITY);
      expect(getPlayProbability(PICK_THRESHOLD_MID, true)).toBe(LAND_PLAY_PROBABILITY);
      expect(getPlayProbability(PICK_THRESHOLD_LATE, true)).toBe(LAND_PLAY_PROBABILITY);
      expect(getPlayProbability(50, true)).toBe(LAND_PLAY_PROBABILITY);
      expect(getPlayProbability(100, true)).toBe(LAND_PLAY_PROBABILITY);
    });
  });

  describe("non-land cards - pick position decay", () => {
    it(`should return PLAY_PROBABILITY_EARLY for picks 1-${PICK_THRESHOLD_EARLY}`, () => {
      expect(getPlayProbability(1, false)).toBe(PLAY_PROBABILITY_EARLY);
      expect(getPlayProbability(8, false)).toBe(PLAY_PROBABILITY_EARLY);
      expect(getPlayProbability(PICK_THRESHOLD_EARLY, false)).toBe(PLAY_PROBABILITY_EARLY);
    });

    it(`should return PLAY_PROBABILITY_MID for picks ${PICK_THRESHOLD_EARLY + 1}-${PICK_THRESHOLD_MID}`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_EARLY + 1, false)).toBe(PLAY_PROBABILITY_MID);
      expect(getPlayProbability(20, false)).toBe(PLAY_PROBABILITY_MID);
      expect(getPlayProbability(PICK_THRESHOLD_MID, false)).toBe(PLAY_PROBABILITY_MID);
    });

    it(`should return PLAY_PROBABILITY_LATE for picks ${PICK_THRESHOLD_MID + 1}-${PICK_THRESHOLD_LATE}`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_MID + 1, false)).toBe(PLAY_PROBABILITY_LATE);
      expect(getPlayProbability(27, false)).toBe(PLAY_PROBABILITY_LATE);
      expect(getPlayProbability(PICK_THRESHOLD_LATE, false)).toBe(PLAY_PROBABILITY_LATE);
    });

    it(`should return PLAY_PROBABILITY_VERY_LATE for picks ${PICK_THRESHOLD_LATE + 1}+`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_LATE + 1, false)).toBe(PLAY_PROBABILITY_VERY_LATE);
      expect(getPlayProbability(40, false)).toBe(PLAY_PROBABILITY_VERY_LATE);
      expect(getPlayProbability(100, false)).toBe(PLAY_PROBABILITY_VERY_LATE);
      expect(getPlayProbability(500, false)).toBe(PLAY_PROBABILITY_VERY_LATE);
    });
  });

  describe("boundary values", () => {
    it(`should handle exact boundary at ${PICK_THRESHOLD_EARLY}/${PICK_THRESHOLD_EARLY + 1}`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_EARLY, false)).toBe(PLAY_PROBABILITY_EARLY);
      expect(getPlayProbability(PICK_THRESHOLD_EARLY + 1, false)).toBe(PLAY_PROBABILITY_MID);
    });

    it(`should handle exact boundary at ${PICK_THRESHOLD_MID}/${PICK_THRESHOLD_MID + 1}`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_MID, false)).toBe(PLAY_PROBABILITY_MID);
      expect(getPlayProbability(PICK_THRESHOLD_MID + 1, false)).toBe(PLAY_PROBABILITY_LATE);
    });

    it(`should handle exact boundary at ${PICK_THRESHOLD_LATE}/${PICK_THRESHOLD_LATE + 1}`, () => {
      expect(getPlayProbability(PICK_THRESHOLD_LATE, false)).toBe(PLAY_PROBABILITY_LATE);
      expect(getPlayProbability(PICK_THRESHOLD_LATE + 1, false)).toBe(PLAY_PROBABILITY_VERY_LATE);
    });
  });
});

describe("calculateWinEquity", () => {
  describe("basic functionality", () => {
    it("should return empty map when no picks provided", () => {
      const result = calculateWinEquity([], new Map(), new Map());
      expect(result.size).toBe(0);
    });

    it("should return empty map when no match stats provided", () => {
      const picks = [createPick({ cardName: "Lightning Bolt" })];
      const result = calculateWinEquity(picks, new Map(), new Map());
      expect(result.size).toBe(0);
    });

    it("should return empty map when picks exist but no matching draft in stats", () => {
      const picks = [createPick({ cardName: "Lightning Bolt", draftId: "draft-1" })];
      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-2", new Map([["Player1", { gamesWon: 5, gamesLost: 3 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());
      expect(result.size).toBe(0);
    });

    it("should skip unpicked cards", () => {
      const picks = [
        createPick({
          cardName: "Lightning Bolt",
          draftId: "draft-1",
          drafterName: "Unpicked",
          wasPicked: false,
        }),
      ];
      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Player1", { gamesWon: 5, gamesLost: 3 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());
      expect(result.size).toBe(0);
    });
  });

  describe("single player, single card", () => {
    it("should attribute all wins/losses to sole card", () => {
      const picks = [
        createPick({
          cardName: "Lightning Bolt",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      expect(result.size).toBe(1);
      const bolt = result.get("Lightning Bolt")!;
      expect(bolt.wins).toBe(6);
      expect(bolt.losses).toBe(2);
      expect(bolt.winRate).toBeCloseTo(0.75, 5);
    });
  });

  describe("single player, multiple cards, same pick position", () => {
    it("should split wins/losses equally when all cards have same weight", () => {
      const picks = [
        createPick({
          cardName: "Card A",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        createPick({
          cardName: "Card B",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      expect(result.size).toBe(2);
      // Both cards have weight PLAY_PROBABILITY_EARLY, so each gets 50%
      expect(result.get("Card A")!.wins).toBeCloseTo(3, 5);
      expect(result.get("Card A")!.losses).toBeCloseTo(1, 5);
      expect(result.get("Card B")!.wins).toBeCloseTo(3, 5);
      expect(result.get("Card B")!.losses).toBeCloseTo(1, 5);
    });
  });

  describe("single player, cards with different pick positions", () => {
    it("should weight equity by play probability", () => {
      // Card at pick 5: weight = PLAY_PROBABILITY_EARLY
      // Card at pick 25: weight = PLAY_PROBABILITY_LATE
      const totalWeight = PLAY_PROBABILITY_EARLY + PLAY_PROBABILITY_LATE;
      const picks = [
        createPick({
          cardName: "Early Pick",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        createPick({
          cardName: "Late Pick",
          pickPosition: 25,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 10, gamesLost: 5 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      const earlyPick = result.get("Early Pick")!;
      const latePick = result.get("Late Pick")!;

      // Early pick: PLAY_PROBABILITY_EARLY / totalWeight of wins/losses
      // Late pick: PLAY_PROBABILITY_LATE / totalWeight of wins/losses
      expect(earlyPick.wins).toBeCloseTo(10 * PLAY_PROBABILITY_EARLY / totalWeight, 3);
      expect(earlyPick.losses).toBeCloseTo(5 * PLAY_PROBABILITY_EARLY / totalWeight, 3);
      expect(latePick.wins).toBeCloseTo(10 * PLAY_PROBABILITY_LATE / totalWeight, 3);
      expect(latePick.losses).toBeCloseTo(5 * PLAY_PROBABILITY_LATE / totalWeight, 3);
    });
  });

  describe("land detection", () => {
    it("should treat lands as always played (weight LAND_PLAY_PROBABILITY)", () => {
      // Land at pick 50: normally would be PLAY_PROBABILITY_VERY_LATE, but lands are always LAND_PLAY_PROBABILITY
      // Non-land at pick 5: weight = PLAY_PROBABILITY_EARLY
      const totalWeight = LAND_PLAY_PROBABILITY + PLAY_PROBABILITY_EARLY;
      const picks = [
        createPick({
          cardName: "Late Land",
          pickPosition: 50,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        createPick({
          cardName: "Early Spell",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const scryfallData = new Map<string, ScryCard>();
      scryfallData.set("Late Land", createScryCard({ typeLine: "Basic Land - Mountain" }));
      scryfallData.set("Early Spell", createScryCard({ typeLine: "Instant" }));

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 10, gamesLost: 0 }]]));

      const result = calculateWinEquity(picks, matchStats, scryfallData);

      const land = result.get("Late Land")!;
      const spell = result.get("Early Spell")!;

      // Land: LAND_PLAY_PROBABILITY / totalWeight
      // Spell: PLAY_PROBABILITY_EARLY / totalWeight
      expect(land.wins).toBeCloseTo(10 * LAND_PLAY_PROBABILITY / totalWeight, 3);
      expect(spell.wins).toBeCloseTo(10 * PLAY_PROBABILITY_EARLY / totalWeight, 3);
    });

    it("should detect various land type lines", () => {
      const typesToTest = [
        "Land",
        "Basic Land",
        "Basic Land - Island",
        "Legendary Land",
        "Snow Land - Forest",
        "Land - Cave",
        "Artifact Land",
      ];

      for (const typeLine of typesToTest) {
        const picks = [
          createPick({
            cardName: "Test Land",
            pickPosition: 50, // Would be 0.1 for non-land
            draftId: "draft-1",
            drafterName: "Alice",
          }),
        ];

        const scryfallData = new Map<string, ScryCard>();
        scryfallData.set("Test Land", createScryCard({ typeLine }));

        const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
        matchStats.set("draft-1", new Map([["Alice", { gamesWon: 10, gamesLost: 0 }]]));

        const result = calculateWinEquity(picks, matchStats, scryfallData);

        // If it's a land, all 10 wins go to this single card
        expect(result.get("Test Land")!.wins).toBe(10);
      }
    });

    it("should treat cards without scryfall data as non-lands", () => {
      const picks = [
        createPick({
          cardName: "Unknown Card",
          pickPosition: 50,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 10, gamesLost: 0 }]]));

      // No scryfall data provided
      const result = calculateWinEquity(picks, matchStats, new Map());

      // Single card gets all wins, but would use non-land weight (0.1 for position 50)
      expect(result.get("Unknown Card")!.wins).toBe(10);
    });
  });

  describe("multiple players in same draft", () => {
    it("should calculate equity independently for each player", () => {
      const picks = [
        // Alice's pool
        createPick({
          cardName: "Card A",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        // Bob's pool
        createPick({
          cardName: "Card B",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Bob",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set(
        "draft-1",
        new Map([
          ["Alice", { gamesWon: 10, gamesLost: 2 }],
          ["Bob", { gamesWon: 5, gamesLost: 7 }],
        ])
      );

      const result = calculateWinEquity(picks, matchStats, new Map());

      // Card A is only in Alice's pool, gets all of Alice's equity
      expect(result.get("Card A")!.wins).toBe(10);
      expect(result.get("Card A")!.losses).toBe(2);

      // Card B is only in Bob's pool, gets all of Bob's equity
      expect(result.get("Card B")!.wins).toBe(5);
      expect(result.get("Card B")!.losses).toBe(7);
    });
  });

  describe("aggregation across drafts", () => {
    it("should sum equity across multiple drafts", () => {
      const picks = [
        // Draft 1: Alice has Card A
        createPick({
          cardName: "Card A",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        // Draft 2: Bob has Card A
        createPick({
          cardName: "Card A",
          pickPosition: 10,
          draftId: "draft-2",
          drafterName: "Bob",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));
      matchStats.set("draft-2", new Map([["Bob", { gamesWon: 4, gamesLost: 4 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      // Card A should have combined equity from both drafts
      const cardA = result.get("Card A")!;
      expect(cardA.wins).toBe(10); // 6 + 4
      expect(cardA.losses).toBe(6); // 2 + 4
      expect(cardA.winRate).toBeCloseTo(10 / 16, 5);
    });

    it("should handle same card appearing in multiple pools in same draft", () => {
      // This could happen with duplicates in a cube
      const picks = [
        createPick({
          cardName: "Lightning Bolt",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
          copyNumber: 1,
        }),
        createPick({
          cardName: "Lightning Bolt",
          pickPosition: 10,
          draftId: "draft-1",
          drafterName: "Bob",
          copyNumber: 2,
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set(
        "draft-1",
        new Map([
          ["Alice", { gamesWon: 6, gamesLost: 2 }],
          ["Bob", { gamesWon: 4, gamesLost: 4 }],
        ])
      );

      const result = calculateWinEquity(picks, matchStats, new Map());

      // Lightning Bolt gets equity from both players
      const bolt = result.get("Lightning Bolt")!;
      expect(bolt.wins).toBe(10); // 6 + 4
      expect(bolt.losses).toBe(6); // 2 + 4
    });
  });

  describe("edge cases", () => {
    it("should handle player with no picks in match stats", () => {
      const picks = [
        createPick({
          cardName: "Card A",
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set(
        "draft-1",
        new Map([
          ["Alice", { gamesWon: 6, gamesLost: 2 }],
          ["Bob", { gamesWon: 4, gamesLost: 4 }], // Bob has stats but no picks
        ])
      );

      const result = calculateWinEquity(picks, matchStats, new Map());

      // Only Alice's equity should be calculated
      expect(result.get("Card A")!.wins).toBe(6);
      expect(result.get("Card A")!.losses).toBe(2);
    });

    it("should handle zero wins and zero losses", () => {
      const picks = [
        createPick({
          cardName: "Card A",
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 0, gamesLost: 0 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      expect(result.get("Card A")!.wins).toBe(0);
      expect(result.get("Card A")!.losses).toBe(0);
      expect(result.get("Card A")!.winRate).toBe(0); // Should handle division by zero
    });

    it("should handle all losses", () => {
      const picks = [
        createPick({
          cardName: "Bad Card",
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 0, gamesLost: 8 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      expect(result.get("Bad Card")!.wins).toBe(0);
      expect(result.get("Bad Card")!.losses).toBe(8);
      expect(result.get("Bad Card")!.winRate).toBe(0);
    });

    it("should handle all wins", () => {
      const picks = [
        createPick({
          cardName: "Good Card",
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 8, gamesLost: 0 }]]));

      const result = calculateWinEquity(picks, matchStats, new Map());

      expect(result.get("Good Card")!.wins).toBe(8);
      expect(result.get("Good Card")!.losses).toBe(0);
      expect(result.get("Good Card")!.winRate).toBe(1);
    });
  });

  describe("real-world scenario", () => {
    it("should calculate correct equity for a realistic draft pool", () => {
      // Alice drafts: 3 early picks + 2 mid picks + 1 very late pick + 2 lands
      const picks = [
        // Early non-lands (weight PLAY_PROBABILITY_EARLY each)
        createPick({ cardName: "Lightning Bolt", pickPosition: 3, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Dark Ritual", pickPosition: 8, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Counterspell", pickPosition: 12, draftId: "d1", drafterName: "Alice" }),
        // Mid picks (weight PLAY_PROBABILITY_MID each)
        createPick({ cardName: "Hill Giant", pickPosition: 18, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Wind Drake", pickPosition: 22, draftId: "d1", drafterName: "Alice" }),
        // Very late pick (weight PLAY_PROBABILITY_VERY_LATE)
        createPick({ cardName: "Grizzly Bears", pickPosition: 35, draftId: "d1", drafterName: "Alice" }),
        // Lands (weight LAND_PLAY_PROBABILITY each, regardless of pick position)
        createPick({ cardName: "Mountain", pickPosition: 40, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Island", pickPosition: 42, draftId: "d1", drafterName: "Alice" }),
      ];

      const scryfallData = new Map<string, ScryCard>();
      scryfallData.set("Lightning Bolt", createScryCard({ typeLine: "Instant" }));
      scryfallData.set("Dark Ritual", createScryCard({ typeLine: "Instant" }));
      scryfallData.set("Counterspell", createScryCard({ typeLine: "Instant" }));
      scryfallData.set("Hill Giant", createScryCard({ typeLine: "Creature - Giant" }));
      scryfallData.set("Wind Drake", createScryCard({ typeLine: "Creature - Drake" }));
      scryfallData.set("Grizzly Bears", createScryCard({ typeLine: "Creature - Bear" }));
      scryfallData.set("Mountain", createScryCard({ typeLine: "Basic Land - Mountain" }));
      scryfallData.set("Island", createScryCard({ typeLine: "Basic Land - Island" }));

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));

      const result = calculateWinEquity(picks, matchStats, scryfallData);

      // Calculate expected weights:
      // 3 early (PLAY_PROBABILITY_EARLY * 3)
      // 2 mid (PLAY_PROBABILITY_MID * 2)
      // 1 very late (PLAY_PROBABILITY_VERY_LATE * 1)
      // 2 lands (LAND_PLAY_PROBABILITY * 2)
      const totalWeight =
        PLAY_PROBABILITY_EARLY * 3 +
        PLAY_PROBABILITY_MID * 2 +
        PLAY_PROBABILITY_VERY_LATE * 1 +
        LAND_PLAY_PROBABILITY * 2;

      // Verify early picks get their proportion each
      const earlyProportion = PLAY_PROBABILITY_EARLY / totalWeight;
      expect(result.get("Lightning Bolt")!.wins).toBeCloseTo(6 * earlyProportion, 3);
      expect(result.get("Dark Ritual")!.wins).toBeCloseTo(6 * earlyProportion, 3);
      expect(result.get("Counterspell")!.wins).toBeCloseTo(6 * earlyProportion, 3);

      // Mid picks get their proportion each
      const midProportion = PLAY_PROBABILITY_MID / totalWeight;
      expect(result.get("Hill Giant")!.wins).toBeCloseTo(6 * midProportion, 3);
      expect(result.get("Wind Drake")!.wins).toBeCloseTo(6 * midProportion, 3);

      // Very late pick gets its proportion
      const veryLateProportion = PLAY_PROBABILITY_VERY_LATE / totalWeight;
      expect(result.get("Grizzly Bears")!.wins).toBeCloseTo(6 * veryLateProportion, 3);

      // Lands get their proportion each
      const landProportion = LAND_PLAY_PROBABILITY / totalWeight;
      expect(result.get("Mountain")!.wins).toBeCloseTo(6 * landProportion, 3);
      expect(result.get("Island")!.wins).toBeCloseTo(6 * landProportion, 3);

      // Verify total wins sum to Alice's wins
      let totalWins = 0;
      for (const cardResult of result.values()) {
        totalWins += cardResult.wins;
      }
      expect(totalWins).toBeCloseTo(6, 5);
    });
  });

  describe("win rate calculation", () => {
    it("should calculate correct win rate", () => {
      const picks = [
        createPick({ cardName: "Card A", draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card A", draftId: "d2", drafterName: "Bob" }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 8, gamesLost: 2 }]])); // 80% wr
      matchStats.set("d2", new Map([["Bob", { gamesWon: 3, gamesLost: 7 }]])); // 30% wr

      const result = calculateWinEquity(picks, matchStats, new Map());

      const cardA = result.get("Card A")!;
      // Total: 11 wins, 9 losses
      expect(cardA.wins).toBe(11);
      expect(cardA.losses).toBe(9);
      expect(cardA.winRate).toBeCloseTo(11 / 20, 5);
    });
  });
});

describe("calculateRawWinRate", () => {
  describe("basic functionality", () => {
    it("should return empty map when no picks provided", () => {
      const result = calculateRawWinRate([], new Map());
      expect(result.size).toBe(0);
    });

    it("should return empty map when no match stats provided", () => {
      const picks = [createPick({ cardName: "Lightning Bolt" })];
      const result = calculateRawWinRate(picks, new Map());
      expect(result.size).toBe(0);
    });

    it("should skip unpicked cards", () => {
      const picks = [
        createPick({
          cardName: "Lightning Bolt",
          draftId: "draft-1",
          drafterName: "Unpicked",
          wasPicked: false,
        }),
      ];
      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Player1", { gamesWon: 5, gamesLost: 3 }]]));

      const result = calculateRawWinRate(picks, matchStats);
      expect(result.size).toBe(0);
    });
  });

  describe("equal distribution (no weighting)", () => {
    it("should distribute wins equally among cards regardless of pick position", () => {
      // Key difference from win equity: pick position doesn't affect weight
      const picks = [
        createPick({
          cardName: "Early Pick",
          pickPosition: 1, // Would be 0.95 weight in equity
          draftId: "draft-1",
          drafterName: "Alice",
        }),
        createPick({
          cardName: "Late Pick",
          pickPosition: 50, // Would be 0.1 weight in equity
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 10, gamesLost: 4 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      // Both cards should get exactly 50% - no weighting by pick position
      const earlyPick = result.get("Early Pick")!;
      const latePick = result.get("Late Pick")!;

      expect(earlyPick.wins).toBe(5); // 10 * 0.5
      expect(earlyPick.losses).toBe(2); // 4 * 0.5
      expect(latePick.wins).toBe(5);
      expect(latePick.losses).toBe(2);
    });

    it("should distribute equally among 4 cards", () => {
      const picks = [
        createPick({ cardName: "Card A", pickPosition: 1, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card B", pickPosition: 10, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card C", pickPosition: 25, draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card D", pickPosition: 40, draftId: "d1", drafterName: "Alice" }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 8, gamesLost: 4 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      // Each card gets 25% regardless of pick position
      for (const cardName of ["Card A", "Card B", "Card C", "Card D"]) {
        expect(result.get(cardName)!.wins).toBe(2); // 8 / 4
        expect(result.get(cardName)!.losses).toBe(1); // 4 / 4
      }
    });
  });

  describe("single player, single card", () => {
    it("should attribute all wins/losses to sole card", () => {
      const picks = [
        createPick({
          cardName: "Lightning Bolt",
          pickPosition: 5,
          draftId: "draft-1",
          drafterName: "Alice",
        }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("draft-1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      expect(result.size).toBe(1);
      const bolt = result.get("Lightning Bolt")!;
      expect(bolt.wins).toBe(6);
      expect(bolt.losses).toBe(2);
      expect(bolt.winRate).toBeCloseTo(0.75, 5);
    });
  });

  describe("multiple players", () => {
    it("should calculate independently for each player", () => {
      const picks = [
        createPick({ cardName: "Card A", draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card B", draftId: "d1", drafterName: "Bob" }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set(
        "d1",
        new Map([
          ["Alice", { gamesWon: 10, gamesLost: 2 }],
          ["Bob", { gamesWon: 5, gamesLost: 7 }],
        ])
      );

      const result = calculateRawWinRate(picks, matchStats);

      expect(result.get("Card A")!.wins).toBe(10);
      expect(result.get("Card A")!.losses).toBe(2);
      expect(result.get("Card B")!.wins).toBe(5);
      expect(result.get("Card B")!.losses).toBe(7);
    });
  });

  describe("aggregation across drafts", () => {
    it("should sum wins/losses across multiple drafts", () => {
      const picks = [
        createPick({ cardName: "Card A", draftId: "d1", drafterName: "Alice" }),
        createPick({ cardName: "Card A", draftId: "d2", drafterName: "Bob" }),
      ];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 6, gamesLost: 2 }]]));
      matchStats.set("d2", new Map([["Bob", { gamesWon: 4, gamesLost: 4 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      const cardA = result.get("Card A")!;
      expect(cardA.wins).toBe(10); // 6 + 4
      expect(cardA.losses).toBe(6); // 2 + 4
      expect(cardA.winRate).toBeCloseTo(10 / 16, 5);
    });
  });

  describe("edge cases", () => {
    it("should handle zero wins and zero losses", () => {
      const picks = [createPick({ cardName: "Card A", draftId: "d1", drafterName: "Alice" })];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 0, gamesLost: 0 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      expect(result.get("Card A")!.wins).toBe(0);
      expect(result.get("Card A")!.losses).toBe(0);
      expect(result.get("Card A")!.winRate).toBe(0);
    });

    it("should handle all wins", () => {
      const picks = [createPick({ cardName: "Good Card", draftId: "d1", drafterName: "Alice" })];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 8, gamesLost: 0 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      expect(result.get("Good Card")!.winRate).toBe(1);
    });

    it("should handle all losses", () => {
      const picks = [createPick({ cardName: "Bad Card", draftId: "d1", drafterName: "Alice" })];

      const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
      matchStats.set("d1", new Map([["Alice", { gamesWon: 0, gamesLost: 8 }]]));

      const result = calculateRawWinRate(picks, matchStats);

      expect(result.get("Bad Card")!.winRate).toBe(0);
    });
  });
});
