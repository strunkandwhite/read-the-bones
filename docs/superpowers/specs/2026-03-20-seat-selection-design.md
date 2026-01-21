# Seat Selection for Active Drafts

Allow users to select a seat during an active draft, highlighting that seat's picks in the card table.

## Problem

During an active rotisserie draft, the site shows which cards are taken but not who took them. Players want to see a specific seat's picks at a glance — to review their own selections, scout an opponent, or plan around what's been drafted.

## Users

The current drafting group. Not a general-audience feature.

## Design

### API Change

Replace the existing `takenCardNames: string[]` field in the `/api/cards` response with:

```ts
takenCards: Array<{ name: string; seat: number }>
```

The server query changes from:

```sql
SELECT c.name FROM pick_events pe
JOIN cards c ON pe.card_id = c.card_id
WHERE pe.draft_id = ?
```

to:

```sql
SELECT c.name, pe.seat FROM pick_events pe
JOIN cards c ON pe.card_id = c.card_id
WHERE pe.draft_id = ?
```

This replaces `takenCardNames` in `CardStatsResponse` — all existing consumers update in the same change. No new endpoints, no new query parameters. The field appears only when `activeDraft` is provided, matching the existing behavior.

### Sync Status Change

The `/api/sync-status` endpoint currently returns `activeDraftIds: string[]`. This changes to:

```ts
activeDrafts: Array<{ id: string; numSeats: number }>
```

The query changes from `SELECT draft_id` to `SELECT draft_id, num_seats FROM drafts WHERE is_complete = 0`. This provides the seat count needed to populate the seat selector dropdown without requiring a separate fetch.

`useSyncStatus` updates its types accordingly. The existing check for whether the selected draft is still active uses `activeDrafts.map(d => d.id)` instead of `activeDraftIds`.

### Client-Side Derived State

From `takenCards`, `useCardFiltering` derives two structures:

- **`takenCardNames: Set<string>`** — replaces the current `new Set(cardData.takenCardNames)` for existing "is this card taken?" checks.
- **`seatCardNames: Set<string> | undefined`** — the selected seat's card names, derived by filtering `takenCards` to the selected seat. `undefined` when no seat is selected.

Both are computed once per data fetch or seat change.

### Seat Selector UI

A dropdown in the settings panel, on the same row as the active draft dropdown, positioned to its right. Visible only when an active draft is selected.

**Options:** "No seat" (default), then "Seat 1" through "Seat N" based on the active draft's `num_seats`.

Selecting "No seat" clears the seat — behavior reverts to the current uniform treatment of taken cards.

### State Management

`useDraftSelection` gains a `selectedSeat: number | null` field.

**localStorage persistence:** Stored under the key `"selectedSeats"` as a JSON object mapping draft IDs to seat numbers:

```json
{ "tarkir": 3, "dominaria": 7 }
```

When the active draft changes, the hook looks up the stored seat for that draft. When the active draft clears (manually or on completion), no cleanup of the stored map — the mapping persists so reselecting the draft restores the seat.

### Card Display States

Three visual states depending on seat selection and taken status:

| Card state | Hide taken ON | Hide taken OFF |
|---|---|---|
| Available (not taken) | Normal | Normal |
| Taken by selected seat | Normal + left border accent | Normal + left border accent |
| Taken by other seats | Hidden | `opacity: 0.35` |

**The accent:** A colored left border on the row (3-4px solid), using an existing theme color. The row stays at full opacity.

**No seat selected:** Identical to current behavior — taken cards are either hidden or faded uniformly. No accent appears.

### Filtering Logic

`useCardFiltering` gains `selectedSeat: number | null` as an input (passed from `useDraftSelection`).

The current `displayCards` filter removes all taken cards when `hideTaken` is true. With seat selection, the filter becomes: hide a taken card only if it was not picked by the selected seat. In pseudocode:

```ts
// Current
cards.filter(c => !takenCardNames.has(c.cardName))

// With seat selection
cards.filter(c => !takenCardNames.has(c.cardName) || seatCardNames?.has(c.cardName))
```

When no seat is selected (`selectedSeat === null`), `seatCardNames` is undefined and the filter behaves identically to today.

### Rendering Props

`CardTable` currently receives `takenCardNames?: Set<string>` and applies `opacity: 0.35` to matching rows. It gains an additional prop:

- **`seatCardNames?: Set<string>`** — the selected seat's card names, passed from `useCardFiltering`.

The table uses both props to determine row styling:
- `seatCardNames?.has(name)` → full opacity + left border accent
- `takenCardNames?.has(name)` (and not in seatCardNames) → `opacity: 0.35`
- Neither → normal row

When no seat is selected, `seatCardNames` is undefined and the accent never appears.

### Available Count

The available count in the status indicator remains unchanged — it counts cards that are neither taken nor banned, regardless of seat selection. Seat filtering is a display concern, not an availability concern.

## Scope

### In Scope

- `takenCardNames` → `takenCards` API response change
- Seat dropdown in settings panel
- Three-state card display (available / seat's pick / other's pick)
- Draft-to-seat localStorage persistence

### Out of Scope

- Cross-draft player identity (seats are per-draft only)
- Seat labels or player names (seats remain numbered)
- Changes to sync polling or caching
- Schema or migration changes
