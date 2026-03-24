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
    it("should detect mv= operator", () => {
      expect(hasScryfallOperators("mv=3")).toBe(true);
    });

    it("should detect mv> operator", () => {
      expect(hasScryfallOperators("mv>2")).toBe(true);
    });

    it("should detect mv< operator", () => {
      expect(hasScryfallOperators("mv<5")).toBe(true);
    });

    it("should detect mv: operator", () => {
      expect(hasScryfallOperators("mv:4")).toBe(true);
    });

    it("should detect cmc= alias", () => {
      expect(hasScryfallOperators("cmc=3")).toBe(true);
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

  describe("new operators", () => {
    it("should detect id: operator", () => {
      expect(hasScryfallOperators("id:wu")).toBe(true);
    });

    it("should detect identity: operator", () => {
      expect(hasScryfallOperators("identity:ubr")).toBe(true);
    });

    it("should detect m: operator", () => {
      expect(hasScryfallOperators("m:GG")).toBe(true);
    });

    it("should detect mana: operator", () => {
      expect(hasScryfallOperators("mana:{U}{U}")).toBe(true);
    });
  });

  describe("syntax features", () => {
    it("should detect negation mid-query", () => {
      expect(hasScryfallOperators("bolt -t:creature")).toBe(true);
    });

    it("should detect exact name with !", () => {
      expect(hasScryfallOperators("!Lightning Bolt")).toBe(true);
    });

    it("should detect OR keyword", () => {
      expect(hasScryfallOperators("t:creature or t:artifact")).toBe(true);
    });

    it("should detect parentheses", () => {
      expect(hasScryfallOperators("(t:instant) c:r")).toBe(true);
    });
  });

  describe("mixed queries", () => {
    it("should detect operators in complex queries", () => {
      expect(hasScryfallOperators("dragon type:creature")).toBe(true);
    });

    it("should detect multiple operators", () => {
      expect(hasScryfallOperators("c:r mv<3")).toBe(true);
    });

    it("should be case insensitive", () => {
      expect(hasScryfallOperators("TYPE:creature")).toBe(true);
      expect(hasScryfallOperators("CMC>3")).toBe(true);
    });
  });
});
