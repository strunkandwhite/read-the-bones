# Deck Builder Design

A visual deck builder for constructing, organizing, and sharing Magic: The Gathering decks from a seat's drafted cards, inspired by [Sealed Deck](https://sealeddeck.tech).

## Overview

Users select a draft and seat, then build a 40-card deck from their picks. They can speculatively add unpicked cards from the cube to plan future picks. Decks can be shared via short URLs that create immutable snapshots.

## Layout

The deck builder appears as a panel **above the card table** in the same content column, splitting the vertical space roughly 50/50. Each half has its own scroll container. A toggle button opens/closes the deck builder; when closed, the card table reclaims the full height.

### Deck Builder Panel (top half)

Two zones, matching Sealed Deck's layout:

1. **Sideboard** (top) — cards in the pool not assigned to the main deck
2. **Deck** (bottom) — the 40-card main deck (typically ~23 spells + ~17 lands)

Both zones share a **fixed 7-column grid** (`grid-template-columns: repeat(7, 1fr)`):

| Column | Content |
|--------|---------|
| 1 | CMC 0–1 |
| 2 | CMC 2 |
| 3 | CMC 3 |
| 4 | CMC 4 |
| 5 | CMC 5 |
| 6 | CMC 6+ |
| 7 | Lands |

Columns are the same width in both zones even when one zone has no cards in a given column. This keeps the mana curve visually aligned across sideboard and deck.

Cards are displayed as **full Scryfall art tiles**, vertically stacked within their column.

### Card Table (bottom half)

The existing card table, unchanged except for a new `+` button on each card row to add speculative picks. Cards already in the deck builder show a subtle indicator (icon or muted styling).

### Top Toolbar

Sits above the sideboard zone:

- **← Card Table** (or close/toggle) — collapses the deck builder
- **Draft name + seat label** — context for what's being built
- **Add Basic Lands** — opens a dialog to add basic lands
- **Clear Deck** — resets deck to initial state (all picks in sideboard)
- **Share Deck** — creates a Turso snapshot and copies URL to clipboard

### Zone Headers

Each zone shows a summary line:

- **Sideboard: 14** — total count, plus "X picked · Y speculative" breakdown
- **Deck: 40** — total count, plus "Lands: 17 · Creatures: 14 · Other: 9 · Z speculative" breakdown

## Card Display

- **Picked cards**: Full art tile with solid border, colored by card color identity
- **Speculative cards**: Full art tile with **dashed border** and **reduced opacity** to visually distinguish from actual picks
- **Basic lands**: Appear in the Lands column of the deck zone. Basic land images are fetched from Scryfall by name (e.g., `https://api.scryfall.com/cards/named?exact=Forest&set=...`) and cached client-side

Column headers show the CMC value and card count (e.g., "3 ✦ 4").

## Interactions

### Drag and Drop

Powered by `@dnd-kit`. A single `DndContext` wraps both the deck builder and the card table.

- **Within a zone**: Drag cards between columns or reorder within a column
- **Between zones**: Drag cards from sideboard ↔ deck
- **From card table**: Drag a card row from the table into the deck builder to add it as a speculative pick. Use a `DragOverlay` to render a floating clone during the drag, avoiding DOM issues from dragging `<tr>` elements out of a `<table>`
- **Smart drop**: Dropping a card on a zone but not on a specific column places it in the CMC-appropriate default column

Users can also drag cards to any column regardless of CMC — the initial CMC assignment is a default, not a constraint. Column assignments persist.

### Speculative Card Adds

Two mechanisms to add unpicked cards from the cube:

1. **Drag from card table** — primary interaction, drag a row into the deck builder
2. **`+` button on card table rows** — fallback (accessibility, mobile), adds the card to the sideboard

Speculative cards can be removed by dragging them out of the deck builder or via a remove action.

Cards in the card table that have been added to the deck builder show a visual indicator.

### Add Basic Lands

A dialog (popover or small modal) with 5 rows — one per basic land type (Plains, Island, Swamp, Mountain, Forest) — each with `+`/`-` buttons and a count. Added basics appear in the deck's Lands column.

### Clear Deck

Moves all cards from the deck zone back to the sideboard and resets basic land counts. Does not remove speculative cards from the pool.

## Data Model

### `DeckState`

The single object representing a deck's complete state. Defined in `src/core/types.ts` (framework-agnostic, shared by API routes and client):

```typescript
type DeckState = {
  draftId: string
  seat: number
  zones: {
    deck: ColumnMap
    sideboard: ColumnMap
  }
  speculativeCards: string[]     // card names added from card table
  basicLands: BasicLandCounts   // { Plains: 0, Island: 2, ... }
}

type ColumnMap = Record<string, string[]>
// key = column id (e.g., "cmc-1", "cmc-2", "lands")
// value = ordered list of card names in that column

type BasicLandCounts = {
  Plains: number
  Island: number
  Swamp: number
  Mountain: number
  Forest: number
}
```

### Column Keys

The canonical column key set:

| Key | Content |
|-----|---------|
| `cmc-0-1` | CMC 0 and 1 |
| `cmc-2` | CMC 2 |
| `cmc-3` | CMC 3 |
| `cmc-4` | CMC 4 |
| `cmc-5` | CMC 5 |
| `cmc-6+` | CMC 6 and above |
| `lands` | All lands (drafted, speculative, and basic) |

### Initialization

When the deck builder is opened for a draft/seat with no saved state:

1. Fetch the seat's picks via a new query function `getSeatPicks(draftId, seat)` in `src/core/db/queries/picks.ts`, which returns card names for a specific seat. This works for both active and completed drafts since pick data is always in Turso once ingested.
2. Sort each card into the appropriate CMC column based on its mana value (lands go to the `lands` column)
3. Place all cards in the **sideboard** zone (user drags them into the deck)
4. Set basic lands to all zeros

### Turso Schema

```sql
-- Immutable snapshots of shared decks. Distinct from deck_cards, which stores
-- actual decklists imported from sealeddeck.tech for analytics purposes.
CREATE TABLE shared_decks (
  deck_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

No foreign key constraint on `draft_id` — shared decks may reference active drafts during early ingestion states, and the constraint adds complexity without value given the immutable snapshot model.

Each share creates a new row. Rows are immutable — no updates. The `deck_id` is a short random string (e.g., "R7yS25").

## Persistence

### Local (work-in-progress)

`DeckState` is serialized to localStorage under the key `deckState:{draftId}:{seat}`. Updated on every state change (debounced). This allows users to close and reopen the deck builder without losing progress.

### Shared (immutable snapshots)

Clicking "Share Deck":

1. `POST /api/deck` with the current `DeckState`
2. Server generates a short `deck_id`, writes the row to `shared_decks`
3. Returns the `deck_id`
4. Client copies `{origin}/deck/{deck_id}` to clipboard and shows confirmation

### Fork-on-edit

When someone opens a shared link (`/deck/[id]`):

1. The snapshot loads from Turso and populates the deck builder
2. The card table shows the correct draft context
3. Any edits fork into localStorage — the original snapshot is untouched
4. Sharing again creates a new snapshot with a new ID

## State Management

A `useReducer` hook (`useDeckBuilder`) manages `DeckState` with these actions:

| Action | Effect |
|--------|--------|
| `INIT_FROM_PICKS` | Populate sideboard from seat's picks |
| `INIT_FROM_SNAPSHOT` | Load a shared deck snapshot |
| `MOVE_CARD` | Move a card between zones and/or columns |
| `REORDER_CARD` | Change card position within a column |
| `ADD_SPECULATIVE` | Add an unpicked card to the sideboard |
| `REMOVE_SPECULATIVE` | Remove a speculative card from the pool |
| `SET_BASICS` | Update basic land counts |
| `CLEAR_DECK` | Move all cards to sideboard, reset basics |

The reducer is pure and testable. A wrapper hook handles localStorage sync (debounced writes, reads on mount).

## Component Architecture

### New Components

| Component | Purpose |
|-----------|---------|
| `DeckBuilderPanel` | Top-level container. Manages `useDeckBuilder` reducer, renders toolbar + two `DeckZone`s |
| `DeckZone` | Renders one zone (deck or sideboard). Fixed 7-column grid of `DeckColumn`s |
| `DeckColumn` | A single column. Droppable container, renders stacked `DeckCard`s, shows header |
| `DeckCard` | Draggable card tile with Scryfall art. Dashed + faded if speculative |
| `BasicLandsDialog` | Popover with +/- controls for each basic land type |
| `ShareDeckButton` | POST to API, copy URL to clipboard, show confirmation |

### Modified Components

| Component | Change |
|-----------|--------|
| `PageClient` | Add deck builder toggle state, render `DeckBuilderPanel` above `CardTable`, wrap both in `DndContext` |
| `CardNameCell` | Add `+` button and draggable behavior for speculative adds |
| `CardTable` | Add visual indicator for cards already in the deck builder |

### New Hooks

| Hook | Purpose |
|------|---------|
| `useDeckBuilder` | `useReducer` + localStorage sync for `DeckState` |
| `useShareDeck` | API call to create shared snapshot, URL generation |

## API Routes

### `POST /api/deck`

Creates a shared deck snapshot.

**Request body:** `DeckState` (JSON)

**Response:** `{ deckId: string }`

**Behavior:** Validate that the JSON body is well-formed and within a reasonable size limit (~100KB). Generate a short random ID, write `DeckState` as JSON to `shared_decks`, return the ID.

### `GET /api/deck/[id]`

Retrieves a shared deck snapshot.

**Response:** `DeckState` (JSON), or 404 if not found.

## Page Route

### `/deck/[id]` (Server Component)

Landing page for shared deck links.

1. Query Turso directly via a `getSharedDeck(deckId)` function in `src/core/db/queries/decklists.ts` (consistent with existing SSR pattern — server components call query functions, not API routes)
2. Fetch the card data for the snapshot's `draftId` using existing query functions
3. Server-render the page with the deck builder pre-populated and open
4. Client hydrates with fork-on-edit behavior (edits go to localStorage)

## Dependencies

- **`@dnd-kit/core`** — drag-and-drop primitives (DndContext, useDraggable, useDroppable)
- **`@dnd-kit/sortable`** — sortable lists within columns
- **`@dnd-kit/utilities`** — CSS transform utilities

No other new dependencies required.

## Out of Scope

- Split view (separate creatures/noncreatures) — potential future enhancement
- Deck validation (e.g., enforcing exactly 40 cards) — informational counts only, no blocking
- Cross-draft deck building — decks are scoped to a single draft + seat
- Authentication or ownership — decks are public and editable by anyone
- Mobile-optimized drag-and-drop — standard touch support from `@dnd-kit`, but no mobile-specific UX
- Deck export (text format, MTGO, Arena) — potential future enhancement
