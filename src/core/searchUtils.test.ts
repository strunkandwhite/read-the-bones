import { describe, it, expect } from "vitest";
import { hasScryfallOperators } from "./searchUtils";

describe("hasScryfallOperators", () => {
  describe("type operator", () => {
    it("should detect type: operator", () => {
      expect(hasScryfallOperators("type:creature")).toBe(true);
    });

    it("should detect t: shorthand", () => {
      expect(hasScryfallOperators("t:instant")).toBe(true);
    });

    it("should detect type= operator", () => {
      expect(hasScryfallOperators("type=land")).toBe(true);
    });
  });

  describe("color operator", () => {
    it("should detect c: operator", () => {
      expect(hasScryfallOperators("c:r")).toBe(true);
    });

    it("should detect color: operator", () => {
      expect(hasScryfallOperators("color:red")).toBe(true);
    });
  });

  describe("mana value operators", () => {
    it("should detect cmc= operator", () => {
      expect(hasScryfallOperators("cmc=3")).toBe(true);
    });

    it("should detect cmc> operator", () => {
      expect(hasScryfallOperators("cmc>2")).toBe(true);
    });

    it("should detect cmc< operator", () => {
      expect(hasScryfallOperators("cmc<5")).toBe(true);
    });

    it("should detect mv: operator", () => {
      expect(hasScryfallOperators("mv:4")).toBe(true);
    });
  });

  describe("oracle text operators", () => {
    it("should detect o: operator", () => {
      expect(hasScryfallOperators("o:flying")).toBe(true);
    });

    it("should detect oracle: operator", () => {
      expect(hasScryfallOperators("oracle:trample")).toBe(true);
    });
  });

  describe("plain text searches (no operators)", () => {
    it("should return false for simple card name", () => {
      expect(hasScryfallOperators("Lightning Bolt")).toBe(false);
    });

    it("should return false for partial card name", () => {
      expect(hasScryfallOperators("bolt")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(hasScryfallOperators("")).toBe(false);
    });

    it("should return false for card names containing operator-like substrings", () => {
      // "Colorless" contains "color" but not followed by operator syntax
      expect(hasScryfallOperators("Colorless")).toBe(false);
    });

    it("should return false for words ending with operator keywords", () => {
      // "Isochron" starts with "is" but is not an operator
      expect(hasScryfallOperators("Isochron Scepter")).toBe(false);
    });
  });

  describe("mixed queries", () => {
    it("should detect operators in complex queries", () => {
      expect(hasScryfallOperators("dragon type:creature")).toBe(true);
    });

    it("should detect multiple operators", () => {
      expect(hasScryfallOperators("c:r cmc<3")).toBe(true);
    });

    it("should be case insensitive", () => {
      expect(hasScryfallOperators("TYPE:creature")).toBe(true);
      expect(hasScryfallOperators("CMC>3")).toBe(true);
    });
  });
});
