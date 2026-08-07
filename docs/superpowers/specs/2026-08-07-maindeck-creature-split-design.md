# Maindeck Creature / Non-Creature Split — Design

**Date:** 2026-08-07
**Status:** Approved

## Problem

The deck builder renders each zone (`sideboard`, `deck`) as a single row of
seven columns bucketed by mana value (`mv-0-1` … `mv-6+`, `lands`). Every
maindeck card — creatures and spells alike — shares one stack per column, so
the creature curve, which is the number a drafter actually reads while
building, is invisible.

Conventional MTG deckbuilders (Cockatrice, CubeCobra, MTGO) split the maindeck
into a creature row and a non-creature row over the same mana-value columns.
This adds that split.

## Goals

- Split the **maindeck** into two rows: creatures on top, non-creatures below.
- Non-creatures default to the bottom row; **a card the user moves stays where
  they put it**, exactly as mana-value column placement already sticks.
- Works for both live drafts (server-persisted via `/api/drafts/[id]/deck-state`)
  and sheet drafts (localStorage), plus shared deck snapshots (`/api/deck`).
- Existing decks — WIP rows in Turso, localStorage blobs, and old shared
  snapshots — get their non-creatures moved down once, automatically.

## Non-goals

- Splitting the **sideboard**. It stays a single row of seven columns.
- A DB schema change. `decks.deck_state` is a JSON blob; only its shape moves.
- Reclassifying cards on every load. Classification is a one-time default;
  after that, position is user data.

## Design

### 1. Rows are encoded in the column key

The persisted shape (`DeckState.zones.<zone>: Record<string, string[]>`) does
not change. The maindeck's key space doubles instead:

| Key set | Keys | Used by |
|---|---|---|
| `MANA_VALUE_COLUMN_KEYS` | `mv-0-1`, `mv-2`, `mv-3`, `mv-4`, `mv-5`, `mv-6+` | **creature row** of the deck zone |
| `NONCREATURE_COLUMN_KEYS` | the same six, prefixed `nc-` | **non-creature row** of the deck zone |
| `lands` | — | the deck zone's single shared lands column; also the sideboard's |
| `BASE_COLUMN_KEYS` | the six mana values plus `lands` | the sideboard zone, which is not split at all |

`DECK_COLUMN_KEYS = [...MANA_VALUE, ...NONCREATURE, "lands"]` (13).
`columnKeysForZone(zone)` returns the right list.

**Lands are outside the split.** A deck has one lands column, not one per row —
splitting a mana curve by creature-ness is meaningful, splitting a mana base by
it is not. It renders beside the two rows, spanning both.

**Why encode the row in the key rather than nesting `zones.deck.creatures` /
`zones.deck.noncreatures`?** Because it is how mana-value stickiness already
works. A card's column is not derived on render — it is *stored*, defaulted
once from Scryfall data and thereafter treated as user intent. The row is the
same kind of fact, so it belongs in the same slot. Nesting would change
`DeckState`, `ColumnMap`, every reducer case, the drag-id grammar, the
validator, and both persistence paths, to express something the flat key space
already expresses.

The `nc-` prefix uses a hyphen, not a colon: drag ids are
`` `${zone}:${column}:${index}:${name}` `` and `parseDragId` splits on `:`, so a
colon in a column key would corrupt parsing. With a hyphen, **the entire drag
and drop layer needs no changes.**

### 2. Default placement

```ts
isCreatureCard(scry)   =>  scry.typeLine.toLowerCase().includes("creature")
getDeckColumnKey(scry) =>  getColumnKey(scry) === "lands"
                             ? "lands"
                             : isCreatureCard(scry) ? getColumnKey(scry) : `nc-${getColumnKey(scry)}`
```

`getColumnKey` (mana-value bucketing, land-first) is unchanged; the row is an
orthogonal decision layered on top of the non-land columns. Consequences worth
stating:

- Basic lands and ordinary lands → `lands`.
- A creature-land (Dryad Arbor) or an MDFC whose front face is a creature
  (Kazandu Mammoth) → `lands` too. Because the lands column sits outside the
  split, "is it a creature?" never has to be asked about a card that is also a
  land, and the awkward case disappears rather than needing a rule.
- A card with no Scryfall data keeps today's fallback, `mv-0-1` (creature row).
  We cannot classify what we cannot type-line.

Each row therefore renders six columns, with the lands column beside them.

Only `REBUILD`'s "add missing canonical cards" pass uses `getDeckColumnKey`;
cards already present in a zone are never re-placed. That is the stickiness.

### 3. Migrating existing decks

Structural normalization (`migrateDeckState`) runs on every read path —
`getWipDeck`, `getSnapshot`, `loadLocalDeckState` — but it has **no Scryfall
data**, so it cannot tell a creature from a spell. Row classification therefore
cannot live there. It splits in two:

**Structural (`migrateDeckState`, no card data).** Becomes zone-aware: the deck
zone is normalized to all 14 keys, the sideboard to its 7. Legacy `cmc-*` keys
still rename to `mv-*`. An `nc-*` key found in the *sideboard* (only reachable
via a client rollback) has its prefix stripped and merges into the base column,
rather than becoming an unrenderable — and therefore invisible — stack.

**Semantic (`MIGRATE_ROWS` reducer action, with card data).** A new
`DeckState.version?: number` field records the shape. `DECK_STATE_VERSION = 1`
means "rows split"; absent/`0` means pre-split. The action:

- returns `state` unchanged if `version === DECK_STATE_VERSION` — so it is a
  no-op on every load after the first;
- returns `state` unchanged if the Scryfall map is empty — otherwise a deck
  loaded before card data arrives would classify every card as a non-creature
  and then mark itself migrated;
- otherwise walks the deck zone's six mana-value columns, moves known
  non-creatures to the matching `nc-` column preserving relative order, leaves
  creatures and unknown cards in place, and sets `version`. The `lands` column
  is never touched — it is outside the split.

`createEmptyDeckState` stamps the current version, so new decks are born
migrated.

Because a no-op returns the identical reference, `dispatchDeck` short-circuits
before touching the `justHydrated` flag or marking the state dirty. Only a
*real* migration marks dirty — which is what persists it, through whichever
path the draft already uses (PUT for live, localStorage for sheet).

### 4. Where the migration is dispatched

`syncDeckWithPicks` already fires on every input that could matter (deck
builder activation, `seatCardList`, floats, queue, `mySeat`). It dispatches
`MIGRATE_ROWS` before `REBUILD`.

Two adjustments:

- It currently returns early when `viewingSharedDeck`. Shared snapshots are
  immutable and must not be rebuilt from picks — but a pre-split snapshot still
  needs its rows. So the shared-view branch dispatches `MIGRATE_ROWS` and then
  returns without `REBUILD`. `dispatchDeck` already refuses to persist while
  `viewingSharedDeck`, so this stays read-only.
- A subscription on `cardStore.scryfallDataMap` is added, so a deck opened
  before card data lands still migrates the moment it arrives.

### 5. Validation

`validateDeckState` becomes zone-aware: `deck` accepts `DECK_COLUMN_KEYS`,
`sideboard` accepts `BASE_COLUMN_KEYS` only. Rejecting `nc-*` in the sideboard
is deliberate — the sideboard renders seven columns, so an `nc-*` stack there
would be silently unreachable. `version`, if present, must be a non-negative
integer. The 100-card cap is unchanged.

An older client can still PUT a base-key-only deck (a valid subset), and a
client that has not shipped the split will relocate unknown `nc-*` keys to
`mv-0-1` via the existing `migrateDeckState` fallback. Rollback loses the row
arrangement but never cards.

### 6. Rendering

`DeckZone` renders a list of rows instead of one grid:

- `zone === "deck"` → a `grid-cols-7` whose first child spans six columns and
  stacks the `Creatures` and `Non-Creatures` rows (each an inner `grid-cols-6`,
  separated by a hairline rule, each with a small row label and count), and
  whose second child is the full-height `lands` column.
- `zone === "sideboard"` → one unlabeled `grid-cols-7`, exactly as today.

The column widths line up exactly, without arithmetic: a child spanning six of
seven columns also spans the five outer gaps between them, so an inner
`grid-cols-6` at the same gap size resolves to the identical column width.

Per-column headers repeat in both rows, so each row shows its own curve — the
point of the feature. The lands column stretches to the height of both rows, so
it reads as one thing beside them rather than as a third row. The zone header
(total, picked/floated/queued, `c·s·l` counts) is unchanged and still spans the
whole zone.

The floated/queued instance-index scans switch from the fixed `COLUMN_KEYS`
list to `columnKeysForZone(zone)`. Their index keys (`` `${columnKey}:${idx}` ``)
stay unique across rows because the column keys differ.

`DeckColumn` and `DeckCard` need no changes.

## Risks

- **Reclassification is destructive of intent for pre-split decks.** Everything
  in a pre-split maindeck was placed under the old model, so there is no way to
  distinguish "user deliberately put this spell in the top row" from "there was
  no other row". Moving them is the only useful reading.
- **A pre-split shared snapshot viewed with no Scryfall data loaded** renders
  in the legacy single-row layout until data arrives; the added subscription
  closes this within one poll.
