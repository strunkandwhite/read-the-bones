import type {
  BasicLandCounts,
  ColumnMap,
  DeckState,
  ScryCard,
} from "./types";

/** The ordered list of column keys for deck builder zones. */
export const COLUMN_KEYS = [
  "mv-0-1",
  "mv-2",
  "mv-3",
  "mv-4",
  "mv-5",
  "mv-6+",
  "lands",
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

const LEGACY_KEY_MAP: [string, ColumnKey][] = [
  ["cmc-0-1", "mv-0-1"],
  ["cmc-2", "mv-2"],
  ["cmc-3", "mv-3"],
  ["cmc-4", "mv-4"],
  ["cmc-5", "mv-5"],
  ["cmc-6+", "mv-6+"],
];

/** Migrate legacy cmc-* column keys to mv-* in a persisted DeckState.
 *  Also strips the deprecated `speculativeCards` field from old snapshots. */
export function migrateDeckState(state: DeckState & { speculativeCards?: unknown }): DeckState {
  // Strip deprecated speculativeCards from persisted data
  let cleaned: DeckState;
  if ("speculativeCards" in state) {
    const { speculativeCards: _, ...rest } = state;
    void _;
    cleaned = rest;
  } else {
    cleaned = state;
  }

  const needsMigration = Object.keys(cleaned.zones.deck).some((k) => k.startsWith("cmc-"));
  if (!needsMigration) return cleaned;

  const migrateZone = (zone: Record<string, string[]>): Record<string, string[]> => {
    const migrated: Record<string, string[]> = {};
    for (const [key, cards] of Object.entries(zone)) {
      const rename = LEGACY_KEY_MAP.find(([old]) => old === key);
      migrated[rename ? rename[1] : key] = cards;
    }
    return migrated;
  };

  return {
    ...cleaned,
    zones: {
      deck: migrateZone(cleaned.zones.deck),
      sideboard: migrateZone(cleaned.zones.sideboard),
    },
  };
}

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
  if (mv <= 1) return "mv-0-1";
  if (mv === 2) return "mv-2";
  if (mv === 3) return "mv-3";
  if (mv === 4) return "mv-4";
  if (mv === 5) return "mv-5";
  return "mv-6+";
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
    const key = scry ? getColumnKey(scry) : "mv-0-1";
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
      type: "REBUILD";
      canonicalCards: string[];
      scryfallData: Map<string, ScryCard>;
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
    };

/** Reducer for deck builder state. */
export function deckReducer(state: DeckState, action: DeckAction): DeckState {
  switch (action.type) {
    case "REBUILD": {
      // Build canonical card counts
      const canonicalCounts = new Map<string, number>();
      for (const name of action.canonicalCards) {
        canonicalCounts.set(name, (canonicalCounts.get(name) || 0) + 1);
      }

      const next = structuredClone(state);

      // Pass 1: Walk existing zones, keep only canonical cards (respecting counts)
      const keptCounts = new Map<string, number>();
      for (const zone of ["deck", "sideboard"] as const) {
        for (const [col, cards] of Object.entries(next.zones[zone])) {
          next.zones[zone][col] = cards.filter((name) => {
            // Always keep basic lands (they're user-added, not from picks)
            if (BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number])) return true;
            const kept = keptCounts.get(name) || 0;
            const needed = canonicalCounts.get(name) || 0;
            if (kept < needed) {
              keptCounts.set(name, kept + 1);
              return true;
            }
            return false; // remove — not canonical or excess copy
          });
        }
      }

      // Pass 2: Add missing canonical cards to deck at default column
      for (const [name, needed] of canonicalCounts) {
        const kept = keptCounts.get(name) || 0;
        const toAdd = needed - kept;
        if (toAdd > 0) {
          const scry = action.scryfallData.get(name);
          const col = scry ? getColumnKey(scry) : "mv-0-1";
          for (let i = 0; i < toAdd; i++) {
            next.zones.deck[col].push(name);
          }
        }
      }

      // Check if anything actually changed (avoid unnecessary saves)
      const changed = JSON.stringify(next.zones) !== JSON.stringify(state.zones);
      return changed ? next : state;
    }

    case "MOVE_CARD": {
      const next = structuredClone(state);
      const fromCol = next.zones[action.fromZone][action.fromColumn];
      const idx = fromCol.indexOf(action.cardName);
      if (idx === -1) return state;
      fromCol.splice(idx, 1);
      const toCol = next.zones[action.toZone][action.toColumn];
      toCol.splice(action.toIndex, 0, action.cardName);

      // Keep basicLands count in sync when basics move between zones
      if (
        action.fromZone !== action.toZone &&
        BASIC_LAND_NAMES.includes(action.cardName as (typeof BASIC_LAND_NAMES)[number])
      ) {
        const landName = action.cardName as keyof BasicLandCounts;
        if (action.fromZone === "deck") {
          next.basicLands[landName] = Math.max(0, next.basicLands[landName] - 1);
        } else {
          next.basicLands[landName] += 1;
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
