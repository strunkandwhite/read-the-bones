import { describe, it, expect } from "vitest";
import type { DeckState, ScryCard } from "./types";
import {
  COLUMN_KEYS,
  assignCardsToColumns,
  createEmptyDeckState,
  deckReducer,
  formatDecklistText,
  generateDeckId,
  getColumnKey,
  migrateDeckState,
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
const vendilion = makeScryCard({ name: "Vendilion Clique", manaValue: 3, typeLine: "Creature - Faerie Wizard" });
const jace = makeScryCard({ name: "Jace, the Mind Sculptor", manaValue: 4, typeLine: "Planeswalker - Jace" });
const forceOfWill = makeScryCard({ name: "Force of Will", manaValue: 5, typeLine: "Instant" });
const emrakul = makeScryCard({ name: "Emrakul, the Aeons Torn", manaValue: 15, typeLine: "Creature - Eldrazi" });
const moxRuby = makeScryCard({ name: "Mox Ruby", manaValue: 0, typeLine: "Artifact" });
const tundra = makeScryCard({ name: "Tundra", manaValue: 0, typeLine: "Land" });
const dryad = makeScryCard({ name: "Dryad Arbor", manaValue: 0, typeLine: "Land Creature - Dryad" });
const sixDrop = makeScryCard({ name: "Primeval Titan", manaValue: 6, typeLine: "Creature - Giant" });
const tenDrop = makeScryCard({ name: "Ulamog", manaValue: 10, typeLine: "Creature - Eldrazi" });

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

describe("COLUMN_KEYS", () => {
  it("has exactly 7 columns", () => {
    expect(COLUMN_KEYS).toHaveLength(7);
  });

  it("is in the expected order", () => {
    expect(COLUMN_KEYS).toEqual([
      "mv-0-1",
      "mv-2",
      "mv-3",
      "mv-4",
      "mv-5",
      "mv-6+",
      "lands",
    ]);
  });
});

describe("assignCardsToColumns", () => {
  it("distributes cards into correct columns", () => {
    const result = assignCardsToColumns(
      ["Lightning Bolt", "Counterspell", "Tundra"],
      scryfallData,
    );
    expect(result["mv-0-1"]).toEqual(["Lightning Bolt"]);
    expect(result["mv-2"]).toEqual(["Counterspell"]);
    expect(result["lands"]).toEqual(["Tundra"]);
  });

  it("falls back to mv-0-1 for unknown cards", () => {
    const result = assignCardsToColumns(
      ["Unknown Card"],
      scryfallData,
    );
    expect(result["mv-0-1"]).toEqual(["Unknown Card"]);
  });

  it("preserves order within a column", () => {
    const result = assignCardsToColumns(
      ["Lightning Bolt", "Mox Ruby"],
      scryfallData,
    );
    expect(result["mv-0-1"]).toEqual(["Lightning Bolt", "Mox Ruby"]);
  });
});

describe("createEmptyDeckState", () => {
  it("creates state with correct draftId and seat", () => {
    const state = createEmptyDeckState("tarkir", 3);
    expect(state.draftId).toBe("tarkir");
    expect(state.seat).toBe(3);
  });

  it("has 7 columns in both zones", () => {
    const state = createEmptyDeckState("tarkir", 1);
    expect(Object.keys(state.zones.deck)).toHaveLength(7);
    expect(Object.keys(state.zones.sideboard)).toHaveLength(7);
    for (const key of COLUMN_KEYS) {
      expect(state.zones.deck[key]).toEqual([]);
      expect(state.zones.sideboard[key]).toEqual([]);
    }
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
  describe("REBUILD", () => {
    it("places all canonical cards into deck columns with sideboard empty", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "REBUILD",
        canonicalCards: ["Lightning Bolt", "Counterspell", "Tundra"],
        scryfallData,
      });
      expect(result.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["mv-2"]).toEqual(["Counterspell"]);
      expect(result.zones.deck["lands"]).toEqual(["Tundra"]);
      // Sideboard should be empty
      for (const key of COLUMN_KEYS) {
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
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["mv-2"]).toContain("Counterspell");
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
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["mv-2"]).toEqual([]);
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
        fromColumn: "mv-2",
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
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
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
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
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
        fromColumn: "mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      expect(result.zones.deck["mv-0-1"]).toEqual([]);
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
        fromColumn: "mv-0-1",
        toColumn: "mv-2",
        toIndex: 0,
      });
      expect(result.zones.deck["mv-0-1"]).toEqual([]);
      expect(result.zones.deck["mv-2"]).toEqual(["Lightning Bolt"]);
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
        Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0,
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
        toColumn: "mv-0-1",
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

    it("adds basic land entries to deck lands column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "SET_BASICS",
        basics: { Plains: 2, Island: 1, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData,
      });
      expect(result.zones.deck["lands"]).toEqual([
        "Plains",
        "Plains",
        "Island",
      ]);
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
      expect(result.zones.deck["lands"]).toEqual([
        "Mountain",
        "Mountain",
        "Mountain",
      ]);
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
      expect(result.zones.deck["mv-0-1"]).toEqual([]);
      expect(result.zones.sideboard["mv-0-1"]).toContain("Lightning Bolt");
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
      // Both end up in deck mv-0-1
      expect(state.zones.deck["mv-0-1"]).toEqual([
        "Lightning Bolt",
        "Mox Ruby",
      ]);
      const result = deckReducer(state, {
        type: "REORDER_CARD",
        zone: "deck",
        column: "mv-0-1",
        fromIndex: 0,
        toIndex: 1,
      });
      expect(result.zones.deck["mv-0-1"]).toEqual([
        "Mox Ruby",
        "Lightning Bolt",
      ]);
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
});
