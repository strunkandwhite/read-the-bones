import { describe, it, expect } from "vitest";
import { filterCardsByColor, type ColorFilterableCard } from "./colorFilter";

// Helper to create test cards with color information
function createCard(colors: string[], useScryfall = false): ColorFilterableCard {
  if (useScryfall) {
    return {
      scryfall: { colorIdentity: colors },
    };
  }
  return { colors };
}

// Test fixtures
const redCard = createCard(["R"]);
const blueCard = createCard(["U"]);
const greenCard = createCard(["G"]);
const colorlessCard = createCard([]);
const redBlueCard = createCard(["R", "U"]);
const grixisCard = createCard(["U", "B", "R"]); // 3-color
const redCardScryfall = createCard(["R"], true);
const colorlessCardScryfall = createCard([], true);

const allCards: ColorFilterableCard[] = [
  redCard,
  blueCard,
  greenCard,
  colorlessCard,
  redBlueCard,
  grixisCard,
];

describe("filterCardsByColor", () => {
  describe("empty filter", () => {
    it("returns all cards when colorFilter is empty", () => {
      const result = filterCardsByColor(allCards, [], "inclusive");
      expect(result).toHaveLength(allCards.length);
      expect(result).toEqual(allCards);
    });

    it("returns all cards when colorFilter is empty (exclusive mode)", () => {
      const result = filterCardsByColor(allCards, [], "exclusive");
      expect(result).toHaveLength(allCards.length);
      expect(result).toEqual(allCards);
    });
  });

  describe("colorless filtering", () => {
    it('cards with empty color array match when "C" is selected (inclusive)', () => {
      const result = filterCardsByColor(allCards, ["C"], "inclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(colorlessCard);
    });

    it('cards with empty color array match when "C" is selected (exclusive)', () => {
      const result = filterCardsByColor(allCards, ["C"], "exclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(colorlessCard);
    });

    it("colorless card with scryfall data matches when C is selected", () => {
      const cards = [colorlessCardScryfall, redCardScryfall];
      const result = filterCardsByColor(cards, ["C"], "inclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(colorlessCardScryfall);
    });
  });

  describe("inclusive mode - single color", () => {
    it('cards with red in their colors match when "R" is selected', () => {
      const result = filterCardsByColor(allCards, ["R"], "inclusive");
      expect(result).toHaveLength(3); // redCard, redBlueCard, grixisCard
      expect(result).toContain(redCard);
      expect(result).toContain(redBlueCard);
      expect(result).toContain(grixisCard);
    });

    it('cards with blue in their colors match when "U" is selected', () => {
      const result = filterCardsByColor(allCards, ["U"], "inclusive");
      expect(result).toHaveLength(3); // blueCard, redBlueCard, grixisCard
      expect(result).toContain(blueCard);
      expect(result).toContain(redBlueCard);
      expect(result).toContain(grixisCard);
    });

    it("uses scryfall.colorIdentity when available", () => {
      const cards = [redCardScryfall, colorlessCardScryfall];
      const result = filterCardsByColor(cards, ["R"], "inclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(redCardScryfall);
    });
  });

  describe("inclusive mode - multi-color selection", () => {
    it("multicolor cards match if they have ANY selected color", () => {
      // Select R and G - should match: redCard, greenCard, redBlueCard (has R), grixisCard (has R)
      const result = filterCardsByColor(allCards, ["R", "G"], "inclusive");
      expect(result).toHaveLength(4);
      expect(result).toContain(redCard);
      expect(result).toContain(greenCard);
      expect(result).toContain(redBlueCard);
      expect(result).toContain(grixisCard);
    });

    it("matches cards with at least one of the selected colors", () => {
      // Select U and B - should match: blueCard, redBlueCard, grixisCard
      const result = filterCardsByColor(allCards, ["U", "B"], "inclusive");
      expect(result).toHaveLength(3);
      expect(result).toContain(blueCard);
      expect(result).toContain(redBlueCard);
      expect(result).toContain(grixisCard);
    });
  });

  describe("exclusive mode - single color", () => {
    it("only mono-colored cards of that color match", () => {
      // Select only R - should only match redCard (mono-red)
      // redBlueCard and grixisCard have colors NOT in [R], so excluded
      const result = filterCardsByColor(allCards, ["R"], "exclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(redCard);
    });

    it("excludes multicolor cards that have additional colors", () => {
      // Select only U - redBlueCard has R which is not selected, so excluded
      const result = filterCardsByColor(allCards, ["U"], "exclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(blueCard);
    });
  });

  describe("exclusive mode - multi-color selection", () => {
    it("cards whose colors are a subset of selected colors match", () => {
      // Select R and U - should match: redCard, blueCard, redBlueCard
      // grixisCard has B which is not in [R, U], so excluded
      const result = filterCardsByColor(allCards, ["R", "U"], "exclusive");
      expect(result).toHaveLength(3);
      expect(result).toContain(redCard);
      expect(result).toContain(blueCard);
      expect(result).toContain(redBlueCard);
    });

    it("grixis card matches when all three colors selected", () => {
      // Select U, B, R - grixisCard colors are exactly these
      const result = filterCardsByColor(allCards, ["U", "B", "R"], "exclusive");
      expect(result).toHaveLength(4); // blueCard, redCard, redBlueCard, grixisCard
      expect(result).toContain(grixisCard);
    });

    it("excludes cards with colors outside selection", () => {
      // Select U and G - redBlueCard has R (not in selection), grixisCard has B and R
      const result = filterCardsByColor(allCards, ["U", "G"], "exclusive");
      expect(result).toHaveLength(2);
      expect(result).toContain(blueCard);
      expect(result).toContain(greenCard);
    });
  });

  describe("colorless with other colors", () => {
    it('when "C" and "R" are selected, both colorless and red cards match (inclusive)', () => {
      const result = filterCardsByColor(allCards, ["C", "R"], "inclusive");
      expect(result).toHaveLength(4); // colorlessCard, redCard, redBlueCard, grixisCard
      expect(result).toContain(colorlessCard);
      expect(result).toContain(redCard);
      expect(result).toContain(redBlueCard);
      expect(result).toContain(grixisCard);
    });

    it('when "C" and "U" are selected, both colorless and blue cards match (inclusive)', () => {
      const result = filterCardsByColor(allCards, ["C", "U"], "inclusive");
      expect(result).toHaveLength(4); // colorlessCard, blueCard, redBlueCard, grixisCard
      expect(result).toContain(colorlessCard);
      expect(result).toContain(blueCard);
    });
  });

  describe("edge case: colorless in exclusive mode", () => {
    it('colorless cards still match when only "C" is selected', () => {
      const result = filterCardsByColor(allCards, ["C"], "exclusive");
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(colorlessCard);
    });

    it('colorless matches with C and colored cards excluded when C is in filter (exclusive)', () => {
      // In exclusive mode with C and R:
      // - colorlessCard matches via colorless check
      // - redCard matches (R is subset of [R])
      // - others excluded
      const result = filterCardsByColor(allCards, ["C", "R"], "exclusive");
      expect(result).toHaveLength(2);
      expect(result).toContain(colorlessCard);
      expect(result).toContain(redCard);
    });
  });

  describe("edge cases", () => {
    it("handles empty cards array", () => {
      const result = filterCardsByColor([], ["R"], "inclusive");
      expect(result).toHaveLength(0);
    });

    it("handles cards with neither scryfall nor colors property", () => {
      const cardWithNoColors: ColorFilterableCard = {};
      const result = filterCardsByColor([cardWithNoColors], ["C"], "inclusive");
      expect(result).toHaveLength(1); // Treated as colorless
    });

    it("handles cards with undefined colors gracefully", () => {
      const cardWithUndefined: ColorFilterableCard = { colors: undefined };
      const result = filterCardsByColor([cardWithUndefined], ["C"], "inclusive");
      expect(result).toHaveLength(1); // Treated as colorless
    });

    it("prefers scryfall.colorIdentity over colors when both present", () => {
      const cardWithBoth: ColorFilterableCard = {
        scryfall: { colorIdentity: ["U"] },
        colors: ["R"],
      };
      // Should use scryfall.colorIdentity (U), not colors (R)
      const resultU = filterCardsByColor([cardWithBoth], ["U"], "inclusive");
      expect(resultU).toHaveLength(1);

      const resultR = filterCardsByColor([cardWithBoth], ["R"], "inclusive");
      expect(resultR).toHaveLength(0);
    });
  });
});
