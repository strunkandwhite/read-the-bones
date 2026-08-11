import type { BasicLandCounts, ColumnMap, DeckState, ScryCard } from "./types";
import { isLand } from "./cardTypes";

/** The ordered mana-value columns. The deck zone repeats these once per row;
 *  the lands column stands outside them. */
export const MANA_VALUE_COLUMN_KEYS = ["mv-0-1", "mv-2", "mv-3", "mv-4", "mv-5", "mv-6+"] as const;

export type ManaValueColumnKey = (typeof MANA_VALUE_COLUMN_KEYS)[number];

/** The full set of columns in a single-row zone: the sideboard's key set, and
 *  what mana-value bucketing alone ever produces. */
export const BASE_COLUMN_KEYS = [...MANA_VALUE_COLUMN_KEYS, "lands"] as const;

export type ColumnKey = (typeof BASE_COLUMN_KEYS)[number];

/** Marks a deck-zone column as belonging to the non-creature row. The
 *  separator is a hyphen rather than a colon because drag ids are
 *  `${zone}:${column}:${index}:${name}` and are parsed by splitting on ":". */
const NONCREATURE_PREFIX = "nc-";

export type NoncreatureColumnKey = `${typeof NONCREATURE_PREFIX}${ManaValueColumnKey}`;

export type DeckColumnKey = ColumnKey | NoncreatureColumnKey;

/** The non-creature row's column for a given mana-value column. */
export function toNoncreatureColumnKey(key: ManaValueColumnKey): NoncreatureColumnKey {
  return `${NONCREATURE_PREFIX}${key}`;
}

/** The mana-value column a key refers to, whichever row it names.
 *  Returns null for keys that are not columns at all. */
export function toBaseColumnKey(key: string): ColumnKey | null {
  const withoutPrefix = key.startsWith(NONCREATURE_PREFIX)
    ? key.slice(NONCREATURE_PREFIX.length)
    : key;
  return (BASE_COLUMN_KEYS as readonly string[]).includes(withoutPrefix)
    ? (withoutPrefix as ColumnKey)
    : null;
}

export const NONCREATURE_COLUMN_KEYS: readonly NoncreatureColumnKey[] =
  MANA_VALUE_COLUMN_KEYS.map(toNoncreatureColumnKey);

/** The deck zone's columns: a creature row and a non-creature row over the
 *  mana values, plus one lands column shared by both rows. */
export const DECK_COLUMN_KEYS: readonly DeckColumnKey[] = [
  ...MANA_VALUE_COLUMN_KEYS,
  ...NONCREATURE_COLUMN_KEYS,
  "lands",
];

/** The columns a zone can hold. Only the maindeck is split into two rows. */
export function columnKeysForZone(zone: "deck" | "sideboard"): readonly DeckColumnKey[] {
  return zone === "deck" ? DECK_COLUMN_KEYS : BASE_COLUMN_KEYS;
}

/** Shape marker for `DeckState.version`: 1 means the maindeck's non-creatures
 *  have been sorted into their own row. Absent means the state predates the
 *  split and still needs that one-time pass. */
export const DECK_STATE_VERSION = 1;

const LEGACY_KEY_MAP: [string, ColumnKey][] = [
  ["cmc-0-1", "mv-0-1"],
  ["cmc-2", "mv-2"],
  ["cmc-3", "mv-3"],
  ["cmc-4", "mv-4"],
  ["cmc-5", "mv-5"],
  ["cmc-6+", "mv-6+"],
];

/** Migrate and normalize a persisted DeckState's zones to the canonical shape:
 *  legacy cmc-* keys are renamed to mv-*, all canonical columns are present,
 *  and cards stored under unrecognized column keys are relocated to "mv-0-1"
 *  (the same fallback used when a card has no Scryfall data). Persisted states
 *  predate the PUT validator's column check, so reads can't assume canonical
 *  keys — and the deck reducer requires every canonical column to exist.
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

  const isCanonical = (zone: Record<string, string[]>, keys: readonly DeckColumnKey[]): boolean =>
    keys.every((key) => Array.isArray(zone[key])) &&
    Object.keys(zone).every((key) => (keys as readonly string[]).includes(key));

  if (
    isCanonical(cleaned.zones.deck, DECK_COLUMN_KEYS) &&
    isCanonical(cleaned.zones.sideboard, BASE_COLUMN_KEYS)
  ) {
    return cleaned;
  }

  const normalizeZone = (
    zoneName: "deck" | "sideboard",
    zone: Record<string, string[]>
  ): Record<string, string[]> => {
    const keys = columnKeysForZone(zoneName);
    const normalized = createEmptyColumnMap(zoneName);
    for (const [key, cards] of Object.entries(zone)) {
      if (!Array.isArray(cards)) continue;
      const rename = LEGACY_KEY_MAP.find(([old]) => old === key);
      const target = rename
        ? rename[1]
        : (keys as readonly string[]).includes(key)
          ? (key as DeckColumnKey)
          : // A non-creature-row key can still turn up where no such row is
            // rendered — in the sideboard, or as "nc-lands" from a client that
            // predates the shared lands column. Merging it into its mana-value
            // column keeps those cards visible rather than stranding them in a
            // stack nothing draws.
            (toBaseColumnKey(key) ?? "mv-0-1");
      normalized[target].push(...cards);
    }
    return normalized;
  };

  return {
    ...cleaned,
    zones: {
      deck: normalizeZone("deck", cleaned.zones.deck),
      sideboard: normalizeZone("sideboard", cleaned.zones.sideboard),
    },
  };
}

const BASIC_LAND_NAMES = ["Plains", "Island", "Swamp", "Mountain", "Forest"] as const;

/** Determine which column a card belongs in based on its Scryfall data. */
export function getColumnKey(scryfall: ScryCard): ColumnKey {
  if (isLand(scryfall.typeLine)) {
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

/** Whether a card belongs in the maindeck's creature row. */
export function isCreatureCard(scryfall: ScryCard): boolean {
  return scryfall.typeLine.toLowerCase().includes("creature");
}

/** Determine the deck-zone column a card defaults to. The lands column is
 *  shared by both rows, so only cards in a mana-value column are sorted by
 *  type — a creature-land such as Dryad Arbor stays with the other lands. */
export function getDeckColumnKey(scryfall: ScryCard): DeckColumnKey {
  const column = getColumnKey(scryfall);
  if (column === "lands") return column;
  return isCreatureCard(scryfall) ? column : toNoncreatureColumnKey(column);
}

/** Create a ColumnMap with every column of the given zone initialized to an
 *  empty array. */
export function createEmptyColumnMap(zone: "deck" | "sideboard"): ColumnMap {
  const map: ColumnMap = {};
  for (const key of columnKeysForZone(zone)) {
    map[key] = [];
  }
  return map;
}

/** Assign card names to columns based on their Scryfall data. Placement is by
 *  mana value alone, so the result only ever uses the base column keys — the
 *  sideboard's key set. */
export function assignCardsToColumns(
  cardNames: string[],
  scryfallData: Map<string, ScryCard>
): ColumnMap {
  const columns = createEmptyColumnMap("sideboard");
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
    version: DECK_STATE_VERSION,
    zones: {
      deck: createEmptyColumnMap("deck"),
      sideboard: createEmptyColumnMap("sideboard"),
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

/** Generate a 16-character random hex ID (~64 bits of entropy).
 *  Existing 8-char IDs in the DB continue to resolve — lookups are by exact
 *  string match with no length constraint. */
export function generateDeckId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export type DeckAction =
  | {
      type: "REBUILD";
      canonicalCards: string[];
      scryfallData: Map<string, ScryCard>;
    }
  | {
      type: "MIGRATE_ROWS";
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
          const col = scry ? getDeckColumnKey(scry) : "mv-0-1";
          for (let i = 0; i < toAdd; i++) {
            (next.zones.deck[col] ??= []).push(name);
          }
        }
      }

      // Check if anything actually changed (avoid unnecessary saves)
      const changed = JSON.stringify(next.zones) !== JSON.stringify(state.zones);
      return changed ? next : state;
    }

    case "MIGRATE_ROWS": {
      if (state.version === DECK_STATE_VERSION) return state;
      // Without card data every card looks like a non-creature, so a deck
      // opened before Scryfall data arrives would sweep its whole maindeck into
      // the bottom row and then stamp itself as migrated. Wait for the data.
      if (action.scryfallData.size === 0) return state;

      const next = structuredClone(state);
      // The lands column is outside both rows, so nothing in it needs sorting.
      for (const key of MANA_VALUE_COLUMN_KEYS) {
        const cards = next.zones.deck[key];
        if (!cards) continue;
        const stayingCards: string[] = [];
        const movingCards: string[] = [];
        for (const name of cards) {
          const scry = action.scryfallData.get(name);
          const isNoncreature =
            BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number]) ||
            (scry !== undefined && !isCreatureCard(scry));
          (isNoncreature ? movingCards : stayingCards).push(name);
        }
        if (movingCards.length === 0) continue;
        next.zones.deck[key] = stayingCards;
        (next.zones.deck[toNoncreatureColumnKey(key)] ??= []).push(...movingCards);
      }
      next.version = DECK_STATE_VERSION;
      return next;
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
      const lands = (next.zones.deck["lands"] ?? []).filter(
        (name) => !BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number])
      );
      // Add new basic land entries based on counts
      for (const land of BASIC_LAND_NAMES) {
        for (let i = 0; i < action.basics[land]; i++) {
          lands.push(land);
        }
      }
      next.zones.deck["lands"] = lands;
      return next;
    }

    case "CLEAR_DECK": {
      const next = structuredClone(state);
      // Move all deck cards to sideboard
      for (const col of Object.keys(next.zones.deck)) {
        const cards = next.zones.deck[col];
        // Skip basic lands — they get removed, not moved to sideboard
        const nonBasics = cards.filter(
          (name) => !BASIC_LAND_NAMES.includes(name as (typeof BASIC_LAND_NAMES)[number])
        );
        // The sideboard is a single row, so a card sitting in the maindeck's
        // non-creature row lands in the matching mana-value column.
        next.zones.sideboard[toBaseColumnKey(col) ?? col].push(...nonBasics);
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
