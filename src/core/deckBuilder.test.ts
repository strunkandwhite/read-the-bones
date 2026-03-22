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

  it("has empty speculative cards", () => {
    const state = createEmptyDeckState("tarkir", 1);
    expect(state.speculativeCards).toEqual([]);
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
  it("returns an 8-character string", () => {
    const id = generateDeckId();
    expect(id).toHaveLength(8);
  });

  it("contains only lowercase alphanumeric characters", () => {
    const id = generateDeckId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
  });
});

describe("deckReducer", () => {
  describe("INIT_FROM_PICKS", () => {
    it("places all picks into deck columns with sideboard empty", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt", "Counterspell", "Tundra"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
      expect(result.zones.deck["mv-0-1"]).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["mv-2"]).toEqual(["Counterspell"]);
      expect(result.zones.deck["lands"]).toEqual(["Tundra"]);
      // Sideboard should be empty
      for (const key of COLUMN_KEYS) {
        expect(result.zones.sideboard[key]).toEqual([]);
      }
    });
  });

  describe("MOVE_CARD", () => {
    it("moves a card between zones", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
  });

  describe("ADD_SPECULATIVE", () => {
    it("adds a card to deck and speculative list", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      expect(result.speculativeCards).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
    });

    it("prevents duplicate speculative cards", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      expect(result).toBe(state);
      expect(result.speculativeCards).toEqual(["Lightning Bolt"]);
    });

    it("allows adding multiple copies when maxCopies allows", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
        maxCopies: 2,
      });
      const result = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
        maxCopies: 2,
      });
      expect(result.speculativeCards).toEqual(["Lightning Bolt", "Lightning Bolt"]);
      expect(result.zones.deck["mv-0-1"].filter((c: string) => c === "Lightning Bolt")).toHaveLength(2);
    });

    it("blocks adding beyond maxCopies", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
        maxCopies: 2,
      });
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
        maxCopies: 2,
      });
      const result = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
        maxCopies: 2,
      });
      expect(result).toBe(state);
      expect(result.speculativeCards).toEqual(["Lightning Bolt", "Lightning Bolt"]);
    });
  });

  describe("REMOVE_SPECULATIVE", () => {
    it("removes a speculative card from deck", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "REMOVE_SPECULATIVE",
        cardName: "Lightning Bolt",
      });
      expect(result.speculativeCards).toEqual([]);
      expect(result.zones.deck["mv-0-1"]).not.toContain("Lightning Bolt");
    });

    it("removes a speculative card that was moved to sideboard", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      const result = deckReducer(state, {
        type: "REMOVE_SPECULATIVE",
        cardName: "Lightning Bolt",
      });
      expect(result.speculativeCards).toEqual([]);
      expect(result.zones.sideboard["mv-0-1"]).not.toContain("Lightning Bolt");
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
      // Put a non-basic land in the deck (INIT_FROM_PICKS places cards in deck)
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        picks: ["Tundra"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt", "Counterspell"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
        speculativeCards: [],
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

  describe("SYNC_PICKS", () => {
    it("adds missing picked cards to deck", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["mv-2"]).toContain("Counterspell");
    });

    it("promotes speculative cards to real (removes from speculativeCards, keeps position)", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      // Card starts in deck from ADD_SPECULATIVE; move to sideboard to verify it stays there
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Lightning Bolt",
        fromZone: "deck",
        toZone: "sideboard",
        fromColumn: "mv-0-1",
        toColumn: "mv-0-1",
        toIndex: 0,
      });
      expect(state.speculativeCards).toEqual(["Lightning Bolt"]);
      expect(state.zones.sideboard["mv-0-1"]).toContain("Lightning Bolt");

      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result.speculativeCards).toEqual([]);
      // Card stays in the sideboard zone where user placed it
      expect(result.zones.sideboard["mv-0-1"]).toContain("Lightning Bolt");
    });

    it("returns same state reference when nothing changes", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result).toBe(state);
    });

    it("handles both promotion and addition in one call", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell"],
        scryfallData,
      });
      expect(result.speculativeCards).toEqual([]);
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
      expect(result.zones.deck["mv-2"]).toContain("Counterspell");
    });

    it("removes speculative cards taken by other players", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      expect(state.speculativeCards).toEqual(["Lightning Bolt"]);
      expect(state.zones.deck["mv-0-1"]).toContain("Lightning Bolt");

      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: [],
        takenCardNames: ["Lightning Bolt"],
        scryfallData,
      });
      expect(result.speculativeCards).toEqual([]);
      expect(result.zones.deck["mv-0-1"]).not.toContain("Lightning Bolt");
      expect(result.zones.sideboard["mv-0-1"]).not.toContain("Lightning Bolt");
    });

    it("keeps speculative cards that are not taken", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Lightning Bolt",
        scryfallData,
      });
      const result = deckReducer(state, {
        type: "SYNC_PICKS",
        pickedCardNames: [],
        takenCardNames: ["Counterspell"],
        scryfallData,
      });
      expect(result.speculativeCards).toEqual(["Lightning Bolt"]);
      expect(result.zones.deck["mv-0-1"]).toContain("Lightning Bolt");
    });
  });

  describe("REORDER_CARD", () => {
    it("reorders a card within a column", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt", "Mox Ruby"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
        type: "INIT_FROM_PICKS",
        picks: ["Lightning Bolt", "Counterspell"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
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
      speculativeCards: [],
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
