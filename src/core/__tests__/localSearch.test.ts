import { describe, expect, it } from "vitest";
import { searchLocalCards } from "../localSearch";
import type { ScryCard } from "../types";

// ─── Test Fixtures ───────────────────────────────────────────────────────────

function card(overrides: Partial<ScryCard> & { name: string }): ScryCard {
  return {
    imageUri: "",
    manaCost: "",
    manaValue: 0,
    typeLine: "",
    colors: [],
    colorIdentity: [],
    oracleText: "",
    ...overrides,
  };
}

const bolt = card({
  name: "Lightning Bolt",
  manaCost: "{R}",
  manaValue: 1,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText: "Lightning Bolt deals 3 damage to any target.",
});

const counterspell = card({
  name: "Counterspell",
  manaCost: "{U}{U}",
  manaValue: 2,
  typeLine: "Instant",
  colors: ["U"],
  colorIdentity: ["U"],
  oracleText: "Counter target spell.",
});

const tarmogoyf = card({
  name: "Tarmogoyf",
  manaCost: "{1}{G}",
  manaValue: 2,
  typeLine: "Creature — Lhurgoyf",
  colors: ["G"],
  colorIdentity: ["G"],
  oracleText:
    "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
});

const nicol = card({
  name: "Nicol Bolas, Planeswalker",
  manaCost: "{4}{U}{B}{B}{R}",
  manaValue: 8,
  typeLine: "Legendary Planeswalker — Bolas",
  colors: ["U", "B", "R"],
  colorIdentity: ["U", "B", "R"],
  oracleText: "+3: Destroy target noncreature permanent.\n-2: Gain control of target creature.",
});

const solRing = card({
  name: "Sol Ring",
  manaCost: "{1}",
  manaValue: 1,
  typeLine: "Artifact",
  colors: [],
  colorIdentity: [],
  oracleText: "{T}: Add {C}{C}.",
});

const azorius = card({
  name: "Azorius Signet",
  manaCost: "{2}",
  manaValue: 2,
  typeLine: "Artifact",
  colors: [],
  colorIdentity: ["W", "U"],
  oracleText: "{1}, {T}: Add {W}{U}.",
});

const fire = card({
  name: "Fire",
  manaCost: "{1}{R}",
  manaValue: 2,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText: "Fire deals 2 damage divided as you choose among one or two targets.",
});

const allCards = [bolt, counterspell, tarmogoyf, nicol, solRing, azorius, fire];

function names(cards: ScryCard[]): string[] {
  return cards.map((c) => c.name).sort();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("searchLocalCards", () => {
  describe("existing operators", () => {
    it("returns all cards for empty query", () => {
      expect(searchLocalCards("", allCards)).toEqual(allCards);
    });

    it("name search (plain text)", () => {
      expect(names(searchLocalCards("bolt", allCards))).toEqual(["Lightning Bolt"]);
    });

    it("type search", () => {
      expect(names(searchLocalCards("t:instant", allCards))).toEqual([
        "Counterspell", "Fire", "Lightning Bolt",
      ]);
    });

    it("oracle text search", () => {
      expect(names(searchLocalCards("o:damage", allCards))).toEqual([
        "Fire", "Lightning Bolt",
      ]);
    });

    it("oracle text with quotes", () => {
      expect(names(searchLocalCards('o:"any target"', allCards))).toEqual([
        "Lightning Bolt",
      ]);
    });

    it("color search (single)", () => {
      expect(names(searchLocalCards("c:r", allCards))).toEqual([
        "Fire", "Lightning Bolt", "Nicol Bolas, Planeswalker",
      ]);
    });

    it("color search (multi — AND)", () => {
      expect(names(searchLocalCards("c:ub", allCards))).toEqual([
        "Nicol Bolas, Planeswalker",
      ]);
    });

    it("colorless search", () => {
      expect(names(searchLocalCards("c:c", allCards))).toEqual([
        "Azorius Signet", "Sol Ring",
      ]);
    });

    it("mana value exact", () => {
      expect(names(searchLocalCards("mv=1", allCards))).toEqual([
        "Lightning Bolt", "Sol Ring",
      ]);
    });

    it("mana value comparison", () => {
      expect(names(searchLocalCards("mv>=8", allCards))).toEqual([
        "Nicol Bolas, Planeswalker",
      ]);
    });

    it("combined terms (AND logic)", () => {
      expect(names(searchLocalCards("t:instant c:r", allCards))).toEqual([
        "Fire", "Lightning Bolt",
      ]);
    });
  });

  describe("negation", () => {
    it("negates a type term", () => {
      const results = searchLocalCards("-t:instant", allCards);
      expect(names(results)).toEqual([
        "Azorius Signet", "Nicol Bolas, Planeswalker", "Sol Ring", "Tarmogoyf",
      ]);
    });

    it("negates a color term", () => {
      const results = searchLocalCards("-c:r", allCards);
      expect(names(results)).toEqual([
        "Azorius Signet", "Counterspell", "Sol Ring", "Tarmogoyf",
      ]);
    });

    it("combines negation with positive terms", () => {
      expect(names(searchLocalCards("t:instant -c:r", allCards))).toEqual([
        "Counterspell",
      ]);
    });

    it("negates mana value", () => {
      expect(names(searchLocalCards("-mv=2", allCards))).toEqual([
        "Lightning Bolt", "Nicol Bolas, Planeswalker", "Sol Ring",
      ]);
    });
  });

  describe("OR logic", () => {
    it("basic OR between two terms", () => {
      expect(names(searchLocalCards("t:creature or t:artifact", allCards))).toEqual([
        "Azorius Signet", "Sol Ring", "Tarmogoyf",
      ]);
    });

    it("OR with three terms", () => {
      const results = searchLocalCards("bolt or counterspell or tarmogoyf", allCards);
      expect(names(results)).toEqual([
        "Counterspell", "Lightning Bolt", "Tarmogoyf",
      ]);
    });
  });

  describe("parentheses grouping", () => {
    it("groups OR with AND", () => {
      // Red instants or sorceries (but there are no sorceries, so just red instants)
      expect(
        names(searchLocalCards("(t:instant or t:sorcery) c:r", allCards))
      ).toEqual(["Fire", "Lightning Bolt"]);
    });

    it("nested groups", () => {
      // (instant or creature) and (red or green)
      expect(
        names(searchLocalCards("(t:instant or t:creature) (c:r or c:g)", allCards))
      ).toEqual(["Fire", "Lightning Bolt", "Tarmogoyf"]);
    });

    it("negated group with De Morgan's", () => {
      // -(instant or creature) = not instant AND not creature
      const results = searchLocalCards("-(t:instant or t:creature)", allCards);
      expect(names(results)).toEqual([
        "Azorius Signet", "Nicol Bolas, Planeswalker", "Sol Ring",
      ]);
    });
  });

  describe("exact name (!)", () => {
    it("matches exact name", () => {
      expect(names(searchLocalCards("!Fire", allCards))).toEqual(["Fire"]);
    });

    it("does not match partial name", () => {
      expect(searchLocalCards("!Lightning", allCards)).toEqual([]);
    });

    it("is case-insensitive", () => {
      expect(names(searchLocalCards("!fire", allCards))).toEqual(["Fire"]);
    });

    it("works with quoted exact name", () => {
      expect(names(searchLocalCards('!"Lightning Bolt"', allCards))).toEqual([
        "Lightning Bolt",
      ]);
    });
  });

  describe("color identity (id:)", () => {
    it("matches color identity", () => {
      // Azorius Signet is colorless but has W/U identity; Nicol is UBR (no W)
      expect(names(searchLocalCards("id:wu", allCards))).toEqual([
        "Azorius Signet",
      ]);
    });

    it("matches identity superset", () => {
      // Nicol Bolas has UBR identity — id:ub should match
      expect(names(searchLocalCards("id:ub", allCards))).toEqual([
        "Nicol Bolas, Planeswalker",
      ]);
    });

    it("matches exact identity", () => {
      expect(names(searchLocalCards("id=wu", allCards))).toEqual([
        "Azorius Signet",
      ]);
    });
  });

  describe("mana cost (m:)", () => {
    it("matches mana symbol shorthand", () => {
      expect(names(searchLocalCards("m:uu", allCards))).toEqual(["Counterspell"]);
    });

    it("matches with brace notation", () => {
      expect(names(searchLocalCards("m:{U}{U}", allCards))).toEqual(["Counterspell"]);
    });

    it("matches single symbol", () => {
      const results = searchLocalCards("m:r", allCards);
      expect(names(results)).toEqual([
        "Fire", "Lightning Bolt", "Nicol Bolas, Planeswalker",
      ]);
    });
  });

  describe("color comparisons", () => {
    it("c:m finds multicolor cards", () => {
      expect(names(searchLocalCards("c:m", allCards))).toEqual([
        "Nicol Bolas, Planeswalker",
      ]);
    });

    it("c=r finds exactly mono-red", () => {
      expect(names(searchLocalCards("c=r", allCards))).toEqual([
        "Fire", "Lightning Bolt",
      ]);
    });

    it("c>=ub finds cards with at least U and B", () => {
      expect(names(searchLocalCards("c>=ub", allCards))).toEqual([
        "Nicol Bolas, Planeswalker",
      ]);
    });

    it("c<=r finds cards that are subset of red (colorless or mono-red)", () => {
      expect(names(searchLocalCards("c<=r", allCards))).toEqual([
        "Azorius Signet", "Fire", "Lightning Bolt", "Sol Ring",
      ]);
    });
  });

  describe("mv!= (not equal)", () => {
    it("excludes specific mana value", () => {
      expect(names(searchLocalCards("mv!=2", allCards))).toEqual([
        "Lightning Bolt", "Nicol Bolas, Planeswalker", "Sol Ring",
      ]);
    });
  });

  describe("cmc alias", () => {
    it("cmc works as mv alias", () => {
      expect(names(searchLocalCards("cmc=2", allCards))).toEqual(
        names(searchLocalCards("mv=2", allCards))
      );
    });

    it("cmc: colon shorthand works", () => {
      expect(names(searchLocalCards("cmc:2", allCards))).toEqual(
        names(searchLocalCards("mv=2", allCards))
      );
    });
  });

  describe("edge cases", () => {
    it("whitespace-only query returns all", () => {
      expect(searchLocalCards("   ", allCards)).toEqual(allCards);
    });

    it("unknown operator treated as name search", () => {
      expect(searchLocalCards("x:foo", allCards)).toEqual([]);
    });

    it("unmatched closing paren doesn't crash", () => {
      expect(() => searchLocalCards("t:instant)", allCards)).not.toThrow();
    });

    it("unmatched opening paren doesn't crash", () => {
      expect(() => searchLocalCards("(t:instant", allCards)).not.toThrow();
    });

    it("empty parens don't crash", () => {
      expect(() => searchLocalCards("()", allCards)).not.toThrow();
    });

    it("or at start of query doesn't crash", () => {
      expect(() => searchLocalCards("or t:instant", allCards)).not.toThrow();
    });

    it("or at end of query doesn't crash", () => {
      expect(() => searchLocalCards("t:instant or", allCards)).not.toThrow();
    });
  });
});
