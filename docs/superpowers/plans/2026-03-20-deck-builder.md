# Deck Builder Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a visual deck builder panel (inspired by Sealed Deck) that sits above the card table, supports drag-and-drop card organization between sideboard/deck zones, speculative picks, basic land management, and shareable immutable snapshots via short URLs.

**Architecture:** The deck builder is a React component panel rendered above the existing card table in `PageClient`, sharing a `DndContext` from `@dnd-kit`. State is managed by a `useReducer`-based hook with localStorage persistence. Sharing creates immutable JSON snapshots in a Turso `shared_decks` table, served via a new `/deck/[id]` route.

**Tech Stack:** Next.js (App Router), `@dnd-kit/core` + `@dnd-kit/sortable`, Turso/libSQL, Tailwind CSS, Vitest + React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-20-deck-builder-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/core/deckBuilder.ts` | Pure functions: `DeckState` type, reducer, column assignment logic, ID generation |
| `src/core/deckBuilder.test.ts` | Tests for reducer actions, column assignment, initialization |
| `src/app/hooks/useDeckBuilder.ts` | React hook wrapping reducer + localStorage persistence |
| `src/app/hooks/useDeckBuilder.test.ts` | Hook tests for localStorage hydration, state changes |
| `src/app/components/deck-builder/DeckBuilderPanel.tsx` | Top-level panel: toolbar + two DeckZones |
| `src/app/components/deck-builder/DeckZone.tsx` | One zone (deck or sideboard): 7-column grid of DeckColumns |
| `src/app/components/deck-builder/DeckColumn.tsx` | Single sortable column with drop target |
| `src/app/components/deck-builder/DeckCard.tsx` | Draggable card tile with Scryfall art |
| `src/app/components/deck-builder/BasicLandsDialog.tsx` | Popover with +/- controls per basic land type |
| `src/app/api/deck/route.ts` | `POST` handler: create shared deck snapshot |
| `src/app/api/deck/[id]/route.ts` | `GET` handler: retrieve shared deck snapshot |
| `src/app/deck/[id]/page.tsx` | Server component: shared deck landing page |
| `src/app/deck/[id]/SharedDeckClient.tsx` | Client component: deck builder with fork-on-edit for shared links |
| `src/core/db/queries/sharedDecks.ts` | Turso queries: `createSharedDeck`, `getSharedDeck` |
| `src/core/db/queries/sharedDecks.test.ts` | Tests for shared deck queries |

### Modified Files

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `DeckState`, `ColumnMap`, `BasicLandCounts` types |
| `src/core/db/schema.sql` | Add `shared_decks` table |
| `src/core/db/queries/index.ts` | Re-export `sharedDecks` module |
| `src/app/components/PageClient.tsx` | Add deck builder toggle, render panel above card table, wrap in `DndContext` |
| `src/app/components/CardNameCell.tsx` | Add `+` button for speculative adds |
| `src/app/components/CardTable.tsx` | Pass through `onAddSpeculative` callback, visual indicator for cards in deck builder |
| `package.json` | Add `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` |

---

## Chunk 1: Data Layer (Types, Reducer, Database)

### Task 1: Types and Column Assignment Logic

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/deckBuilder.ts`
- Create: `src/core/deckBuilder.test.ts`

- [ ] **Step 1: Add types to `src/core/types.ts`**

Add at the end of the file:

```typescript
/**
 * Column assignment for deck builder zones.
 * Keys are column IDs (e.g., "cmc-0-1", "cmc-2", "lands").
 * Values are ordered lists of card names in that column.
 */
export type ColumnMap = Record<string, string[]>;

/**
 * Basic land counts for the deck builder.
 */
export type BasicLandCounts = {
  Plains: number;
  Island: number;
  Swamp: number;
  Mountain: number;
  Forest: number;
};

/**
 * Complete deck builder state, persisted to localStorage and Turso snapshots.
 */
export type DeckState = {
  draftId: string;
  seat: number;
  zones: {
    deck: ColumnMap;
    sideboard: ColumnMap;
  };
  speculativeCards: string[];
  basicLands: BasicLandCounts;
};
```

- [ ] **Step 2: Write failing tests for column assignment and reducer**

Create `src/core/deckBuilder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  getColumnKey,
  COLUMN_KEYS,
  assignCardsToColumns,
  deckReducer,
  createEmptyDeckState,
} from "./deckBuilder";
import type { ScryCard } from "./types";

describe("getColumnKey", () => {
  it("assigns CMC 0 to cmc-0-1", () => {
    expect(getColumnKey({ manaValue: 0, typeLine: "Artifact" } as ScryCard)).toBe("cmc-0-1");
  });

  it("assigns CMC 1 to cmc-0-1", () => {
    expect(getColumnKey({ manaValue: 1, typeLine: "Creature" } as ScryCard)).toBe("cmc-0-1");
  });

  it("assigns CMC 2 to cmc-2", () => {
    expect(getColumnKey({ manaValue: 2, typeLine: "Instant" } as ScryCard)).toBe("cmc-2");
  });

  it("assigns CMC 6 to cmc-6+", () => {
    expect(getColumnKey({ manaValue: 6, typeLine: "Creature" } as ScryCard)).toBe("cmc-6+");
  });

  it("assigns CMC 10 to cmc-6+", () => {
    expect(getColumnKey({ manaValue: 10, typeLine: "Sorcery" } as ScryCard)).toBe("cmc-6+");
  });

  it("assigns lands to lands column regardless of CMC", () => {
    expect(getColumnKey({ manaValue: 0, typeLine: "Land" } as ScryCard)).toBe("lands");
    expect(getColumnKey({ manaValue: 0, typeLine: "Legendary Land" } as ScryCard)).toBe("lands");
    expect(getColumnKey({ manaValue: 0, typeLine: "Land — Forest Island" } as ScryCard)).toBe("lands");
  });
});

describe("COLUMN_KEYS", () => {
  it("has 7 columns in correct order", () => {
    expect(COLUMN_KEYS).toEqual([
      "cmc-0-1", "cmc-2", "cmc-3", "cmc-4", "cmc-5", "cmc-6+", "lands",
    ]);
  });
});

describe("assignCardsToColumns", () => {
  it("distributes cards into correct columns", () => {
    const cards = new Map<string, ScryCard>([
      ["Birds of Paradise", { manaValue: 1, typeLine: "Creature" } as ScryCard],
      ["Counterspell", { manaValue: 2, typeLine: "Instant" } as ScryCard],
      ["Breeding Pool", { manaValue: 0, typeLine: "Land — Forest Island" } as ScryCard],
    ]);

    const result = assignCardsToColumns(
      ["Birds of Paradise", "Counterspell", "Breeding Pool"],
      cards
    );

    expect(result["cmc-0-1"]).toEqual(["Birds of Paradise"]);
    expect(result["cmc-2"]).toEqual(["Counterspell"]);
    expect(result["lands"]).toEqual(["Breeding Pool"]);
    // Empty columns still present
    expect(result["cmc-3"]).toEqual([]);
  });

  it("falls back to cmc-0-1 for unknown cards", () => {
    const result = assignCardsToColumns(["Unknown Card"], new Map());
    expect(result["cmc-0-1"]).toEqual(["Unknown Card"]);
  });
});

describe("createEmptyDeckState", () => {
  it("creates state with all empty columns in both zones", () => {
    const state = createEmptyDeckState("tarkir", 3);
    expect(state.draftId).toBe("tarkir");
    expect(state.seat).toBe(3);
    expect(Object.keys(state.zones.deck)).toHaveLength(7);
    expect(Object.keys(state.zones.sideboard)).toHaveLength(7);
    expect(state.speculativeCards).toEqual([]);
    expect(state.basicLands).toEqual({
      Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0,
    });
  });
});

describe("deckReducer", () => {
  const baseScryfallMap = new Map<string, ScryCard>([
    ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
    ["Card B", { manaValue: 2, typeLine: "Instant" } as ScryCard],
    ["Card C", { manaValue: 3, typeLine: "Creature" } as ScryCard],
    ["Land X", { manaValue: 0, typeLine: "Land" } as ScryCard],
  ]);

  describe("INIT_FROM_PICKS", () => {
    it("places all picks into sideboard columns", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const next = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A", "Card B", "Land X"],
        scryfallData: baseScryfallMap,
      });

      expect(next.zones.sideboard["cmc-0-1"]).toEqual(["Card A"]);
      expect(next.zones.sideboard["cmc-2"]).toEqual(["Card B"]);
      expect(next.zones.sideboard["lands"]).toEqual(["Land X"]);
      // Deck should be empty
      expect(Object.values(next.zones.deck).flat()).toHaveLength(0);
    });
  });

  describe("MOVE_CARD", () => {
    it("moves a card from sideboard to deck", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A"],
        scryfallData: baseScryfallMap,
      });

      const next = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Card A",
        fromZone: "sideboard",
        fromColumn: "cmc-0-1",
        toZone: "deck",
        toColumn: "cmc-0-1",
        toIndex: 0,
      });

      expect(next.zones.sideboard["cmc-0-1"]).toEqual([]);
      expect(next.zones.deck["cmc-0-1"]).toEqual(["Card A"]);
    });

    it("moves a card between columns within the same zone", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A"],
        scryfallData: baseScryfallMap,
      });

      const next = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Card A",
        fromZone: "sideboard",
        fromColumn: "cmc-0-1",
        toZone: "sideboard",
        toColumn: "cmc-3",
        toIndex: 0,
      });

      expect(next.zones.sideboard["cmc-0-1"]).toEqual([]);
      expect(next.zones.sideboard["cmc-3"]).toEqual(["Card A"]);
    });
  });

  describe("ADD_SPECULATIVE", () => {
    it("adds a speculative card to sideboard", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const next = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Card C",
        scryfallData: baseScryfallMap,
      });

      expect(next.speculativeCards).toContain("Card C");
      expect(next.zones.sideboard["cmc-3"]).toContain("Card C");
    });

    it("does not add duplicate speculative cards", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Card C",
        scryfallData: baseScryfallMap,
      });
      const next = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Card C",
        scryfallData: baseScryfallMap,
      });

      expect(next.speculativeCards.filter((c) => c === "Card C")).toHaveLength(1);
    });
  });

  describe("REMOVE_SPECULATIVE", () => {
    it("removes a speculative card from wherever it is", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "ADD_SPECULATIVE",
        cardName: "Card C",
        scryfallData: baseScryfallMap,
      });
      // Move it to deck first
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Card C",
        fromZone: "sideboard",
        fromColumn: "cmc-3",
        toZone: "deck",
        toColumn: "cmc-3",
        toIndex: 0,
      });

      const next = deckReducer(state, {
        type: "REMOVE_SPECULATIVE",
        cardName: "Card C",
      });

      expect(next.speculativeCards).not.toContain("Card C");
      expect(next.zones.deck["cmc-3"]).not.toContain("Card C");
    });
  });

  describe("SET_BASICS", () => {
    it("updates basic land counts and adds lands to deck column", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const next = deckReducer(state, {
        type: "SET_BASICS",
        basicLands: { Plains: 0, Island: 2, Swamp: 0, Mountain: 0, Forest: 7 },
        scryfallData: baseScryfallMap,
      });

      expect(next.basicLands.Island).toBe(2);
      expect(next.basicLands.Forest).toBe(7);
      // Basic lands should appear in the deck's lands column
      expect(next.zones.deck["lands"].filter((n) => n === "Island")).toHaveLength(2);
      expect(next.zones.deck["lands"].filter((n) => n === "Forest")).toHaveLength(7);
    });

    it("replaces previous basic lands on re-set", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "SET_BASICS",
        basicLands: { Plains: 0, Island: 5, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData: baseScryfallMap,
      });
      const next = deckReducer(state, {
        type: "SET_BASICS",
        basicLands: { Plains: 0, Island: 2, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData: baseScryfallMap,
      });

      expect(next.zones.deck["lands"].filter((n) => n === "Island")).toHaveLength(2);
    });
  });

  describe("CLEAR_DECK", () => {
    it("moves all deck cards to sideboard and resets basics", () => {
      let state = createEmptyDeckState("tarkir", 1);
      state = deckReducer(state, {
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A", "Card B"],
        scryfallData: baseScryfallMap,
      });
      // Move Card A to deck
      state = deckReducer(state, {
        type: "MOVE_CARD",
        cardName: "Card A",
        fromZone: "sideboard",
        fromColumn: "cmc-0-1",
        toZone: "deck",
        toColumn: "cmc-0-1",
        toIndex: 0,
      });
      state = deckReducer(state, {
        type: "SET_BASICS",
        basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 7 },
        scryfallData: baseScryfallMap,
      });

      const next = deckReducer(state, {
        type: "CLEAR_DECK",
        scryfallData: baseScryfallMap,
      });

      // Deck should be empty
      expect(Object.values(next.zones.deck).flat()).toHaveLength(0);
      // Card A should be back in sideboard
      expect(next.zones.sideboard["cmc-0-1"]).toContain("Card A");
      // Basics reset
      expect(next.basicLands.Forest).toBe(0);
    });
  });

  describe("INIT_FROM_SNAPSHOT", () => {
    it("replaces entire state with snapshot", () => {
      const state = createEmptyDeckState("tarkir", 1);
      const snapshot = createEmptyDeckState("dominaria", 5);
      snapshot.zones.deck["cmc-2"] = ["Counterspell"];
      snapshot.speculativeCards = ["Counterspell"];

      const next = deckReducer(state, {
        type: "INIT_FROM_SNAPSHOT",
        snapshot,
      });

      expect(next.draftId).toBe("dominaria");
      expect(next.seat).toBe(5);
      expect(next.zones.deck["cmc-2"]).toEqual(["Counterspell"]);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/core/deckBuilder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `src/core/deckBuilder.ts`**

```typescript
/**
 * Deck builder state management.
 * Pure functions: reducer, column assignment, initialization.
 */

import type { DeckState, ColumnMap, BasicLandCounts, ScryCard } from "./types";

/** Canonical column keys in display order. */
export const COLUMN_KEYS = [
  "cmc-0-1",
  "cmc-2",
  "cmc-3",
  "cmc-4",
  "cmc-5",
  "cmc-6+",
  "lands",
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

/** Determine which column a card belongs to based on its Scryfall data. */
export function getColumnKey(scryfall: ScryCard): ColumnKey {
  if (scryfall.typeLine.toLowerCase().includes("land")) return "lands";
  const mv = scryfall.manaValue;
  if (mv <= 1) return "cmc-0-1";
  if (mv === 2) return "cmc-2";
  if (mv === 3) return "cmc-3";
  if (mv === 4) return "cmc-4";
  if (mv === 5) return "cmc-5";
  return "cmc-6+";
}

/** Create an empty ColumnMap with all 7 columns initialized to []. */
export function createEmptyColumnMap(): ColumnMap {
  const map: ColumnMap = {};
  for (const key of COLUMN_KEYS) {
    map[key] = [];
  }
  return map;
}

/** Assign card names to columns based on Scryfall data. Unknown cards go to cmc-0-1. */
export function assignCardsToColumns(
  cardNames: string[],
  scryfallData: Map<string, ScryCard>
): ColumnMap {
  const columns = createEmptyColumnMap();
  for (const name of cardNames) {
    const scryfall = scryfallData.get(name);
    const key = scryfall ? getColumnKey(scryfall) : "cmc-0-1";
    columns[key].push(name);
  }
  return columns;
}

/** Create an empty DeckState for a given draft and seat. */
export function createEmptyDeckState(draftId: string, seat: number): DeckState {
  return {
    draftId,
    seat,
    zones: {
      deck: createEmptyColumnMap(),
      sideboard: createEmptyColumnMap(),
    },
    speculativeCards: [],
    basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
  };
}

/** Generate a short random ID for shared deck URLs. */
export function generateDeckId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

// ============================================================================
// Reducer
// ============================================================================

type ZoneName = "deck" | "sideboard";

export type DeckAction =
  | {
      type: "INIT_FROM_PICKS";
      cardNames: string[];
      scryfallData: Map<string, ScryCard>;
    }
  | { type: "INIT_FROM_SNAPSHOT"; snapshot: DeckState }
  | {
      type: "MOVE_CARD";
      cardName: string;
      fromZone: ZoneName;
      fromColumn: string;
      toZone: ZoneName;
      toColumn: string;
      toIndex: number;
    }
  | {
      type: "REORDER_CARD";
      zone: ZoneName;
      column: string;
      fromIndex: number;
      toIndex: number;
    }
  | {
      type: "ADD_SPECULATIVE";
      cardName: string;
      scryfallData: Map<string, ScryCard>;
    }
  | { type: "REMOVE_SPECULATIVE"; cardName: string }
  | { type: "SET_BASICS"; basicLands: BasicLandCounts; scryfallData: Map<string, ScryCard> }
  | { type: "CLEAR_DECK"; scryfallData: Map<string, ScryCard> };

export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "INIT_FROM_PICKS": {
      const sideboard = assignCardsToColumns(action.cardNames, action.scryfallData);
      return {
        ...state,
        zones: { deck: createEmptyColumnMap(), sideboard },
        speculativeCards: [],
        basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      };
    }

    case "INIT_FROM_SNAPSHOT":
      return { ...action.snapshot };

    case "MOVE_CARD": {
      const newState = structuredClone(state);
      const fromList = newState.zones[action.fromZone][action.fromColumn];
      const idx = fromList.indexOf(action.cardName);
      if (idx === -1) return state;
      fromList.splice(idx, 1);
      const toList = newState.zones[action.toZone][action.toColumn];
      toList.splice(action.toIndex, 0, action.cardName);
      return newState;
    }

    case "REORDER_CARD": {
      const newState = structuredClone(state);
      const list = newState.zones[action.zone][action.column];
      const [card] = list.splice(action.fromIndex, 1);
      list.splice(action.toIndex, 0, card);
      return newState;
    }

    case "ADD_SPECULATIVE": {
      if (state.speculativeCards.includes(action.cardName)) return state;
      const newState = structuredClone(state);
      newState.speculativeCards.push(action.cardName);
      const scryfall = action.scryfallData.get(action.cardName);
      const colKey = scryfall ? getColumnKey(scryfall) : "cmc-0-1";
      newState.zones.sideboard[colKey].push(action.cardName);
      return newState;
    }

    case "REMOVE_SPECULATIVE": {
      if (!state.speculativeCards.includes(action.cardName)) return state;
      const newState = structuredClone(state);
      newState.speculativeCards = newState.speculativeCards.filter(
        (c) => c !== action.cardName
      );
      // Remove from whichever zone/column it's in
      for (const zone of ["deck", "sideboard"] as const) {
        for (const col of Object.keys(newState.zones[zone])) {
          newState.zones[zone][col] = newState.zones[zone][col].filter(
            (c) => c !== action.cardName
          );
        }
      }
      return newState;
    }

    case "SET_BASICS": {
      // Update basic land counts and sync the lands column in the deck zone.
      // Remove old basic land entries, then add new ones based on counts.
      const BASIC_NAMES = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;
      const newState = structuredClone(state);
      newState.basicLands = { ...action.basicLands };

      // Remove existing basic land entries from deck lands column
      const deckLands = newState.zones.deck["lands"] ?? [];
      newState.zones.deck["lands"] = deckLands.filter(
        (name) => !(BASIC_NAMES as readonly string[]).includes(name)
      );

      // Add new basic land entries
      for (const land of BASIC_NAMES) {
        for (let i = 0; i < action.basicLands[land]; i++) {
          newState.zones.deck["lands"].push(land);
        }
      }
      return newState;
    }

    case "CLEAR_DECK": {
      // Collect all card names from deck zone
      const deckCards = Object.values(state.zones.deck).flat();
      // Re-assign them to sideboard columns
      const newState = structuredClone(state);
      newState.zones.deck = createEmptyColumnMap();
      for (const cardName of deckCards) {
        const scryfall = action.scryfallData.get(cardName);
        const colKey = scryfall ? getColumnKey(scryfall) : "cmc-0-1";
        newState.zones.sideboard[colKey].push(cardName);
      }
      newState.basicLands = { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 };
      return newState;
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/core/deckBuilder.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/deckBuilder.ts src/core/deckBuilder.test.ts
git commit -m "Add deck builder types, reducer, and column assignment logic"
```

---

### Task 2: Database Schema and Shared Deck Queries

**Files:**
- Modify: `src/core/db/schema.sql`
- Create: `src/core/db/queries/sharedDecks.ts`
- Create: `src/core/db/queries/sharedDecks.test.ts`
- Modify: `src/core/db/queries/index.ts`

- [ ] **Step 1: Add `shared_decks` table to schema**

Append to `src/core/db/schema.sql`:

```sql
-- Immutable snapshots of shared decks. Distinct from deck_cards, which stores
-- actual decklists imported from sealeddeck.tech for analytics purposes.
CREATE TABLE IF NOT EXISTS shared_decks (
  deck_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write failing tests for shared deck queries**

Create `src/core/db/queries/sharedDecks.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({ getClient: vi.fn() }));

import { getClient } from "../client";
import { createSharedDeck, getSharedDeck } from "./sharedDecks";

const mockGetClient = vi.mocked(getClient);

function createMockClient() {
  return { execute: vi.fn() };
}

describe("createSharedDeck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts deck state and returns the deck ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
    mockClient.execute.mockResolvedValue({ rows: [] });

    const deckState = {
      draftId: "tarkir",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };

    const result = await createSharedDeck(deckState);

    expect(result.deckId).toBeDefined();
    expect(typeof result.deckId).toBe("string");
    expect(result.deckId.length).toBe(8);
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO shared_decks"),
      })
    );
  });
});

describe("getSharedDeck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns deck state for a valid ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);

    const deckState = {
      draftId: "tarkir",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };

    mockClient.execute.mockResolvedValue({
      rows: [{
        deck_id: "abc12345",
        draft_id: "tarkir",
        seat: 3,
        deck_state: JSON.stringify(deckState),
        created_at: "2026-03-20T00:00:00",
      }],
    });

    const result = await getSharedDeck("abc12345");
    expect(result).not.toBeNull();
    expect(result!.deckState.draftId).toBe("tarkir");
    expect(result!.deckState.seat).toBe(3);
  });

  it("returns null for unknown ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await getSharedDeck("nonexistent");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/sharedDecks.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement `src/core/db/queries/sharedDecks.ts`**

```typescript
/**
 * Shared deck snapshot queries (create, retrieve).
 */

import { getClient } from "../client";
import { generateDeckId } from "../../deckBuilder";
import type { DeckState } from "../../types";

export interface SharedDeckResult {
  deckId: string;
  draftId: string;
  seat: number;
  deckState: DeckState;
  createdAt: string;
}

/**
 * Create an immutable shared deck snapshot.
 * Returns the generated deck ID.
 */
export async function createSharedDeck(
  deckState: DeckState
): Promise<{ deckId: string }> {
  const client = await getClient();
  const deckId = generateDeckId();

  await client.execute({
    sql: `INSERT INTO shared_decks (deck_id, draft_id, seat, deck_state)
          VALUES (?, ?, ?, ?)`,
    args: [deckId, deckState.draftId, deckState.seat, JSON.stringify(deckState)],
  });

  return { deckId };
}

/**
 * Retrieve a shared deck snapshot by ID.
 * Returns null if not found.
 */
export async function getSharedDeck(
  deckId: string
): Promise<SharedDeckResult | null> {
  const client = await getClient();

  const result = await client.execute({
    sql: `SELECT deck_id, draft_id, seat, deck_state, created_at
          FROM shared_decks
          WHERE deck_id = ?`,
    args: [deckId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    deckId: row.deck_id as string,
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: JSON.parse(row.deck_state as string) as DeckState,
    createdAt: row.created_at as string,
  };
}
```

- [ ] **Step 5: Add export to `src/core/db/queries/index.ts`**

Add line: `export * from "./sharedDecks";`

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/sharedDecks.test.ts`
Expected: All tests PASS

- [ ] **Step 7: Run migration**

Run: `pnpm db:migrate`
Expected: `shared_decks` table created

- [ ] **Step 8: Commit**

```bash
git add src/core/db/schema.sql src/core/db/queries/sharedDecks.ts src/core/db/queries/sharedDecks.test.ts src/core/db/queries/index.ts
git commit -m "Add shared_decks table and query functions for deck snapshots"
```

---

### Task 3: API Routes for Sharing

**Files:**
- Create: `src/app/api/deck/route.ts`
- Create: `src/app/api/deck/[id]/route.ts`

- [ ] **Step 1: Implement POST `/api/deck`**

Create `src/app/api/deck/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createSharedDeck } from "@/core/db/queries/sharedDecks";
import type { DeckState } from "@/core/types";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export async function POST(request: NextRequest) {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 }
      );
    }

    const deckState: DeckState = JSON.parse(text);

    if (!deckState.draftId || typeof deckState.seat !== "number") {
      return NextResponse.json(
        { error: "Invalid deck state: missing draftId or seat" },
        { status: 400 }
      );
    }

    const { deckId } = await createSharedDeck(deckState);
    return NextResponse.json({ deckId });
  } catch (error) {
    console.error("[/api/deck] Error:", error);
    return NextResponse.json(
      { error: "Failed to create shared deck" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Implement GET `/api/deck/[id]`**

Create `src/app/api/deck/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getSharedDeck } from "@/core/db/queries/sharedDecks";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const result = await getSharedDeck(id);

    if (!result) {
      return NextResponse.json({ error: "Deck not found" }, { status: 404 });
    }

    return NextResponse.json(result.deckState, {
      headers: {
        "Cache-Control": "public, s-maxage=31536000, immutable",
      },
    });
  } catch (error) {
    console.error("[/api/deck/[id]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load shared deck" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/api/deck/route.ts src/app/api/deck/\[id\]/route.ts
git commit -m "Add API routes for creating and retrieving shared deck snapshots"
```

---

## Chunk 2: React Hook and Dependencies

### Task 4: Install `@dnd-kit` Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install packages**

Run: `pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities`

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "Add @dnd-kit drag-and-drop dependencies"
```

---

### Task 5: `useDeckBuilder` Hook

**Files:**
- Create: `src/app/hooks/useDeckBuilder.ts`
- Create: `src/app/hooks/useDeckBuilder.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/hooks/useDeckBuilder.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeckBuilder } from "./useDeckBuilder";
import type { ScryCard } from "@/core/types";

const scryfallData = new Map<string, ScryCard>([
  ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
  ["Card B", { manaValue: 3, typeLine: "Instant" } as ScryCard],
]);

describe("useDeckBuilder", () => {
  beforeEach(() => localStorage.clear());

  it("initializes with empty state", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 })
    );
    expect(result.current.state.draftId).toBe("tarkir");
    expect(result.current.state.seat).toBe(1);
  });

  it("initializes from picks", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 })
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A", "Card B"],
        scryfallData,
      });
    });

    expect(result.current.state.zones.sideboard["cmc-0-1"]).toContain("Card A");
    expect(result.current.state.zones.sideboard["cmc-3"]).toContain("Card B");
  });

  it("persists state to localStorage", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 })
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A"],
        scryfallData,
      });
    });

    const stored = localStorage.getItem("deckState:tarkir:1");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.zones.sideboard["cmc-0-1"]).toContain("Card A");
  });

  it("hydrates from localStorage on mount", () => {
    const savedState = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: { "cmc-0-1": ["Card A"], "cmc-2": [], "cmc-3": [], "cmc-4": [], "cmc-5": [], "cmc-6+": [], lands: [] },
        sideboard: { "cmc-0-1": [], "cmc-2": [], "cmc-3": [], "cmc-4": [], "cmc-5": [], "cmc-6+": [], lands: [] },
      },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };
    localStorage.setItem("deckState:tarkir:1", JSON.stringify(savedState));

    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 })
    );

    expect(result.current.state.zones.deck["cmc-0-1"]).toContain("Card A");
  });

  it("resets state when draft/seat changes", () => {
    const { result, rerender } = renderHook(
      ({ draftId, seat }) => useDeckBuilder({ draftId, seat }),
      { initialProps: { draftId: "tarkir", seat: 1 } }
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        cardNames: ["Card A"],
        scryfallData,
      });
    });

    rerender({ draftId: "dominaria", seat: 2 });

    expect(result.current.state.draftId).toBe("dominaria");
    expect(result.current.state.zones.sideboard["cmc-0-1"]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useDeckBuilder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/app/hooks/useDeckBuilder.ts`**

```typescript
import { useReducer, useEffect, useRef } from "react";
import {
  deckReducer,
  createEmptyDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

interface UseDeckBuilderProps {
  draftId: string;
  seat: number;
}

function getStorageKey(draftId: string, seat: number): string {
  return `deckState:${draftId}:${seat}`;
}

function loadFromStorage(draftId: string, seat: number): DeckState | null {
  const key = getStorageKey(draftId, seat);
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as DeckState;
  } catch {
    return null;
  }
}

function initState({
  draftId,
  seat,
}: UseDeckBuilderProps): DeckState {
  if (typeof window !== "undefined") {
    const stored = loadFromStorage(draftId, seat);
    if (stored) return stored;
  }
  return createEmptyDeckState(draftId, seat);
}

export function useDeckBuilder({ draftId, seat }: UseDeckBuilderProps) {
  const [state, dispatch] = useReducer(deckReducer, { draftId, seat }, initState);
  const prevKeyRef = useRef(`${draftId}:${seat}`);

  // Reset when draft/seat changes
  useEffect(() => {
    const newKey = `${draftId}:${seat}`;
    if (newKey !== prevKeyRef.current) {
      prevKeyRef.current = newKey;
      const stored = loadFromStorage(draftId, seat);
      if (stored) {
        dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: stored });
      } else {
        dispatch({
          type: "INIT_FROM_SNAPSHOT",
          snapshot: createEmptyDeckState(draftId, seat),
        });
      }
    }
  }, [draftId, seat]);

  // Persist to localStorage on state changes (skip if no draft selected)
  useEffect(() => {
    if (!state.draftId) return;
    const key = getStorageKey(state.draftId, state.seat);
    localStorage.setItem(key, JSON.stringify(state));
  }, [state]);

  return { state, dispatch } as const;
}

export type { DeckAction };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/hooks/useDeckBuilder.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useDeckBuilder.ts src/app/hooks/useDeckBuilder.test.ts
git commit -m "Add useDeckBuilder hook with reducer and localStorage persistence"
```

---

## Chunk 3: UI Components

### Task 6: DeckCard Component

**Files:**
- Create: `src/app/components/deck-builder/DeckCard.tsx`

- [ ] **Step 1: Implement DeckCard**

```typescript
"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import Image from "next/image";

interface DeckCardProps {
  cardName: string;
  imageUri?: string;
  isSpeculative: boolean;
  id: string; // unique drag ID: "zone:column:cardName"
}

export function DeckCard({ cardName, imageUri, isSpeculative, id }: DeckCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : isSpeculative ? 0.7 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`relative cursor-grab rounded-md overflow-hidden ${
        isSpeculative ? "border-2 border-dashed border-zinc-500" : "border border-zinc-700"
      }`}
    >
      {imageUri ? (
        <Image
          src={imageUri}
          alt={cardName}
          width={160}
          height={224}
          className="block w-full h-auto"
          draggable={false}
        />
      ) : (
        <div className="flex items-center justify-center bg-zinc-800 p-2 text-xs text-zinc-300 aspect-[5/7]">
          {cardName}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/components/deck-builder/DeckCard.tsx
git commit -m "Add DeckCard component with sortable drag behavior"
```

---

### Task 7: DeckColumn Component

**Files:**
- Create: `src/app/components/deck-builder/DeckColumn.tsx`

- [ ] **Step 1: Implement DeckColumn**

```typescript
"use client";

import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { DeckCard } from "./DeckCard";
import type { ScryCard } from "@/core/types";

interface DeckColumnProps {
  columnKey: string;
  label: string;
  cardNames: string[];
  zone: "deck" | "sideboard";
  scryfallData: Map<string, ScryCard>;
  speculativeCards: string[];
}

export function DeckColumn({
  columnKey,
  label,
  cardNames,
  zone,
  scryfallData,
  speculativeCards,
}: DeckColumnProps) {
  const droppableId = `${zone}:${columnKey}`;
  const { setNodeRef, isOver } = useDroppable({ id: droppableId });

  // Use index-based IDs to handle duplicate card names (e.g., multiple basic lands)
  const sortableIds = cardNames.map(
    (name, idx) => `${zone}:${columnKey}:${idx}:${name}`
  );

  return (
    <div className="flex flex-col">
      <div className="mb-1 text-center text-xs font-semibold text-zinc-500 dark:text-zinc-400">
        {label} <span className="text-zinc-400 dark:text-zinc-500">({cardNames.length})</span>
      </div>
      <div
        ref={setNodeRef}
        className={`flex min-h-[80px] flex-col gap-1 rounded-md p-1 transition-colors ${
          isOver
            ? "bg-blue-500/10 ring-1 ring-blue-500/30"
            : "bg-zinc-100 dark:bg-zinc-900"
        }`}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {cardNames.map((name, idx) => {
            const scryfall = scryfallData.get(name);
            return (
              <DeckCard
                key={`${zone}:${columnKey}:${idx}:${name}`}
                id={`${zone}:${columnKey}:${idx}:${name}`}
                cardName={name}
                imageUri={scryfall?.imageUri}
                isSpeculative={speculativeCards.includes(name)}
              />
            );
          })}
        </SortableContext>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/components/deck-builder/DeckColumn.tsx
git commit -m "Add DeckColumn component with sortable drop zone"
```

---

### Task 8: DeckZone Component

**Files:**
- Create: `src/app/components/deck-builder/DeckZone.tsx`

- [ ] **Step 1: Implement DeckZone**

```typescript
"use client";

import { DeckColumn } from "./DeckColumn";
import { COLUMN_KEYS } from "@/core/deckBuilder";
import type { ColumnMap, ScryCard } from "@/core/types";

const COLUMN_LABELS: Record<string, string> = {
  "cmc-0-1": "0-1",
  "cmc-2": "2",
  "cmc-3": "3",
  "cmc-4": "4",
  "cmc-5": "5",
  "cmc-6+": "6+",
  lands: "Lands",
};

interface DeckZoneProps {
  zone: "deck" | "sideboard";
  columns: ColumnMap;
  scryfallData: Map<string, ScryCard>;
  speculativeCards: string[];
}

export function DeckZone({
  zone,
  columns,
  scryfallData,
  speculativeCards,
}: DeckZoneProps) {
  const totalCards = Object.values(columns).reduce(
    (sum, cards) => sum + cards.length,
    0
  );

  const speculativeCount = Object.values(columns)
    .flat()
    .filter((name) => speculativeCards.includes(name)).length;

  const pickedCount = totalCards - speculativeCount;

  return (
    <div>
      <div className="mb-2 flex items-baseline gap-3 px-1">
        <span className="text-sm font-bold text-zinc-200">
          {zone === "deck" ? "Deck" : "Sideboard"}: {totalCards}
        </span>
        <span className="text-xs text-zinc-500">
          {pickedCount} picked
          {speculativeCount > 0 && ` · ${speculativeCount} speculative`}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {COLUMN_KEYS.map((key) => (
          <DeckColumn
            key={`${zone}:${key}`}
            columnKey={key}
            label={COLUMN_LABELS[key]}
            cardNames={columns[key] ?? []}
            zone={zone}
            scryfallData={scryfallData}
            speculativeCards={speculativeCards}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/components/deck-builder/DeckZone.tsx
git commit -m "Add DeckZone component with 7-column grid layout"
```

---

### Task 9: BasicLandsDialog Component

**Files:**
- Create: `src/app/components/deck-builder/BasicLandsDialog.tsx`

- [ ] **Step 1: Implement BasicLandsDialog**

```typescript
"use client";

import { useState } from "react";
import type { BasicLandCounts } from "@/core/types";

const BASIC_LAND_NAMES: (keyof BasicLandCounts)[] = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
];

const LAND_COLORS: Record<string, string> = {
  Plains: "bg-amber-100 dark:bg-amber-900/30",
  Island: "bg-blue-100 dark:bg-blue-900/30",
  Swamp: "bg-zinc-300 dark:bg-zinc-700",
  Mountain: "bg-red-100 dark:bg-red-900/30",
  Forest: "bg-green-100 dark:bg-green-900/30",
};

interface BasicLandsDialogProps {
  basicLands: BasicLandCounts;
  onSave: (lands: BasicLandCounts) => void;
  onClose: () => void;
}

export function BasicLandsDialog({
  basicLands,
  onSave,
  onClose,
}: BasicLandsDialogProps) {
  const [counts, setCounts] = useState<BasicLandCounts>({ ...basicLands });

  const update = (land: keyof BasicLandCounts, delta: number) => {
    setCounts((prev) => ({
      ...prev,
      [land]: Math.max(0, prev[land] + delta),
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-72 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-xl">
        <h3 className="mb-3 text-sm font-bold text-zinc-200">
          Add Basic Lands
        </h3>
        <div className="space-y-2">
          {BASIC_LAND_NAMES.map((land) => (
            <div
              key={land}
              className={`flex items-center justify-between rounded-md px-3 py-1.5 ${LAND_COLORS[land]}`}
            >
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-200">
                {land}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => update(land, -1)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700"
                >
                  -
                </button>
                <span className="w-4 text-center text-sm font-mono text-zinc-200">
                  {counts[land]}
                </span>
                <button
                  onClick={() => update(land, 1)}
                  className="flex h-6 w-6 items-center justify-center rounded bg-zinc-800 text-sm text-zinc-300 hover:bg-zinc-700"
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onSave(counts);
              onClose();
            }}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/components/deck-builder/BasicLandsDialog.tsx
git commit -m "Add BasicLandsDialog component with +/- controls per land type"
```

---

### Task 10: DeckBuilderPanel (Main Container)

**Files:**
- Create: `src/app/components/deck-builder/DeckBuilderPanel.tsx`

- [ ] **Step 1: Implement DeckBuilderPanel**

```typescript
"use client";

import { useState, useCallback, useMemo } from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import Image from "next/image";
import { DeckZone } from "./DeckZone";
import { BasicLandsDialog } from "./BasicLandsDialog";
import { getColumnKey } from "@/core/deckBuilder";
import type { DeckState, ScryCard, BasicLandCounts } from "@/core/types";
import type { DeckAction } from "@/core/deckBuilder";

interface DeckBuilderPanelProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallData: Map<string, ScryCard>;
  draftName: string;
  onClose: () => void;
}

/**
 * Parse a drag item ID like "sideboard:cmc-2:0:Counterspell"
 * into { zone, column, index, cardName }.
 * Format: "zone:column:index:cardName"
 */
function parseDragId(id: string) {
  const [zone, column, indexStr, ...rest] = id.split(":");
  return {
    zone: zone as "deck" | "sideboard",
    column,
    index: parseInt(indexStr, 10),
    cardName: rest.join(":"),
  };
}

export function DeckBuilderPanel({
  state,
  dispatch,
  scryfallData,
  draftName,
  onClose,
}: DeckBuilderPanelProps) {
  const [showBasicLands, setShowBasicLands] = useState(false);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over) return;

      const activeId = active.id as string;
      const overId = over.id as string;

      const from = parseDragId(activeId);

      // Dropping onto a column droppable (e.g., "deck:cmc-2")
      // or onto another card (e.g., "deck:cmc-2:0:CardName")
      const toParts = overId.split(":");
      const toZone = toParts[0] as "deck" | "sideboard";
      const toColumn = toParts[1];
      // If 4+ parts, it's a card ID (zone:column:index:name); if 2 parts, it's a column droppable
      const isCardTarget = toParts.length >= 4;

      if (activeId === overId) return;

      // If from same zone and column, it's a reorder
      if (from.zone === toZone && from.column === toColumn) {
        const list = state.zones[from.zone][from.column];
        const fromIndex = list.indexOf(from.cardName);
        if (isCardTarget) {
          const targetIndex = parseInt(toParts[2], 10);
          if (fromIndex !== -1 && targetIndex !== -1 && fromIndex !== targetIndex) {
            dispatch({
              type: "REORDER_CARD",
              zone: from.zone,
              column: from.column,
              fromIndex,
              toIndex: targetIndex,
            });
          }
        }
        return;
      }

      // Cross-zone or cross-column move
      const targetList = state.zones[toZone][toColumn] ?? [];
      let toIndex = targetList.length; // default: append at end
      if (isCardTarget) {
        const targetIndex = parseInt(toParts[2], 10);
        if (targetIndex >= 0) toIndex = targetIndex;
      }

      dispatch({
        type: "MOVE_CARD",
        cardName: from.cardName,
        fromZone: from.zone,
        fromColumn: from.column,
        toZone,
        toColumn,
        toIndex,
      });
    },
    [state, dispatch]
  );

  const handleShareDeck = useCallback(async () => {
    try {
      const response = await fetch("/api/deck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      });
      const { deckId } = await response.json();
      const url = `${window.location.origin}/deck/${deckId}`;
      await navigator.clipboard.writeText(url);
      alert(`Deck link copied to clipboard!\n${url}`);
    } catch (error) {
      console.error("Failed to share deck:", error);
      alert("Failed to share deck. Please try again.");
    }
  }, [state]);

  const handleSetBasics = useCallback(
    (basics: BasicLandCounts) => {
      dispatch({ type: "SET_BASICS", basicLands: basics, scryfallData });
    },
    [dispatch, scryfallData]
  );

  const handleClearDeck = useCallback(() => {
    dispatch({ type: "CLEAR_DECK", scryfallData });
  }, [dispatch, scryfallData]);

  // Build drag overlay content
  const dragOverlayCard = useMemo(() => {
    if (!activeDragId) return null;
    const { cardName } = parseDragId(activeDragId);
    const scryfall = scryfallData.get(cardName);
    return { cardName, imageUri: scryfall?.imageUri };
  }, [activeDragId, scryfallData]);

  return (
    <div className="flex flex-col rounded-xl border border-zinc-700 bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Close
          </button>
          <span className="text-sm font-semibold text-zinc-300">
            {draftName} — Seat {state.seat}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowBasicLands(true)}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Add Basic Lands
          </button>
          <button
            onClick={handleClearDeck}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
          >
            Clear Deck
          </button>
          <button
            onClick={handleShareDeck}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
          >
            Share Deck
          </button>
        </div>
      </div>

      {/* Zones */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="overflow-y-auto p-4 space-y-4" style={{ maxHeight: "45vh" }}>
          {/* Sideboard on top */}
          <DeckZone
            zone="sideboard"
            columns={state.zones.sideboard}
            scryfallData={scryfallData}
            speculativeCards={state.speculativeCards}
          />

          <div className="border-t border-zinc-700" />

          {/* Deck on bottom */}
          <DeckZone
            zone="deck"
            columns={state.zones.deck}
            scryfallData={scryfallData}
            speculativeCards={state.speculativeCards}
          />
        </div>

        {/* Drag overlay */}
        <DragOverlay>
          {dragOverlayCard && (
            <div className="w-[120px] rounded-md border border-zinc-500 shadow-xl opacity-90">
              {dragOverlayCard.imageUri ? (
                <Image
                  src={dragOverlayCard.imageUri}
                  alt={dragOverlayCard.cardName}
                  width={120}
                  height={168}
                  className="rounded-md"
                  draggable={false}
                />
              ) : (
                <div className="flex items-center justify-center bg-zinc-800 p-2 text-xs text-zinc-300 aspect-[5/7] rounded-md">
                  {dragOverlayCard.cardName}
                </div>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Basic Lands Dialog */}
      {showBasicLands && (
        <BasicLandsDialog
          basicLands={state.basicLands}
          onSave={handleSetBasics}
          onClose={() => setShowBasicLands(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "Add DeckBuilderPanel with toolbar, zones, drag-and-drop, and share"
```

---

## Chunk 4: Integration

### Task 11: Modify CardNameCell and CardTable for Speculative Adds

**Files:**
- Modify: `src/app/components/CardNameCell.tsx`
- Modify: `src/app/components/CardTable.tsx`

- [ ] **Step 1: Add `+` button to CardNameCell**

In `src/app/components/CardNameCell.tsx`, update the props and render:

Change the component signature to accept an optional `onAddSpeculative` callback and an `isInDeckBuilder` boolean:

```typescript
interface CardNameCellProps {
  card: EnrichedCardStats;
  onAddSpeculative?: (cardName: string) => void;
  isInDeckBuilder?: boolean;
}

export function CardNameCell({ card, onAddSpeculative, isInDeckBuilder }: CardNameCellProps) {
```

Add the `+` button after the card name `<span>` inside the `flex` div:

```typescript
<span className="font-medium text-zinc-900 dark:text-zinc-100">{card.cardName}</span>
{onAddSpeculative && !isInDeckBuilder && (
  <button
    onClick={(e) => {
      e.stopPropagation();
      onAddSpeculative(card.cardName);
    }}
    className="ml-1 flex h-5 w-5 items-center justify-center rounded bg-zinc-200 text-xs font-bold text-zinc-600 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-blue-500 hover:text-white dark:bg-zinc-700 dark:text-zinc-400"
    title="Add to deck builder"
  >
    +
  </button>
)}
{isInDeckBuilder && (
  <span className="ml-1 h-2 w-2 rounded-full bg-blue-500 shrink-0" title="In deck builder" />
)}
```

Update the outer `<div>` to include a group class for hover effects:

```typescript
<div className="relative group/row" ref={cellRef}>
```

- [ ] **Step 2: Pass callbacks through CardTable**

In `src/app/components/CardTable.tsx`, add `onAddSpeculative` and `deckBuilderCardNames` to the props interface:

```typescript
interface CardTableProps {
  // ... existing props
  onAddSpeculative?: (cardName: string) => void;
  deckBuilderCardNames?: Set<string>;
}
```

Thread these through to the `CardNameCell` in the column definition for the card name column. Find where `CardNameCell` is rendered in the column definitions and pass the new props. Also add `onAddSpeculative` and `deckBuilderCardNames` to the `columns` `useMemo` dependency array so the column definitions update when these props change:

```typescript
cell: ({ row }) => (
  <CardNameCell
    card={row.original}
    onAddSpeculative={onAddSpeculative}
    isInDeckBuilder={deckBuilderCardNames?.has(row.original.cardName)}
  />
),
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/components/CardNameCell.tsx src/app/components/CardTable.tsx
git commit -m "Add speculative pick button and deck builder indicator to card table"
```

---

### Task 12: Wire DeckBuilderPanel into PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Add deck builder state and rendering to PageClient**

Add/update imports at the top of `PageClient.tsx`:

```typescript
import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { DeckBuilderPanel } from "./deck-builder/DeckBuilderPanel";
import { useDeckBuilder } from "../hooks/useDeckBuilder";
import type { ScryCard } from "@/core/types";
```

Inside the `PageClient` component, after existing hooks, add deck builder state:

```typescript
const [showDeckBuilder, setShowDeckBuilder] = useState(false);

// Build Scryfall data map for the deck builder
const scryfallDataMap = useMemo(() => {
  const map = new Map<string, ScryCard>();
  for (const card of cardData.cards) {
    if (card.scryfall) {
      map.set(card.cardName, card.scryfall);
    }
  }
  return map;
}, [cardData.cards]);

// Deck builder hook — only meaningful when an active draft and seat are selected
const deckBuilder = useDeckBuilder({
  draftId: draftSelection.activeDraft ?? "",
  seat: draftSelection.selectedSeat ?? 0,
});

// Collect card names in the deck builder for the table indicator
const deckBuilderCardNames = useMemo(() => {
  const names = new Set<string>();
  for (const zone of ["deck", "sideboard"] as const) {
    for (const cards of Object.values(deckBuilder.state.zones[zone])) {
      for (const name of cards) {
        names.add(name);
      }
    }
  }
  return names;
}, [deckBuilder.state.zones]);

// Initialize deck builder from seat picks when first opened
const deckBuilderInitialized = useRef(false);
useEffect(() => {
  if (showDeckBuilder && seatCardNames.size > 0 && !deckBuilderInitialized.current) {
    // Only init if the deck builder state is empty (no localStorage state loaded)
    const isEmpty = Object.values(deckBuilder.state.zones.deck).flat().length === 0
      && Object.values(deckBuilder.state.zones.sideboard).flat().length === 0;
    if (isEmpty) {
      deckBuilder.dispatch({
        type: "INIT_FROM_PICKS",
        cardNames: Array.from(seatCardNames),
        scryfallData: scryfallDataMap,
      });
    }
    deckBuilderInitialized.current = true;
  }
  // Reset when deck builder is closed so it re-initializes on next open
  if (!showDeckBuilder) {
    deckBuilderInitialized.current = false;
  }
}, [showDeckBuilder, seatCardNames]); // eslint-disable-line react-hooks/exhaustive-deps

// Handler for adding speculative picks from the card table
const handleAddSpeculative = useCallback(
  (cardName: string) => {
    deckBuilder.dispatch({
      type: "ADD_SPECULATIVE",
      cardName,
      scryfallData: scryfallDataMap,
    });
  },
  [deckBuilder, scryfallDataMap]
);
```

Add a "Deck Builder" toggle button in the controls section (the `<div className="mb-6 flex flex-wrap items-center gap-4">` div), before the ActiveDraftIndicator:

```typescript
{draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
  <button
    onClick={() => setShowDeckBuilder((prev) => !prev)}
    className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      showDeckBuilder
        ? "bg-blue-600 text-white"
        : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600"
    }`}
  >
    {showDeckBuilder ? "Hide Deck Builder" : "Deck Builder"}
  </button>
)}
```

Render the DeckBuilderPanel above the CardTable, inside the same container. Before the `{searchFilteredCards.length > 0 ? (` block, add:

```typescript
{showDeckBuilder && draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
  <div className="mb-6">
    <DeckBuilderPanel
      state={deckBuilder.state}
      dispatch={deckBuilder.dispatch}
      scryfallData={scryfallDataMap}
      draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name ?? draftSelection.activeDraft}
      onClose={() => setShowDeckBuilder(false)}
    />
  </div>
)}
```

Update the `<CardTable>` to pass through the new props:

```typescript
<CardTable
  cards={searchFilteredCards}
  colorFilter={search.colorFilter}
  colorFilterMode={search.colorFilterMode}
  currentCubeCopies={displayedCubeCopies}
  takenCardNames={takenCardNamesSet}
  seatCardNames={seatCardNames}
  onAddSpeculative={showDeckBuilder ? handleAddSpeculative : undefined}
  deckBuilderCardNames={showDeckBuilder ? deckBuilderCardNames : undefined}
/>
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Wire deck builder panel into PageClient with toggle and speculative adds"
```

---

### Task 13: Shared Deck Landing Page

**Files:**
- Create: `src/app/deck/[id]/page.tsx`

- [ ] **Step 1: Implement the server component page**

Create `src/app/deck/[id]/page.tsx`:

```typescript
import { notFound } from "next/navigation";
import { getSharedDeck } from "@/core/db/queries/sharedDecks";
import { getCards } from "@/core/getCards";
import { SharedDeckClient } from "./SharedDeckClient";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SharedDeckPage({ params }: Props) {
  const { id } = await params;
  const sharedDeck = await getSharedDeck(id);

  if (!sharedDeck) {
    notFound();
  }

  const cardData = await getCards({
    draftIds: [sharedDeck.draftId],
  });

  return (
    <SharedDeckClient
      deckState={sharedDeck.deckState}
      cardData={cardData}
      deckId={id}
    />
  );
}
```

- [ ] **Step 2: Create the client component**

Create `src/app/deck/[id]/SharedDeckClient.tsx`:

```typescript
"use client";

import { useMemo, useEffect } from "react";
import { DeckBuilderPanel } from "@/app/components/deck-builder/DeckBuilderPanel";
import { useDeckBuilder } from "@/app/hooks/useDeckBuilder";
import type { DeckState, ScryCard } from "@/core/types";
import type { CardStatsResponse } from "@/core/getCards";

interface SharedDeckClientProps {
  deckState: DeckState;
  cardData: CardStatsResponse;
  deckId: string;
}

export function SharedDeckClient({
  deckState,
  cardData,
  deckId,
}: SharedDeckClientProps) {
  const deckBuilder = useDeckBuilder({
    draftId: deckState.draftId,
    seat: deckState.seat,
  });

  // Load snapshot into reducer on mount if state is empty (fork-on-edit)
  useEffect(() => {
    const isEmpty = Object.values(deckBuilder.state.zones.deck).flat().length === 0
      && Object.values(deckBuilder.state.zones.sideboard).flat().length === 0;
    if (isEmpty) {
      deckBuilder.dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const scryfallDataMap = useMemo(() => {
    const map = new Map<string, ScryCard>();
    for (const card of cardData.cards) {
      if (card.scryfall) {
        map.set(card.cardName, card.scryfall);
      }
    }
    return map;
  }, [cardData.cards]);

  const draftName =
    cardData.draftMetadata[deckState.draftId]?.name ?? deckState.draftId;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">
            Shared Deck — {draftName}, Seat {deckState.seat}
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Viewing deck <code className="text-xs">{deckId}</code>. Edits create
            a local fork — share again to get a new link.
          </p>
        </header>
        <DeckBuilderPanel
          state={deckBuilder.state}
          dispatch={deckBuilder.dispatch}
          scryfallData={scryfallDataMap}
          draftName={draftName}
          onClose={() => window.history.back()}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/app/deck/\[id\]/page.tsx src/app/deck/\[id\]/SharedDeckClient.tsx
git commit -m "Add shared deck landing page with fork-on-edit behavior"
```

---

### Task 14: Quality Checks and Final Verification

- [ ] **Step 1: Run full precommit suite**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, and tests all pass

- [ ] **Step 2: Fix any lint/knip issues**

Address any unused exports, missing imports, or lint warnings.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`

1. Open the app, select an active draft and seat
2. Click "Deck Builder" button — panel should appear above card table
3. Cards should be sorted into CMC columns in the sideboard
4. Drag cards from sideboard to deck zone
5. Click `+` on a card table row — it should appear in the sideboard with dashed border
6. Click "Add Basic Lands", add some lands, save
7. Click "Share Deck" — URL should be copied to clipboard
8. Open the shared URL in a new tab — deck should render
9. Close dev server

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "Fix lint/knip issues from deck builder integration"
```
