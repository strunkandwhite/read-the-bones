import type {
  BasicLandCounts,
  ColumnMap,
  DeckState,
  ScryCard,
} from "./types";

/** The ordered list of column keys for deck builder zones. */
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

const BASIC_LAND_NAMES = [
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
] as const;

/** Determine which column a card belongs in based on its Scryfall data. */
export function getColumnKey(scryfall: ScryCard): ColumnKey {
  if (scryfall.typeLine.toLowerCase().includes("land")) {
    return "lands";
  }
  const mv = scryfall.manaValue;
  if (mv <= 1) return "cmc-0-1";
  if (mv === 2) return "cmc-2";
  if (mv === 3) return "cmc-3";
  if (mv === 4) return "cmc-4";
  if (mv === 5) return "cmc-5";
  return "cmc-6+";
}

/** Create a ColumnMap with all 7 columns initialized to empty arrays. */
export function createEmptyColumnMap(): ColumnMap {
  const map: ColumnMap = {};
  for (const key of COLUMN_KEYS) {
    map[key] = [];
  }
  return map;
}

/** Assign card names to columns based on their Scryfall data. */
export function assignCardsToColumns(
  cardNames: string[],
  scryfallData: Map<string, ScryCard>,
): ColumnMap {
  const columns = createEmptyColumnMap();
  for (const name of cardNames) {
    const scry = scryfallData.get(name);
    const key = scry ? getColumnKey(scry) : "cmc-0-1";
    columns[key].push(name);
  }
  return columns;
}

/** Create a fresh empty DeckState for a given draft and seat. */
export function createEmptyDeckState(draftId: string, seat: number): DeckState {
  return {
    draftId,
    seat,
    zones: {
      deck: createEmptyColumnMap(),
      sideboard: createEmptyColumnMap(),
    },
    speculativeCards: [],
    basicLands: {
      Plains: 0,
      Island: 0,
      Swamp: 0,
      Mountain: 0,
      Forest: 0,
    },
  };
}

/** Generate an 8-character random alphanumeric ID. */
export function generateDeckId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export type DeckAction =
  | {
      type: "INIT_FROM_PICKS";
      picks: string[];
      scryfallData: Map<string, ScryCard>;
      draftId: string;
      seat: number;
    }
  | {
      type: "MOVE_CARD";
      cardName: string;
      fromZone: "deck" | "sideboard";
      toZone: "deck" | "sideboard";
      fromColumn: string;
      toColumn: string;
      toIndex: number;
    }
  | {
      type: "ADD_SPECULATIVE";
      cardName: string;
      scryfallData: Map<string, ScryCard>;
      maxCopies?: number;
    }
  | {
      type: "REMOVE_SPECULATIVE";
      cardName: string;
    }
  | {
      type: "SET_BASICS";
      basics: BasicLandCounts;
      scryfallData: Map<string, ScryCard>;
    }
  | {
      type: "CLEAR_DECK";
      scryfallData: Map<string, ScryCard>;
    }
  | {
      type: "INIT_FROM_SNAPSHOT";
      snapshot: DeckState;
    }
  | {
      type: "REORDER_CARD";
      zone: "deck" | "sideboard";
      column: string;
      fromIndex: number;
      toIndex: number;
    }
  | {
      type: "SYNC_PICKS";
      pickedCardNames: string[];
      takenCardNames?: string[];
      scryfallData: Map<string, ScryCard>;
    };

/** Reducer for deck builder state. */
export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "INIT_FROM_PICKS": {
      const newState = createEmptyDeckState(action.draftId, action.seat);
      newState.zones.deck = assignCardsToColumns(
        action.picks,
        action.scryfallData,
      );
      return newState;
    }

    case "MOVE_CARD": {
      const next = structuredClone(state);
      const fromCol = next.zones[action.fromZone][action.fromColumn];
      const idx = fromCol.indexOf(action.cardName);
      if (idx === -1) return state;
      fromCol.splice(idx, 1);
      const toCol = next.zones[action.toZone][action.toColumn];
      toCol.splice(action.toIndex, 0, action.cardName);
      return next;
    }

    case "ADD_SPECULATIVE": {
      const maxCopies = action.maxCopies ?? 1;
      // Count how many copies are already in all zones + speculative
      const allCards = [
        ...Object.values(state.zones.deck).flat(),
        ...Object.values(state.zones.sideboard).flat(),
      ];
      const currentCount = allCards.filter((c) => c === action.cardName).length;
      if (currentCount >= maxCopies) return state;
      const next = structuredClone(state);
      next.speculativeCards.push(action.cardName);
      const scry = action.scryfallData.get(action.cardName);
      const col = scry ? getColumnKey(scry) : "cmc-0-1";
      next.zones.deck[col].push(action.cardName);
      return next;
    }

    case "REMOVE_SPECULATIVE": {
      if (!state.speculativeCards.includes(action.cardName)) return state;
      const next = structuredClone(state);
      // Remove one instance from speculativeCards (supports multiples)
      const specIdx = next.speculativeCards.indexOf(action.cardName);
      if (specIdx !== -1) next.speculativeCards.splice(specIdx, 1);
      // Remove from whichever zone it's in
      for (const zone of ["deck", "sideboard"] as const) {
        for (const col of Object.keys(next.zones[zone])) {
          const arr = next.zones[zone][col];
          const idx = arr.indexOf(action.cardName);
          if (idx !== -1) {
            arr.splice(idx, 1);
            return next;
          }
        }
      }
      return next;
    }

    case "SET_BASICS": {
      const next = structuredClone(state);
      next.basicLands = { ...action.basics };
      // Remove old basic land entries from deck's lands column
      const landsCol = next.zones.deck["lands"];
      next.zones.deck["lands"] = landsCol.filter(
        (name) => !BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number]),
      );
      // Add new basic land entries based on counts
      for (const land of BASIC_LAND_NAMES) {
        for (let i = 0; i < action.basics[land]; i++) {
          next.zones.deck["lands"].push(land);
        }
      }
      return next;
    }

    case "CLEAR_DECK": {
      const next = structuredClone(state);
      // Move all deck cards to sideboard
      for (const col of Object.keys(next.zones.deck)) {
        const cards = next.zones.deck[col];
        // Skip basic lands — they get removed, not moved to sideboard
        const nonBasics = cards.filter(
          (name) => !BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number]),
        );
        next.zones.sideboard[col].push(...nonBasics);
        next.zones.deck[col] = [];
      }
      // Reset basic lands
      next.basicLands = {
        Plains: 0,
        Island: 0,
        Swamp: 0,
        Mountain: 0,
        Forest: 0,
      };
      return next;
    }

    case "INIT_FROM_SNAPSHOT": {
      return structuredClone(action.snapshot);
    }

    case "SYNC_PICKS": {
      // Count existing copies of each card across all zones
      const existingCounts = new Map<string, number>();
      for (const zone of ["deck", "sideboard"] as const) {
        for (const cards of Object.values(state.zones[zone])) {
          for (const name of cards) {
            existingCounts.set(name, (existingCounts.get(name) || 0) + 1);
          }
        }
      }
      let changed = false;
      let next: DeckState | null = null;

      // Count how many of each picked card we need
      const pickedCounts = new Map<string, number>();
      for (const cardName of action.pickedCardNames) {
        pickedCounts.set(cardName, (pickedCounts.get(cardName) || 0) + 1);
      }

      for (const [cardName, neededCount] of pickedCounts) {
        // Promote speculative → real (remove from speculativeCards, keep position)
        if (state.speculativeCards.includes(cardName)) {
          if (!next) next = structuredClone(state);
          next.speculativeCards = next.speculativeCards.filter((c) => c !== cardName);
          changed = true;
        }
        // Add missing copies to deck
        const currentCount = existingCounts.get(cardName) || 0;
        const toAdd = neededCount - currentCount;
        if (toAdd > 0) {
          if (!next) next = structuredClone(state);
          const scry = action.scryfallData.get(cardName);
          const col = scry ? getColumnKey(scry) : "cmc-0-1";
          for (let i = 0; i < toAdd; i++) {
            next.zones.deck[col].push(cardName);
          }
          existingCounts.set(cardName, neededCount);
          changed = true;
        }
      }

      // Remove speculative cards that were taken by other players
      if (action.takenCardNames) {
        const pickedSet = new Set(action.pickedCardNames);
        const takenSet = new Set(action.takenCardNames);
        const source = next ?? state;
        const speculativeToRemove = source.speculativeCards.filter(
          (c) => takenSet.has(c) && !pickedSet.has(c),
        );
        if (speculativeToRemove.length > 0) {
          if (!next) next = structuredClone(state);
          for (const cardName of speculativeToRemove) {
            // Remove one instance from speculativeCards
            const specIdx = next.speculativeCards.indexOf(cardName);
            if (specIdx !== -1) next.speculativeCards.splice(specIdx, 1);
            // Remove from whichever zone it's in
            for (const zone of ["deck", "sideboard"] as const) {
              for (const col of Object.keys(next.zones[zone])) {
                const arr = next.zones[zone][col];
                const idx = arr.indexOf(cardName);
                if (idx !== -1) {
                  arr.splice(idx, 1);
                  break;
                }
              }
            }
            changed = true;
          }
        }
      }

      return changed && next ? next : state;
    }

    case "REORDER_CARD": {
      const next = structuredClone(state);
      const col = next.zones[action.zone][action.column];
      const [card] = col.splice(action.fromIndex, 1);
      col.splice(action.toIndex, 0, card);
      return next;
    }
  }
}

function aggregateCardCounts(columns: Record<string, string[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const col of Object.values(columns)) {
    for (const name of col) {
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return counts;
}

export function formatDecklistText(state: DeckState): string {
  const deckCounts = aggregateCardCounts(state.zones.deck);
  const sideboardCounts = aggregateCardCounts(state.zones.sideboard);

  const lines: string[] = [];
  if (deckCounts.size > 0) {
    lines.push("Deck");
    for (const [name, count] of deckCounts) {
      lines.push(`${count} ${name}`);
    }
  }
  if (sideboardCounts.size > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Sideboard");
    for (const [name, count] of sideboardCounts) {
      lines.push(`${count} ${name}`);
    }
  }

  return lines.join("\n");
}
