import { describe, it, expect } from "vitest";
import { searchLocalCards } from "./localSearch";
import type { ScryCard } from "./types";

// Helper to create test cards with sensible defaults
function createCard(overrides: Partial<ScryCard>): ScryCard {
  return {
    name: "Test Card",
    imageUri: "https://example.com/card.jpg",
    manaCost: "{1}",
    manaValue: 1,
    typeLine: "Creature",
    colors: [],
    colorIdentity: [],
    oracleText: "",
    ...overrides,
  };
}

// Test card fixtures
const lightningBolt = createCard({
  name: "Lightning Bolt",
  manaCost: "{R}",
  manaValue: 1,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText: "Lightning Bolt deals 3 damage to any target.",
});

const counterspell = createCard({
  name: "Counterspell",
  manaCost: "{U}{U}",
  manaValue: 2,
  typeLine: "Instant",
  colors: ["U"],
  colorIdentity: ["U"],
  oracleText: "Counter target spell.",
});

const tarmogoyf = createCard({
  name: "Tarmogoyf",
  manaCost: "{1}{G}",
  manaValue: 2,
  typeLine: "Creature - Lhurgoyf",
  colors: ["G"],
  colorIdentity: ["G"],
  oracleText:
    "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
});

const searingBlaze = createCard({
  name: "Searing Blaze",
  manaCost: "{R}{R}",
  manaValue: 2,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText:
    "Searing Blaze deals 1 damage to target player or planeswalker and 1 damage to target creature that player or that planeswalker's controller controls.",
});

const deathriteShamam = createCard({
  name: "Deathrite Shaman",
  manaCost: "{B/G}",
  manaValue: 1,
  typeLine: "Creature - Elf Shaman",
  colors: ["B", "G"],
  colorIdentity: ["B", "G"],
  oracleText:
    "{T}: Exile target land card from a graveyard. Add one mana of any color.",
});

const solRing = createCard({
  name: "Sol Ring",
  manaCost: "{1}",
  manaValue: 1,
  typeLine: "Artifact",
  colors: [],
  colorIdentity: [],
  oracleText: "{T}: Add {C}{C}.",
});

const nicoBolas = createCard({
  name: "Nicol Bolas, the Ravager",
  manaCost: "{1}{U}{B}{R}",
  manaValue: 4,
  typeLine: "Legendary Creature - Elder Dragon",
  colors: ["U", "B", "R"],
  colorIdentity: ["U", "B", "R"],
  oracleText:
    "Flying. When Nicol Bolas, the Ravager enters the battlefield, each opponent discards a card.",
});

const stormCrow = createCard({
  name: "Storm Crow",
  manaCost: "{1}{U}",
  manaValue: 2,
  typeLine: "Creature - Bird",
  colors: ["U"],
  colorIdentity: ["U"],
  oracleText: "Flying",
});

const emrakul = createCard({
  name: "Emrakul, the Aeons Torn",
  manaCost: "{15}",
  manaValue: 15,
  typeLine: "Legendary Creature - Eldrazi",
  colors: [],
  colorIdentity: [],
  oracleText:
    "This spell can't be countered. When you cast this spell, take an extra turn after this one. Flying, protection from spells that are one or more colors, annihilator 6.",
});

const testCards: ScryCard[] = [
  lightningBolt,
  counterspell,
  tarmogoyf,
  searingBlaze,
  deathriteShamam,
  solRing,
  nicoBolas,
  stormCrow,
  emrakul,
];

describe("searchLocalCards", () => {
  describe("empty and whitespace queries", () => {
    it("should return all cards for empty query", () => {
      const result = searchLocalCards("", testCards);
      expect(result).toHaveLength(testCards.length);
    });

    it("should return all cards for whitespace-only query", () => {
      const result = searchLocalCards("   ", testCards);
      expect(result).toHaveLength(testCards.length);
    });
  });

  describe("name search (plain text)", () => {
    it("should find cards by exact name match", () => {
      const result = searchLocalCards("Lightning Bolt", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Lightning Bolt");
    });

    it("should find cards by partial name match", () => {
      const result = searchLocalCards("bolt", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Lightning Bolt");
    });

    it("should be case-insensitive for name search", () => {
      const result = searchLocalCards("LIGHTNING", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Lightning Bolt");
    });

    it("should return empty array when no cards match name", () => {
      const result = searchLocalCards("Nonexistent Card", testCards);
      expect(result).toHaveLength(0);
    });

    it("should match partial names across multiple cards", () => {
      const result = searchLocalCards("Searing", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Searing Blaze");
    });
  });

  describe("type operator (type: and t:)", () => {
    it("should find creatures with type:", () => {
      const result = searchLocalCards("type:creature", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.typeLine.toLowerCase().includes("creature"))).toBe(true);
    });

    it("should find creatures with t: shorthand", () => {
      const result = searchLocalCards("t:creature", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.typeLine.toLowerCase().includes("creature"))).toBe(true);
    });

    it("should find instants", () => {
      const result = searchLocalCards("t:instant", testCards);
      expect(result).toHaveLength(3); // Lightning Bolt, Counterspell, Searing Blaze
      expect(result.every((c) => c.typeLine.toLowerCase().includes("instant"))).toBe(true);
    });

    it("should find artifacts", () => {
      const result = searchLocalCards("t:artifact", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Sol Ring");
    });

    it("should be case-insensitive for type", () => {
      const result = searchLocalCards("TYPE:CREATURE", testCards);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should match partial type line (subtypes)", () => {
      const result = searchLocalCards("t:dragon", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Nicol Bolas, the Ravager");
    });

    it("should match legendary", () => {
      const result = searchLocalCards("t:legendary", testCards);
      expect(result).toHaveLength(2); // Nicol Bolas and Emrakul
    });
  });

  describe("oracle operator (oracle: and o:)", () => {
    it("should find cards with oracle text using oracle:", () => {
      const result = searchLocalCards("oracle:flying", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.oracleText.toLowerCase().includes("flying"))).toBe(true);
    });

    it("should find cards with oracle text using o: shorthand", () => {
      const result = searchLocalCards("o:flying", testCards);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should find cards dealing damage", () => {
      const result = searchLocalCards("o:damage", testCards);
      expect(result).toHaveLength(2); // Lightning Bolt and Searing Blaze
    });

    it("should be case-insensitive for oracle text", () => {
      const result = searchLocalCards("O:COUNTER", testCards);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should find cards with specific phrases", () => {
      const result = searchLocalCards("o:target spell", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Counterspell");
    });
  });

  describe("color operator (color: and c:)", () => {
    it("should find red cards with c:r", () => {
      const result = searchLocalCards("c:r", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.colors.includes("R"))).toBe(true);
    });

    it("should find blue cards with color:u", () => {
      const result = searchLocalCards("color:u", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.colors.includes("U"))).toBe(true);
    });

    it("should find green cards with c:g", () => {
      const result = searchLocalCards("c:g", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.colors.includes("G"))).toBe(true);
    });

    it("should find black cards with c:b", () => {
      const result = searchLocalCards("c:b", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.colors.includes("B"))).toBe(true);
    });

    it("should find white cards with c:w", () => {
      // No white cards in our test set
      const result = searchLocalCards("c:w", testCards);
      expect(result).toHaveLength(0);
    });

    it("should find colorless cards with c:c", () => {
      const result = searchLocalCards("c:c", testCards);
      expect(result).toHaveLength(2); // Sol Ring and Emrakul
      expect(result.every((c) => c.colors.length === 0)).toBe(true);
    });

    it("should find multicolor cards with multiple letters (AND logic)", () => {
      const result = searchLocalCards("c:bg", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Deathrite Shaman");
    });

    it("should find Grixis cards with c:ubr", () => {
      const result = searchLocalCards("c:ubr", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Nicol Bolas, the Ravager");
    });

    it("should be case-insensitive for color letters", () => {
      const result = searchLocalCards("c:R", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.colors.includes("R"))).toBe(true);
    });

    it("should not match cards missing required colors", () => {
      const result = searchLocalCards("c:wubrg", testCards);
      expect(result).toHaveLength(0);
    });
  });

  describe("mv operator (mana value)", () => {
    it("should find cards with exact mana value using mv=", () => {
      const result = searchLocalCards("mv=1", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue === 1)).toBe(true);
    });

    it("should find cards with mv less than value using mv<", () => {
      const result = searchLocalCards("mv<2", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue < 2)).toBe(true);
    });

    it("should find cards with mv greater than value using mv>", () => {
      const result = searchLocalCards("mv>10", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Emrakul, the Aeons Torn");
    });

    it("should find cards with mv less than or equal using mv<=", () => {
      const result = searchLocalCards("mv<=1", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue <= 1)).toBe(true);
    });

    it("should find cards with mv greater than or equal using mv>=", () => {
      const result = searchLocalCards("mv>=15", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Emrakul, the Aeons Torn");
    });

    it("should be case-insensitive for mv operator", () => {
      const result = searchLocalCards("MV=1", testCards);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should find cards with exact mana value using mv: shorthand", () => {
      const result = searchLocalCards("mv:1", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue === 1)).toBe(true);
    });

    it("should be case-insensitive for mv: shorthand", () => {
      const result = searchLocalCards("MV:2", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue === 2)).toBe(true);
    });
  });

  describe("cmc alias (backward compatibility)", () => {
    it("should find cards with exact mana value using cmc=", () => {
      const result = searchLocalCards("cmc=1", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue === 1)).toBe(true);
    });

    it("should support cmc with comparison operators", () => {
      const result = searchLocalCards("cmc<=1", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((c) => c.manaValue <= 1)).toBe(true);
    });

    it("should be case-insensitive for cmc alias", () => {
      const result = searchLocalCards("CMC=1", testCards);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("combined queries (AND logic)", () => {
    it("should combine type and color", () => {
      const result = searchLocalCards("t:creature c:r", testCards);
      expect(result.length).toBeGreaterThan(0);
      expect(
        result.every(
          (c) =>
            c.typeLine.toLowerCase().includes("creature") && c.colors.includes("R")
        )
      ).toBe(true);
    });

    it("should combine type and mv", () => {
      const result = searchLocalCards("t:instant mv=2", testCards);
      expect(result).toHaveLength(2); // Counterspell and Searing Blaze
    });

    it("should combine oracle and color", () => {
      const result = searchLocalCards("o:damage c:r", testCards);
      expect(result).toHaveLength(2); // Lightning Bolt and Searing Blaze
    });

    it("should combine multiple operators", () => {
      const result = searchLocalCards("t:instant c:r mv=1", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Lightning Bolt");
    });

    it("should combine name with operators", () => {
      const result = searchLocalCards("crow o:flying", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Storm Crow");
    });

    it("should return empty when combined conditions have no matches", () => {
      const result = searchLocalCards("t:instant c:g", testCards);
      expect(result).toHaveLength(0);
    });
  });

  describe("graceful degradation (invalid operators as name search)", () => {
    it("should treat unknown operator-like syntax as name search", () => {
      const result = searchLocalCards("xyz:value", testCards);
      expect(result).toHaveLength(0); // No card named "xyz:value"
    });

    it("should treat incomplete operator as name search", () => {
      const result = searchLocalCards("t:", testCards);
      expect(result).toHaveLength(0); // No card with "t:" in name
    });
  });

  describe("edge cases", () => {
    it("should handle empty cards array", () => {
      const result = searchLocalCards("t:creature", []);
      expect(result).toHaveLength(0);
    });

    it("should handle cards with empty oracle text", () => {
      const vanillaCreature = createCard({
        name: "Vanilla Creature",
        oracleText: "",
      });
      const result = searchLocalCards("o:ability", [vanillaCreature]);
      expect(result).toHaveLength(0);
    });

    it("should handle multiple spaces between terms", () => {
      const result = searchLocalCards("t:creature    c:r", testCards);
      expect(result.length).toBeGreaterThan(0);
    });

    it("should handle mv=0", () => {
      const zeroManaCard = createCard({
        name: "Zero Mana Card",
        manaValue: 0,
      });
      const result = searchLocalCards("mv=0", [zeroManaCard]);
      expect(result).toHaveLength(1);
    });

    it("should handle search for specific mana values", () => {
      const result = searchLocalCards("mv=15", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Emrakul, the Aeons Torn");
    });
  });

  describe("real-world query examples", () => {
    it("should find cheap red burn spells", () => {
      const result = searchLocalCards("c:r mv<=2 o:damage", testCards);
      expect(result).toHaveLength(2); // Lightning Bolt and Searing Blaze
    });

    it("should find blue flying creatures", () => {
      const result = searchLocalCards("t:creature c:u o:flying", testCards);
      expect(result).toHaveLength(2); // Storm Crow and Nicol Bolas (both blue creatures with flying)
      expect(result.map((c) => c.name).sort()).toEqual([
        "Nicol Bolas, the Ravager",
        "Storm Crow",
      ]);
    });

    it("should find colorless creatures", () => {
      const result = searchLocalCards("t:creature c:c", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Emrakul, the Aeons Torn");
    });

    it("should find legendary creatures", () => {
      const result = searchLocalCards("t:legendary t:creature", testCards);
      expect(result).toHaveLength(2); // Nicol Bolas and Emrakul
    });

    it("should find Eldrazi", () => {
      const result = searchLocalCards("t:eldrazi", testCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Emrakul, the Aeons Torn");
    });
  });

  describe("quoted strings", () => {
    const drawCard = createCard({
      name: "Ancestral Recall",
      typeLine: "Instant",
      colors: ["U"],
      oracleText: "Target player draws three cards.",
    });

    const cantrip = createCard({
      name: "Opt",
      typeLine: "Instant",
      colors: ["U"],
      oracleText: "Scry 1. Draw a card.",
    });

    const etbCreature = createCard({
      name: "Snapcaster Mage",
      typeLine: "Creature - Human Wizard",
      colors: ["U"],
      oracleText:
        "Flash\nWhen Snapcaster Mage enters the battlefield, target instant or sorcery card in your graveyard gains flashback until end of turn.",
    });

    const quotedTestCards = [drawCard, cantrip, etbCreature];

    it('should match quoted oracle text with o:"phrase"', () => {
      const result = searchLocalCards('o:"draw a card"', quotedTestCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Opt");
    });

    it("should match quoted oracle text with o:'phrase' (single quotes)", () => {
      const result = searchLocalCards("o:'draws three'", quotedTestCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Ancestral Recall");
    });

    it('should match quoted phrase with "enters the battlefield"', () => {
      const result = searchLocalCards(
        'o:"enters the battlefield"',
        quotedTestCards
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Snapcaster Mage");
    });

    it("should combine quoted oracle with other operators", () => {
      const result = searchLocalCards(
        't:instant o:"draw"',
        quotedTestCards
      );
      expect(result).toHaveLength(2);
      expect(result.map((c) => c.name).sort()).toEqual([
        "Ancestral Recall",
        "Opt",
      ]);
    });

    it('should match quoted type with t:"human wizard"', () => {
      const result = searchLocalCards('t:"human wizard"', quotedTestCards);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Snapcaster Mage");
    });

    it("should handle mixed quoted and unquoted terms", () => {
      const result = searchLocalCards('c:u o:"draw"', quotedTestCards);
      expect(result).toHaveLength(2);
    });
  });

  // ─── Advanced features (negation, OR, parentheses, exact name, identity, mana cost, color comparisons) ───

  describe("advanced features", () => {
    const bolt = createCard({
      name: "Lightning Bolt",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    });

    const counter = createCard({
      name: "Counterspell",
      manaCost: "{U}{U}",
      manaValue: 2,
      typeLine: "Instant",
      colors: ["U"],
      colorIdentity: ["U"],
      oracleText: "Counter target spell.",
    });

    const goyf = createCard({
      name: "Tarmogoyf",
      manaCost: "{1}{G}",
      manaValue: 2,
      typeLine: "Creature — Lhurgoyf",
      colors: ["G"],
      colorIdentity: ["G"],
      oracleText:
        "Tarmogoyf's power is equal to the number of card types among cards in all graveyards and its toughness is equal to that number plus 1.",
    });

    const nicol = createCard({
      name: "Nicol Bolas, Planeswalker",
      manaCost: "{4}{U}{B}{B}{R}",
      manaValue: 8,
      typeLine: "Legendary Planeswalker — Bolas",
      colors: ["U", "B", "R"],
      colorIdentity: ["U", "B", "R"],
      oracleText:
        "+3: Destroy target noncreature permanent.\n-2: Gain control of target creature.",
    });

    const sol = createCard({
      name: "Sol Ring",
      manaCost: "{1}",
      manaValue: 1,
      typeLine: "Artifact",
      colors: [],
      colorIdentity: [],
      oracleText: "{T}: Add {C}{C}.",
    });

    const azorius = createCard({
      name: "Azorius Signet",
      manaCost: "{2}",
      manaValue: 2,
      typeLine: "Artifact",
      colors: [],
      colorIdentity: ["W", "U"],
      oracleText: "{1}, {T}: Add {W}{U}.",
    });

    const fire = createCard({
      name: "Fire",
      manaCost: "{1}{R}",
      manaValue: 2,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText:
        "Fire deals 2 damage divided as you choose among one or two targets.",
    });

    const advCards = [bolt, counter, goyf, nicol, sol, azorius, fire];

    function names(cards: ScryCard[]): string[] {
      return cards.map((c) => c.name).sort();
    }

    describe("negation", () => {
      it("negates a type term", () => {
        expect(names(searchLocalCards("-t:instant", advCards))).toEqual([
          "Azorius Signet",
          "Nicol Bolas, Planeswalker",
          "Sol Ring",
          "Tarmogoyf",
        ]);
      });

      it("negates a color term", () => {
        expect(names(searchLocalCards("-c:r", advCards))).toEqual([
          "Azorius Signet",
          "Counterspell",
          "Sol Ring",
          "Tarmogoyf",
        ]);
      });

      it("combines negation with positive terms", () => {
        expect(names(searchLocalCards("t:instant -c:r", advCards))).toEqual([
          "Counterspell",
        ]);
      });

      it("negates mana value", () => {
        expect(names(searchLocalCards("-mv=2", advCards))).toEqual([
          "Lightning Bolt",
          "Nicol Bolas, Planeswalker",
          "Sol Ring",
        ]);
      });
    });

    describe("OR logic", () => {
      it("basic OR between two terms", () => {
        expect(
          names(searchLocalCards("t:creature or t:artifact", advCards)),
        ).toEqual(["Azorius Signet", "Sol Ring", "Tarmogoyf"]);
      });

      it("OR with three terms", () => {
        expect(
          names(
            searchLocalCards("bolt or counterspell or tarmogoyf", advCards),
          ),
        ).toEqual(["Counterspell", "Lightning Bolt", "Tarmogoyf"]);
      });
    });

    describe("parentheses grouping", () => {
      it("groups OR with AND", () => {
        expect(
          names(searchLocalCards("(t:instant or t:sorcery) c:r", advCards)),
        ).toEqual(["Fire", "Lightning Bolt"]);
      });

      it("nested groups", () => {
        expect(
          names(
            searchLocalCards(
              "(t:instant or t:creature) (c:r or c:g)",
              advCards,
            ),
          ),
        ).toEqual(["Fire", "Lightning Bolt", "Tarmogoyf"]);
      });

      it("negated group with De Morgan's", () => {
        expect(
          names(searchLocalCards("-(t:instant or t:creature)", advCards)),
        ).toEqual([
          "Azorius Signet",
          "Nicol Bolas, Planeswalker",
          "Sol Ring",
        ]);
      });
    });

    describe("exact name (!)", () => {
      it("matches exact name", () => {
        expect(names(searchLocalCards("!Fire", advCards))).toEqual(["Fire"]);
      });

      it("does not match partial name", () => {
        expect(searchLocalCards("!Lightning", advCards)).toEqual([]);
      });

      it("is case-insensitive", () => {
        expect(names(searchLocalCards("!fire", advCards))).toEqual(["Fire"]);
      });

      it("works with quoted exact name", () => {
        expect(
          names(searchLocalCards('!"Lightning Bolt"', advCards)),
        ).toEqual(["Lightning Bolt"]);
      });
    });

    describe("color identity (id:)", () => {
      it("matches color identity", () => {
        expect(names(searchLocalCards("id:wu", advCards))).toEqual([
          "Azorius Signet",
        ]);
      });

      it("matches identity superset", () => {
        expect(names(searchLocalCards("id:ub", advCards))).toEqual([
          "Nicol Bolas, Planeswalker",
        ]);
      });

      it("matches exact identity", () => {
        expect(names(searchLocalCards("id=wu", advCards))).toEqual([
          "Azorius Signet",
        ]);
      });
    });

    describe("mana cost (m:)", () => {
      it("matches mana symbol shorthand", () => {
        expect(names(searchLocalCards("m:uu", advCards))).toEqual([
          "Counterspell",
        ]);
      });

      it("matches with brace notation", () => {
        expect(names(searchLocalCards("m:{U}{U}", advCards))).toEqual([
          "Counterspell",
        ]);
      });

      it("matches single symbol", () => {
        expect(names(searchLocalCards("m:r", advCards))).toEqual([
          "Fire",
          "Lightning Bolt",
          "Nicol Bolas, Planeswalker",
        ]);
      });
    });

    describe("color comparisons", () => {
      it("c:m finds multicolor cards", () => {
        expect(names(searchLocalCards("c:m", advCards))).toEqual([
          "Nicol Bolas, Planeswalker",
        ]);
      });

      it("c=r finds exactly mono-red", () => {
        expect(names(searchLocalCards("c=r", advCards))).toEqual([
          "Fire",
          "Lightning Bolt",
        ]);
      });

      it("c>=ub finds cards with at least U and B", () => {
        expect(names(searchLocalCards("c>=ub", advCards))).toEqual([
          "Nicol Bolas, Planeswalker",
        ]);
      });

      it("c<=r finds cards that are subset of red (colorless or mono-red)", () => {
        expect(names(searchLocalCards("c<=r", advCards))).toEqual([
          "Azorius Signet",
          "Fire",
          "Lightning Bolt",
          "Sol Ring",
        ]);
      });
    });

    describe("mv!= (not equal)", () => {
      it("excludes specific mana value", () => {
        expect(names(searchLocalCards("mv!=2", advCards))).toEqual([
          "Lightning Bolt",
          "Nicol Bolas, Planeswalker",
          "Sol Ring",
        ]);
      });
    });

    describe("robustness edge cases", () => {
      it("unmatched closing paren recovers and returns matching cards", () => {
        // Malformed input: trailing ')' — parser recovers and treats 't:instant' normally
        const result = searchLocalCards("t:instant)", advCards);
        expect(() => result).not.toThrow();
        const resultNames = result.map((c) => c.name).sort();
        expect(resultNames).toContain("Lightning Bolt");
        expect(resultNames).toContain("Counterspell");
        expect(resultNames).toContain("Fire");
      });

      it("unmatched opening paren recovers and returns matching cards", () => {
        // Malformed input: leading '(' — parser recovers and treats 't:instant' normally
        const result = searchLocalCards("(t:instant", advCards);
        expect(() => result).not.toThrow();
        const resultNames = result.map((c) => c.name).sort();
        expect(resultNames).toContain("Lightning Bolt");
        expect(resultNames).toContain("Counterspell");
        expect(resultNames).toContain("Fire");
      });

      it("empty parens returns all cards (no filtering applied)", () => {
        const result = searchLocalCards("()", advCards);
        expect(() => result).not.toThrow();
        // Empty parens contribute no filter term — all cards pass
        expect(result.length).toBe(advCards.length);
      });

      it("dangling 'or' at start returns all cards (empty left operand matches everything)", () => {
        // 'or t:instant' — the empty left side of OR matches all cards, making the union = all cards
        const result = searchLocalCards("or t:instant", advCards);
        expect(() => result).not.toThrow();
        expect(result.length).toBe(advCards.length);
      });

      it("dangling 'or' at end returns all cards (empty right operand matches everything)", () => {
        // 't:instant or' — the empty right side of OR matches all cards, making the union = all cards
        const result = searchLocalCards("t:instant or", advCards);
        expect(() => result).not.toThrow();
        expect(result.length).toBe(advCards.length);
      });
    });

    describe("strict color comparisons (c< and c>)", () => {
      it("c>r finds cards strictly containing red (red + at least one other color)", () => {
        // c>r = strict superset of red = card has R AND at least one non-R color
        const result = names(searchLocalCards("c>r", advCards));
        // Nicol Bolas has U, B, R — strict superset of {R} ✓
        expect(result).toContain("Nicol Bolas, Planeswalker");
        // Mono-red cards are NOT strict supersets (they equal {R})
        expect(result).not.toContain("Lightning Bolt");
        expect(result).not.toContain("Fire");
        // Colorless/non-red not included
        expect(result).not.toContain("Sol Ring");
      });

      it("c<ub finds cards strictly contained within UB (subset but not equal to UB)", () => {
        // c<ub = strict subset of {U,B} = has only U and/or B colors but NOT both (not equal {U,B})
        // Counterspell is {U} ⊂ {U,B} ✓ (not equal)
        const result = names(searchLocalCards("c<ub", advCards));
        expect(result).toContain("Counterspell");
        // Sol Ring (colorless {}) is subset but strict subset of {U,B} — included
        expect(result).toContain("Sol Ring");
        // Nicol Bolas has R too — not a subset of {U,B}
        expect(result).not.toContain("Nicol Bolas, Planeswalker");
        // Mono-red not subset of {U,B}
        expect(result).not.toContain("Lightning Bolt");
      });
    });
  });
});
