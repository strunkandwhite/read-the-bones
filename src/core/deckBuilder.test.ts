import { describe, it, expect } from "vitest";
import type { DeckState, ScryCard } from "./types";
import {
  BASE_COLUMN_KEYS,
  DECK_COLUMN_KEYS,
  DECK_STATE_VERSION,
  MANA_VALUE_COLUMN_KEYS,
  NONCREATURE_COLUMN_KEYS,
  assignCardsToColumns,
  columnKeysForZone,
  createEmptyColumnMap,
  createEmptyDeckState,
  deckReducer,
  formatDecklistText,
  generateDeckId,
  getColumnKey,
  getDeckColumnKey,
  isCreatureCard,
  migrateDeckState,
  toBaseColumnKey,
  toNoncreatureColumnKey,
} from "./deckBuilder";

function makeScryCard(overrides: Partial<ScryCard>): ScryCard {
  return {
    name: "Test Card",
    imageUri: "",
    manaCost: "",
    manaValue: 0,
    typeLine: "",
    colors: [],
    colorIdentity: [],
    oracleText: "",
    ...overrides,
  } as ScryCard;
}

const bolt = makeScryCard({ name: "Lightning Bolt", manaValue: 1, typeLine: "Instant" });
const counterspell = makeScryCard({ name: "Counterspell", manaValue: 2, typeLine: "Instant" });
const vendilion = makeScryCard({
  name: "Vendilion Clique",
  manaValue: 3,
  typeLine: "Creature - Faerie Wizard",
});
const jace = makeScryCard({
  name: "Jace, the Mind Sculptor",
  manaValue: 4,
  typeLine: "Planeswalker - Jace",
});
const forceOfWill = makeScryCard({ name: "Force of Will", manaValue: 5, typeLine: "Instant" });
const emrakul = makeScryCard({
  name: "Emrakul, the Aeons Torn",
  manaValue: 15,
  typeLine: "Creature - Eldrazi",
});
const moxRuby = makeScryCard({ name: "Mox Ruby", manaValue: 0, typeLine: "Artifact" });
const tundra = makeScryCard({ name: "Tundra", manaValue: 0, typeLine: "Land" });
const dryad = makeScryCard({
  name: "Dryad Arbor",
  manaValue: 0,
  typeLine: "Land Creature - Dryad",
});
const sixDrop = makeScryCard({
  name: "Primeval Titan",
  manaValue: 6,
  typeLine: "Creature - Giant",
});
const tenDrop = makeScryCard({ name: "Ulamog", manaValue: 10, typeLine: "Creature - Eldrazi" });
const snapcaster = makeScryCard({
  name: "Snapcaster Mage",
  manaValue: 2,
  typeLine: "Creature - Human Wizard",
});
const wurmcoil = makeScryCard({
  name: "Wurmcoil Engine",
  manaValue: 4,
  typeLine: "Artifact Creature - Wurm",
});

const scryfallData = new Map<string, ScryCard>([
  ["Lightning Bolt", bolt],
  ["Counterspell", counterspell],
  ["Vendilion Clique", vendilion],
  ["Jace, the Mind Sculptor", jace],
  ["Force of Will", forceOfWill],
  ["Emrakul, the Aeons Torn", emrakul],
  ["Mox Ruby", moxRuby],
  ["Tundra", tundra],
  ["Dryad Arbor", dryad],
  ["Primeval Titan", sixDrop],
  ["Ulamog", tenDrop],
  ["Snapcaster Mage", snapcaster],
  ["Wurmcoil Engine", wurmcoil],
]);

describe("getColumnKey", () => {
  it("assigns MV 0 to mv-0-1", () => {
    expect(getColumnKey(moxRuby)).toBe("mv-0-1");
  });

  it("assigns MV 1 to mv-0-1", () => {
    expect(getColumnKey(bolt)).toBe("mv-0-1");
  });

  it("assigns MV 2 to mv-2", () => {
    expect(getColumnKey(counterspell)).toBe("mv-2");
  });

  it("assigns MV 3 to mv-3", () => {
    expect(getColumnKey(vendilion)).toBe("mv-3");
  });

  it("assigns MV 4 to mv-4", () => {
    expect(getColumnKey(jace)).toBe("mv-4");
  });

  it("assigns MV 5 to mv-5", () => {
    expect(getColumnKey(forceOfWill)).toBe("mv-5");
  });

  it("assigns MV 6 to mv-6+", () => {
    expect(getColumnKey(sixDrop)).toBe("mv-6+");
  });

  it("assigns MV 10 to mv-6+", () => {
    expect(getColumnKey(tenDrop)).toBe("mv-6+");
  });

  it("assigns lands to lands regardless of MV", () => {
    expect(getColumnKey(tundra)).toBe("lands");
  });

  it("assigns land creatures to lands", () => {
    expect(getColumnKey(dryad)).toBe("lands");
  });
});

describe("BASE_COLUMN_KEYS", () => {
  it("has exactly 7 columns", () => {
    expect(BASE_COLUMN_KEYS).toHaveLength(7);
  });

  it("is in the expected order", () => {
    expect(BASE_COLUMN_KEYS).toEqual(["mv-0-1", "mv-2", "mv-3", "mv-4", "mv-5", "mv-6+", "lands"]);
  });
});

describe("MANA_VALUE_COLUMN_KEYS", () => {
  it("is the base keys without lands", () => {
    expect(MANA_VALUE_COLUMN_KEYS).toEqual(["mv-0-1", "mv-2", "mv-3", "mv-4", "mv-5", "mv-6+"]);
  });
});

describe("NONCREATURE_COLUMN_KEYS", () => {
  it("mirrors the mana-value keys with an nc- prefix, and has no lands column", () => {
    expect(NONCREATURE_COLUMN_KEYS).toEqual([
      "nc-mv-0-1",
      "nc-mv-2",
      "nc-mv-3",
      "nc-mv-4",
      "nc-mv-5",
      "nc-mv-6+",
    ]);
  });

  it("contains no colons, which would break drag id parsing", () => {
    for (const key of NONCREATURE_COLUMN_KEYS) {
      expect(key).not.toContain(":");
    }
  });
});

describe("DECK_COLUMN_KEYS", () => {
  it("is both rows' mana-value keys followed by the shared lands column", () => {
    expect(DECK_COLUMN_KEYS).toEqual([
      ...MANA_VALUE_COLUMN_KEYS,
      ...NONCREATURE_COLUMN_KEYS,
      "lands",
    ]);
  });

  it("has 13 columns", () => {
    expect(DECK_COLUMN_KEYS).toHaveLength(13);
  });
});

describe("columnKeysForZone", () => {
  it("gives the deck zone all 13 keys", () => {
    expect(columnKeysForZone("deck")).toEqual(DECK_COLUMN_KEYS);
  });

  it("gives the sideboard the 7 base keys only", () => {
    expect(columnKeysForZone("sideboard")).toEqual(BASE_COLUMN_KEYS);
  });
});

describe("toNoncreatureColumnKey", () => {
  it("prefixes a base key", () => {
    expect(toNoncreatureColumnKey("mv-2")).toBe("nc-mv-2");
  });
});

describe("toBaseColumnKey", () => {
  it("strips the nc- prefix", () => {
    expect(toBaseColumnKey("nc-lands")).toBe("lands");
  });

  it("returns a base key unchanged", () => {
    expect(toBaseColumnKey("mv-6+")).toBe("mv-6+");
  });

  it("returns null for a key that is not a column", () => {
    expect(toBaseColumnKey("creatures")).toBeNull();
    expect(toBaseColumnKey("nc-creatures")).toBeNull();
  });
});

describe("isCreatureCard", () => {
  it("recognizes a creature type line", () => {
    expect(isCreatureCard(vendilion)).toBe(true);
  });

  it("rejects a non-creature type line", () => {
    expect(isCreatureCard(bolt)).toBe(false);
  });
});

describe("getDeckColumnKey", () => {
  it("puts creatures in the base row", () => {
    expect(getDeckColumnKey(snapcaster)).toBe("mv-2");
  });

  it("puts non-creatures in the nc row", () => {
    expect(getDeckColumnKey(bolt)).toBe("nc-mv-0-1");
  });

  it("puts lands in the shared lands column", () => {
    expect(getDeckColumnKey(tundra)).toBe("lands");
  });

  it("puts creature-lands in the shared lands column too", () => {
    expect(getDeckColumnKey(dryad)).toBe("lands");
  });

  it("treats artifact creatures as creatures", () => {
    expect(getDeckColumnKey(wurmcoil)).toBe("mv-4");
  });
});

describe("createEmptyColumnMap", () => {
  it("gives the deck zone all 13 keys", () => {
    const map = createEmptyColumnMap("deck");
    expect(Object.keys(map)).toEqual([...DECK_COLUMN_KEYS]);
    for (const key of DECK_COLUMN_KEYS) {
      expect(map[key]).toEqual([]);
    }
  });

  it("gives the sideboard the 7 base keys only", () => {
    const map = createEmptyColumnMap("sideboard");
    expect(Object.keys(map)).toEqual([...BASE_COLUMN_KEYS]);
  });
});

describe("assignCardsToColumns", () => {
  it("distributes cards into correct columns", () => {
    const result = assignCardsToColumns(["Lightning Bolt", "Counterspell", "Tundra"], scryfallData);
    expect(result["mv-0-1"]).toEqual(["Lightning Bolt"]);
    expect(result["mv-2"]).toEqual(["Counterspell"]);
    expect(result["lands"]).toEqual(["Tundra"]);
  });

  it("falls back to mv-0-1 for unknown cards", () => {
    const result = assignCardsToColumns(["Unknown Card"], scryfallData);
    expect(result["mv-0-1"]).toEqual(["Unknown Card"]);
  });

  it("preserves order within a column", () => {
    const result = assignCardsToColumns(["Lightning Bolt", "Mox Ruby"], scryfallData);
    expect(result["mv-0-1"]).toEqual(["Lightning Bolt", "Mox Ruby"]);
  });
});

describe("createEmptyDeckState", () => {
  it("creates state with correct draftId and seat", () => {
    const state = createEmptyDeckState("tarkir", 3);
    expect(state.draftId).toBe("tarkir");
    expect(state.seat).toBe(3);
  });

  it("builds a 13-key deck zone and a 7-key sideboard", () => {
    const state = createEmptyDeckState("tarkir", 1);
    expect(Object.keys(state.zones.deck)).toHaveLength(13);
    expect(Object.keys(state.zones.sideboard)).toHaveLength(7);
    for (const key of DECK_COLUMN_KEYS) {
      expect(state.zones.deck[key]).toEqual([]);
    }
    for (const key of BASE_COLUMN_KEYS) {
      expect(state.zones.sideboard[key]).toEqual([]);
    }
  });

  it("stamps the current DECK_STATE_VERSION", () => {
    expect(createEmptyDeckState("tarkir", 1).version).toBe(DECK_STATE_VERSION);
  });

  it("has zero basic lands", () => {
    const state = createEmptyDeckState("tarkir", 1);
    expect(state.basicLands).toEqual({
      Plains: 0,
      Island: 0,
      Swamp: 0,
      Mountain: 0,
      Forest: 0,
    });
  });
});

describe("generateDeckId", () => {
  it("returns a 16-character string", () => {
    const id = generateDeckId();
    expect(id).toHaveLength(16);
  });

  it("contains only lowercase hex characters", () => {
    const id = generateDeckId();
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("deckReducer", () => {
  describe("MIGRATE_ROWS", () => {
    /** A deck state as it arrives from a persisted pre-split blob: structurally
     *  normalized to the canonical deck-zone columns, but with every card still
     *  in the creature row and no version stamp. */
    function preSplitState(
      deck: Record<string, string[]> = {},
      sideboard: Record<string, string[]> = {}
    ): DeckState {
      return migrateDeckState({
        draftId: "tarkir",
        seat: 1,
        zones: {
          deck: { ...deck },
          sideboard: { ...sideboard },
        },
        basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      });
    }

    it("moves known non-creatures from mana-value columns to the matching nc- column", () => {
      const state = preSplitState({
        "mv-0-1": ["Lightning Bolt"],
        "mv-2": ["Counterspell"],
      });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["nc-mv-0-1"]).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["nc-mv-2"]).toEqual(["Counterspell"]);
      expect(result.zones.deck["mv-0-1"]).toEqual([]);
      expect(result.zones.deck["mv-2"]).toEqual([]);
    });

    it("leaves the lands column alone", () => {
      const state = preSplitState({ lands: ["Tundra", "Plains", "Dryad Arbor"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["lands"]).toEqual(["Tundra", "Plains", "Dryad Arbor"]);
      expect(result.version).toBe(DECK_STATE_VERSION);
    });

    it("preserves relative order within a column", () => {
      const state = preSplitState({ "mv-0-1": ["Mox Ruby", "Lightning Bolt"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["nc-mv-0-1"]).toEqual(["Mox Ruby", "Lightning Bolt"]);
    });

    it("appends moved cards after whatever the nc- column already holds", () => {
      const state = preSplitState({
        "mv-2": ["Counterspell"],
        "nc-mv-2": ["Force Spike"],
      });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["nc-mv-2"]).toEqual(["Force Spike", "Counterspell"]);
    });

    it("leaves creatures in the creature row", () => {
      const state = preSplitState({
        "mv-3": ["Vendilion Clique"],
        "mv-4": ["Wurmcoil Engine"],
      });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["mv-3"]).toEqual(["Vendilion Clique"]);
      expect(result.zones.deck["mv-4"]).toEqual(["Wurmcoil Engine"]);
      for (const key of NONCREATURE_COLUMN_KEYS) {
        expect(result.zones.deck[key]).toEqual([]);
      }
    });

    it("moves a basic land out of a mana-value column despite having no Scryfall entry", () => {
      expect(scryfallData.has("Plains")).toBe(false);
      const state = preSplitState({ "mv-0-1": ["Plains"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["nc-mv-0-1"]).toEqual(["Plains"]);
      expect(result.zones.deck["mv-0-1"]).toEqual([]);
    });

    it("leaves cards with no Scryfall data in place", () => {
      const state = preSplitState({ "mv-0-1": ["Unknown Card"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.zones.deck["mv-0-1"]).toEqual(["Unknown Card"]);
      expect(result.zones.deck["nc-mv-0-1"]).toEqual([]);
    });

    it("does not touch the sideboard", () => {
      const state = preSplitState({}, { "mv-0-1": ["Lightning Bolt"], lands: ["Tundra"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(Object.keys(result.zones.sideboard)).toEqual([...BASE_COLUMN_KEYS]);
      expect(result.zones.sideboard["mv-0-1"]).toEqual(["Lightning Bolt"]);
      expect(result.zones.sideboard["lands"]).toEqual(["Tundra"]);
    });

    it("sets version to DECK_STATE_VERSION", () => {
      const state = preSplitState({ "mv-0-1": ["Lightning Bolt"] });
      expect(state.version).toBeUndefined();

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result.version).toBe(DECK_STATE_VERSION);
    });

    it("stamps the version even when no card needs moving", () => {
      const state = preSplitState({ "mv-3": ["Vendilion Clique"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result).not.toBe(state);
      expect(result.version).toBe(DECK_STATE_VERSION);
    });

    it("returns the same reference when version is already current", () => {
      const state = {
        ...preSplitState({ "mv-0-1": ["Lightning Bolt"] }),
        version: DECK_STATE_VERSION,
      };

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData });

      expect(result).toBe(state);
      expect(result.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
    });

    it("returns the same reference when the Scryfall map is empty", () => {
      const state = preSplitState({ "mv-0-1": ["Lightning Bolt"] });

      const result = deckReducer(state, { type: "MIGRATE_ROWS", scryfallData: new Map() });

      expect(result).toBe(state);
      expect(result.version).toBeUndefined();
    });
  });

  describe("REBUILD", () => {
    it("places all canonical cards into deck columns with sideboard empty", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell", "Tundra"],
        scryfallData,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["nc-mv-2"]).toEqual(["Counterspell"]);
      expect(result.zones.deck["lands"]).toEqual(["Tundra"]);
      // Sideboard should be empty
      for (const key of BASE_COLUMN_KEYS) {
        expect(result.zones.sideboard[key]).toEqual([]);
      }
    });

    it("adds missing cards to deck", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["nc-mv-2"]).toContain("Counterspell");
    });

    it("adds a new creature to its creature-row column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Snapcaster Mage", "Dryad Arbor"],
        scryfallData,
      });
      expect(result.zones.deck["mv-2"]).toEqual(["Snapcaster Mage"]);
      expect(result.zones.deck["lands"]).toEqual(["Dryad Arbor"]);
      expect(result.zones.deck["nc-mv-2"]).toEqual([]);
    });

    it("leaves a non-creature the user moved to the creature row where it is", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Counterspell"],
        scryfallData,
      });
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Counterspell",
        fromZone: "deck",
        toZone: "deck",
        fromColumn: "nc-mv-2",
        toColumn: "mv-2",
        toIndex: 0,
      });
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Counterspell"],
        scryfallData,
      });
      expect(result).toBe(state);
      expect(result.zones.deck["mv-2"]).toEqual(["Counterspell"]);
      expect(result.zones.deck["nc-mv-2"]).toEqual([]);
    });

    it("returns same state reference when nothing changes", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result).toBe(state);
    });

    it("removes cards no longer in canonical list", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["nc-mv-2"]).toEqual([]);
    });

    it("preserves card arrangement when user moved cards to sideboard", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      // Move Counterspell to sideboard
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Counterspell",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "nc-mv-2",
        toColumn: "mv-2",
        toIndex: 0,
      });
      // Rebuild with same cards — should preserve arrangement
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      expect(result.zones.sideboard["mv-2"]).toContain("Counterspell");
      expect(result.zones.deck["nc-mv-0-1"]).toContain("Lightning Bolt");
    });

    it("places two copies of the same card when canonicalCards has it twice", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      const boltsInDeck = result.zones.deck["nc-mv-0-1"].filter(
        (c: string) => c === "Lightning Bolt"
      );
      expect(boltsInDeck).toHaveLength(2);
      // Sideboard stays empty
      expect(result.zones.sideboard["mv-0-1"]).toEqual([]);
    });

    it("two copies picked — one in maindeck, one in sideboard — rebuild preserves placement", () => {
      // Start with both copies in deck via first REBUILD
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      // Move one copy to sideboard
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "nc-mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      // Now: 1 in deck, 1 in sideboard
      expect(
        state.zones.deck["nc-mv-0-1"].filter((c: string) => c === "Lightning Bolt")
      ).toHaveLength(1);
      expect(
        state.zones.sideboard["mv-0-1"].filter((c: string) => c === "Lightning Bolt")
      ).toHaveLength(1);

      // REBUILD with same 2 copies — must preserve arrangement
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      expect(
        result.zones.deck["nc-mv-0-1"].filter((c: string) => c === "Lightning Bolt")
      ).toHaveLength(1);
      expect(
        result.zones.sideboard["mv-0-1"].filter((c: string) => c === "Lightning Bolt")
      ).toHaveLength(1);
    });

    it("copy removed upstream — rebuild drops the right one (excess removed, remaining kept)", () => {
      // Start with 2 copies
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      // Move one to sideboard
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "nc-mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      // Now rebuild with only 1 copy canonical — one copy should be dropped
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      const totalBolts =
        result.zones.deck["nc-mv-0-1"].filter((c: string) => c === "Lightning Bolt").length +
        result.zones.sideboard["mv-0-1"].filter((c: string) => c === "Lightning Bolt").length;
      expect(totalBolts).toBe(1);
    });

    it("does not create duplicates when rebuilding with same multi-copy canonical list twice", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      // Second REBUILD with same list should return same state reference (no change)
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Lightning Bolt"],
        scryfallData,
      });
      expect(result).toBe(state);
    });

    it("preserves basic lands during rebuild", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 2, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result.zones.deck["lands"]).toEqual(["Plains", "Plains"]);
      expect(result.zones.deck["nc-mv-0-1"]).toContain("Lightning Bolt");
    });
  });

  describe("MOVE_CARD", () => {
    it("moves a card between zones", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "nc-mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toEqual([]);
      expect(result.zones.sideboard["mv-0-1"]).toEqual(["Lightning Bolt"]);
    });

    it("moves a card between columns within the same zone", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "deck",
        fromColumn: "nc-mv-0-1",
        toColumn: "nc-mv-2",
        toIndex: 0,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toEqual([]);
      expect(result.zones.deck["nc-mv-2"]).toEqual(["Lightning Bolt"]);
    });

    it("returns original state if card not found", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Nonexistent",
        fromZone: "sideboard",
        toZone: "deck",
        fromColumn: "mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      expect(result).toBe(state);
    });

    it("decrements basicLands when moving a basic land deck → sideboard", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 0, Island: 0, Swamp: 0, Mountain: 3, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Mountain",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      expect(result.basicLands.Mountain).toBe(2);
      expect(result.zones.deck["lands"].filter((c: string) => c === "Mountain")).toHaveLength(2);
      expect(result.zones.sideboard["lands"]).toEqual(["Mountain"]);
    });

    it("increments basicLands when moving a basic land sideboard → deck", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 0, Island: 0, Swamp: 0, Mountain: 3, Forest: 0 },
        scryfallData,
      });
      // Move one to sideboard
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Mountain",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      // Move it back
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Mountain",
        fromZone: "sideboard",
        toZone: "deck",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      expect(result.basicLands.Mountain).toBe(3);
      expect(result.zones.sideboard["lands"]).toEqual([]);
      expect(result.zones.deck["lands"].filter((c: string) => c === "Mountain")).toHaveLength(3);
    });

    it("zeroes basicLands count when moving all basics to sideboard", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 0, Island: 1, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Island",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      expect(result.basicLands.Island).toBe(0);
    });

    it("floors basicLands count at zero", () => {
      // Manually create inconsistent state: count is 0 but instance exists
      const state = createEmptyDeckState("tarkir", 1);
      state.zones.deck["lands"] = ["Forest"];
      state.basicLands.Forest = 0;
      const result = deckReducer(structuredClone(state), {
        type: "MOVE_CARD",
        cardName: "Forest",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      expect(result.basicLands.Forest).toBe(0);
    });

    it("does not affect basicLands when moving non-basic lands", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Tundra"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Tundra",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "lands",
        toColumn: "lands",
        toIndex: 0,
      });
      expect(result.basicLands).toEqual({
        Plains: 0,
        Island: 0,
        Swamp: 0,
        Mountain: 0,
        Forest: 0,
      });
    });

    it("does not affect basicLands on same-zone column moves", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 0, Island: 0, Swamp: 0, Mountain: 2, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Mountain",
        fromZone: "deck",
        toZone: "deck",
        fromColumn: "lands",
        toColumn: "nc-mv-0-1",
        toIndex: 0,
      });
      expect(result.basicLands.Mountain).toBe(2);
    });
  });

  describe("SET_BASICS", () => {
    it("updates basic land counts", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 3, Island: 4, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      expect(result.basicLands.Plains).toBe(3);
      expect(result.basicLands.Island).toBe(4);
    });

    it("adds basics to the lands column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 2, Island: 1, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      expect(result.zones.deck["lands"]).toEqual(["Plains", "Plains", "Island"]);
    });

    it("clears pre-existing basics from the lands column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      state.zones.deck["lands"] = ["Forest", "Dryad Arbor", "Forest", "Tundra"];
      state.basicLands.Forest = 2;

      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });

      expect(result.zones.deck["lands"]).toEqual(["Dryad Arbor", "Tundra", "Plains"]);
      expect(result.basicLands.Forest).toBe(0);
    });

    it("replaces previous basics on re-set", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 5, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 0, Island: 0, Swamp: 0, Mountain: 3, Forest: 0 },
        scryfallData,
      });
      expect(result.zones.deck["lands"]).toEqual(["Mountain", "Mountain", "Mountain"]);
      expect(result.basicLands.Plains).toBe(0);
      expect(result.basicLands.Mountain).toBe(3);
    });

    it("preserves non-basic lands in the column", () => {
      let state = createEmptyDeckState("tarkir", 1);
      // Put a non-basic land in the deck (REBUILD places cards in deck)
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Tundra"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      expect(result.zones.deck["lands"]).toContain("Tundra");
      expect(result.zones.deck["lands"]).toContain("Plains");
    });
  });

  describe("CLEAR_DECK", () => {
    it("moves deck cards to sideboard", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "CLEAR_DECK",
        scryfallData,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toEqual([]);
      expect(result.zones.sideboard["mv-0-1"]).toContain("Lightning Bolt");
    });

    it("moves nc- column cards to the sideboard's base column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      state.zones.deck["nc-mv-2"] = ["Counterspell"];
      state.zones.deck["mv-2"] = ["Snapcaster Mage"];
      state.zones.deck["lands"] = ["Tundra"];

      const result = deckReducer(state, { type: "CLEAR_DECK", scryfallData });

      expect(result.zones.sideboard["mv-2"]).toEqual(["Snapcaster Mage", "Counterspell"]);
      expect(result.zones.sideboard["lands"]).toEqual(["Tundra"]);
      expect("nc-mv-2" in result.zones.sideboard).toBe(false);
      for (const key of NONCREATURE_COLUMN_KEYS) {
        expect(result.zones.deck[key]).toEqual([]);
      }
    });

    it("resets basic lands", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 3, Island: 4, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "CLEAR_DECK",
        scryfallData,
      });
      expect(result.basicLands).toEqual({
        Plains: 0,
        Island: 0,
        Swamp: 0,
        Mountain: 0,
        Forest: 0,
      });
      expect(result.zones.deck["lands"]).toEqual([]);
    });
  });

  describe("INIT_FROM_SNAPSHOT", () => {
    it("replaces entire state", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const snapshot: DeckState = {
        draftId: "innistrad",
        seat: 5,
        zones: {
          deck: {
            "mv-0-1": ["Lightning Bolt"],
            "mv-2": [],
            "mv-3": [],
            "mv-4": [],
            "mv-5": [],
            "mv-6+": [],
            lands: [],
          },
          sideboard: {
            "mv-0-1": [],
            "mv-2": ["Counterspell"],
            "mv-3": [],
            "mv-4": [],
            "mv-5": [],
            "mv-6+": [],
            lands: [],
          },
        },
        basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      };
      const result = deckReducer(state, {
        type: "INIT_FROM_SNAPSHOT",
        snapshot,
      });
      expect(result.draftId).toBe("innistrad");
      expect(result.seat).toBe(5);
      expect(result.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
      // Verify it's a clone, not the same reference
      expect(result).not.toBe(snapshot);
    });
  });

  describe("REORDER_CARD", () => {
    it("reorders a card within a column", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Mox Ruby"],
        scryfallData,
      });
      // Both end up in deck nc-mv-0-1
      expect(state.zones.deck["nc-mv-0-1"]).toEqual(["Lightning Bolt", "Mox Ruby"]);
      const result = deckReducer(state, {
        type: "REORDER_CARD",
        zone: "deck",
        column: "nc-mv-0-1",
        fromIndex: 0,
        toIndex: 1,
      });
      expect(result.zones.deck["nc-mv-0-1"]).toEqual(["Mox Ruby", "Lightning Bolt"]);
    });
  });

  describe("formatDecklistText", () => {
    it("formats a deck with single copies", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      const text = formatDecklistText(state);
      expect(text).toContain("Deck");
      expect(text).toContain("1 Lightning Bolt");
      expect(text).toContain("1 Counterspell");
    });

    it("aggregates multiple copies", () => {
      const state = createEmptyDeckState("tarkir", 1);
      state.zones.deck["mv-0-1"] = ["Lightning Bolt", "Lightning Bolt"];
      const text = formatDecklistText(state);
      expect(text).toContain("2 Lightning Bolt");
      expect(text).not.toContain("1 Lightning Bolt");
    });

    it("includes sideboard section", () => {
      const state = createEmptyDeckState("tarkir", 1);
      state.zones.deck["mv-0-1"] = ["Lightning Bolt"];
      state.zones.sideboard["mv-2"] = ["Counterspell"];
      const text = formatDecklistText(state);
      expect(text).toBe("Deck\n1 Lightning Bolt\n\nSideboard\n1 Counterspell");
    });

    it("returns empty string for empty deck and sideboard", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const text = formatDecklistText(state);
      expect(text).toBe("");
    });
  });
});

describe("migrateDeckState", () => {
  it("renames cmc-* keys to mv-*", () => {
    const legacy: DeckState = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: {
          "cmc-0-1": ["Lightning Bolt"],
          "cmc-2": ["Counterspell"],
          "cmc-3": [],
          "cmc-4": [],
          "cmc-5": [],
          "cmc-6+": [],
          lands: ["Tundra"],
        },
        sideboard: {
          "cmc-0-1": [],
          "cmc-2": [],
          "cmc-3": ["Vendilion Clique"],
          "cmc-4": [],
          "cmc-5": [],
          "cmc-6+": [],
          lands: [],
        },
      },
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };
    const migrated = migrateDeckState(legacy);
    expect(migrated.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
    expect(migrated.zones.deck["mv-2"]).toEqual(["Counterspell"]);
    expect(migrated.zones.deck["lands"]).toEqual(["Tundra"]);
    expect(migrated.zones.sideboard["mv-3"]).toEqual(["Vendilion Clique"]);
    expect("cmc-0-1" in migrated.zones.deck).toBe(false);
  });

  it("returns same state if already using mv-* keys", () => {
    const state = createEmptyDeckState("tarkir", 1);
    expect(migrateDeckState(state)).toBe(state);
  });

  it("fills in canonical columns missing from a sparse persisted state", () => {
    // Shape a hand-crafted API client once stored: one non-empty column, rest absent
    const sparse = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: { "mv-2": ["Counterspell"] },
        sideboard: {},
      },
    } as unknown as DeckState;

    const migrated = migrateDeckState(sparse);

    for (const zone of ["deck", "sideboard"] as const) {
      for (const key of columnKeysForZone(zone)) {
        expect(Array.isArray(migrated.zones[zone][key]), `${zone}.${key}`).toBe(true);
      }
    }
    expect(migrated.zones.deck["mv-2"]).toEqual(["Counterspell"]);
  });

  it("relocates cards under unrecognized column keys to mv-0-1", () => {
    const malformed = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: { creatures: ["Baleful Strix"], "mv-0-1": ["Lightning Bolt"] },
        sideboard: { spells: ["Counterspell"] },
      },
    } as unknown as DeckState;

    const migrated = migrateDeckState(malformed);

    expect([...migrated.zones.deck["mv-0-1"]].sort()).toEqual(["Baleful Strix", "Lightning Bolt"]);
    expect("creatures" in migrated.zones.deck).toBe(false);
    expect(migrated.zones.sideboard["mv-0-1"]).toEqual(["Counterspell"]);
  });

  it("REBUILD does not throw when the prior state is missing canonical columns", () => {
    const sparse = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: { "mv-2": ["Counterspell"] },
        sideboard: {},
      },
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    } as unknown as DeckState;

    const next = deckReducer(sparse, {
      type: "REBUILD",
      canonicalCards: ["Counterspell", "Lightning Bolt"],
      scryfallData: new Map(),
    });

    expect(next.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
    expect(next.zones.deck["mv-2"]).toEqual(["Counterspell"]);
  });
});

describe("migrateDeckState — row-aware keys", () => {
  /** The seven-column shape every zone had before the maindeck was split. */
  function preSplitColumns(cards: Record<string, string[]> = {}): Record<string, string[]> {
    return {
      "mv-0-1": [],
      "mv-2": [],
      "mv-3": [],
      "mv-4": [],
      "mv-5": [],
      "mv-6+": [],
      lands: [],
      ...cards,
    };
  }

  function preSplitState(deck: Record<string, string[]> = {}): DeckState {
    return {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: preSplitColumns(deck),
        sideboard: preSplitColumns(),
      },
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };
  }

  it("adds the missing nc-* columns to a pre-split deck zone without moving cards", () => {
    const migrated = migrateDeckState(
      preSplitState({ "mv-0-1": ["Lightning Bolt"], lands: ["Tundra"] })
    );

    expect(Object.keys(migrated.zones.deck)).toHaveLength(13);
    expect(migrated.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
    expect(migrated.zones.deck["lands"]).toEqual(["Tundra"]);
    for (const key of NONCREATURE_COLUMN_KEYS) {
      expect(migrated.zones.deck[key]).toEqual([]);
    }
  });

  it("leaves the sideboard at the seven base keys", () => {
    const migrated = migrateDeckState(preSplitState({ "mv-2": ["Counterspell"] }));
    expect(Object.keys(migrated.zones.sideboard)).toEqual([...BASE_COLUMN_KEYS]);
  });

  it("leaves version untouched", () => {
    expect(migrateDeckState(preSplitState()).version).toBeUndefined();
  });

  it("preserves an explicit version through normalization", () => {
    const versioned = { ...preSplitState(), version: 1 };
    expect(migrateDeckState(versioned).version).toBe(1);
  });

  it("preserves an already-canonical split state by reference", () => {
    const canonical = createEmptyDeckState("tarkir", 1);
    canonical.zones.deck["nc-mv-2"] = ["Counterspell"];
    canonical.zones.deck["mv-3"] = ["Vendilion Clique"];
    expect(migrateDeckState(canonical)).toBe(canonical);
  });

  it("merges a deck-zone nc-lands key into the shared lands column", () => {
    const state = preSplitState({ lands: ["Tundra"] });
    state.zones.deck["nc-lands"] = ["Plains", "Wastes"];

    const migrated = migrateDeckState(state);

    expect(migrated.zones.deck["lands"]).toEqual(["Tundra", "Plains", "Wastes"]);
    expect("nc-lands" in migrated.zones.deck).toBe(false);
    expect(migrated.zones.deck["mv-0-1"]).toEqual([]);
  });

  it("merges an nc-* key found in the sideboard into its base column", () => {
    const rolledBack = preSplitState();
    rolledBack.zones.sideboard["nc-mv-2"] = ["Counterspell"];
    rolledBack.zones.sideboard["mv-2"] = ["Force Spike"];

    const migrated = migrateDeckState(rolledBack);

    expect(migrated.zones.sideboard["mv-2"]).toEqual(["Force Spike", "Counterspell"]);
    expect("nc-mv-2" in migrated.zones.sideboard).toBe(false);
  });

  it("relocates an unrecognized key to mv-0-1", () => {
    const malformed = preSplitState();
    malformed.zones.deck["creatures"] = ["Baleful Strix"];

    const migrated = migrateDeckState(malformed);

    expect(migrated.zones.deck["mv-0-1"]).toEqual(["Baleful Strix"]);
    expect("creatures" in migrated.zones.deck).toBe(false);
  });
});
