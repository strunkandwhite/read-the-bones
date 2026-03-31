# Queue Groups and Per-Entry Modes

## Problem

The current queue system offers only a single seat-level auto-pick mode (resilient or cautious) and treats every queued card as an independent entry. Drafters lack two capabilities they need:

1. **Per-entry mode control.** A drafter might want their top three picks to flow through automatically, but pause if all three are gone — because the fourth pick requires reevaluation. Today it's all-or-nothing.

2. **"I want one of these" grouping.** A drafter might want any one of three similar cards (e.g., three counterspells). If the system picks one, the other two should be removed automatically. Today, the remaining cards stay in the queue and can be auto-picked unnecessarily.

There is also a bug: cautious mode disables auto-pick when *any* queued card is taken, not just the top pick. This causes false pauses.

## Design

### Terminology

- **Entry**: A unit in the queue — either a single card or a group of cards.
- **Group**: An entry containing multiple cards with "pick one" semantics. Picking any card in the group fulfills and removes the entire group.
- **Pause** (replaces "cautious"): If this entry's top card is taken and this entry is first in the queue, auto-pick stops.
- **Flow-through** (replaces "resilient"): If this entry is exhausted, auto-pick continues to the next entry.

### Data Model

#### Schema Changes

1. **Add `queue_json` TEXT column to `seat_tokens`.** Stores the entire queue as a JSON array.

2. **Drop `auto_pick_mode` column from `seat_tokens`.** Mode is now per-entry, not per-seat.

3. **Drop `pick_queue` table.** No longer needed.

4. **`auto_pick` column stays.** It still controls whether the system attempts auto-picking at all.

#### Queue JSON Format

```json
[
  { "mode": "pause", "cards": [{ "id": 42, "name": "Lightning Bolt" }] },
  { "mode": "flow-through", "cards": [
    { "id": 87, "name": "Counterspell" },
    { "id": 15, "name": "Arcane Denial" },
    { "id": 63, "name": "Mana Drain" }
  ]},
  { "mode": "pause", "cards": [{ "id": 99, "name": "Demonic Tutor" }] }
]
```

Each card is stored as `{ id, name }` so server-side functions can operate on card IDs without extra lookups.

- Entry order = pick priority (first entry is tried first).
- Card order within a group = internal priority (first card is tried first).
- `mode` defaults to `"pause"` if omitted.
- A single-card entry is just a group of one.

#### Migration

1. Read all `pick_queue` rows JOIN `cards` (to get card names), grouped by `(draft_id, seat)`, ordered by `priority`.
2. Convert each card to a single-card entry with `mode: "pause"` and `{ id, name }` card objects.
3. Write the JSON array to `queue_json` on the corresponding `seat_tokens` row. Seats with a `seat_token` but no queue entries get `queue_json = '[]'`. Skip orphaned queue entries with no matching `seat_token` row.
4. Drop the `pick_queue` table.
5. Drop the `auto_pick_mode` column from `seat_tokens`.

### API Changes

#### PUT `/api/drafts/[id]/queue`

**Request body** changes from a flat array of `{ card_name }` to:

```json
[
  { "mode": "pause", "cards": ["Lightning Bolt"] },
  { "mode": "flow-through", "cards": ["Counterspell", "Arcane Denial", "Mana Drain"] }
]
```

The `cards` array accepts either plain strings (`"Lightning Bolt"`) or objects (`{ "cardName": "Lightning Bolt" }`); the server normalizes to `{ id, name }` before storing in `queue_json`. This means the client can send back the same structure it received from GET without stripping IDs.

**Validation:**
- Each entry must have a `cards` array with 1+ card names.
- `mode` must be `"pause"` or `"flow-through"` (defaults to `"pause"` if omitted).
- All card names must exist in the database.
- Total cards across all entries capped at 500.
- No duplicate card names across the entire queue.

**Side effects** remain the same: auto-float removed cards, auto-unfloat added cards. Float side effects compare the flattened set of all card names in the old queue vs. the new queue, regardless of entry structure.

#### GET `/api/drafts/[id]/queue`

**Response:**

```json
{
  "queue": [
    { "mode": "pause", "cards": [{ "cardId": 42, "cardName": "Lightning Bolt" }] },
    {
      "mode": "flow-through",
      "cards": [
        { "cardId": 87, "cardName": "Counterspell" },
        { "cardId": 15, "cardName": "Arcane Denial" }
      ]
    }
  ]
}
```

#### PUT `/api/drafts/[id]/seat-settings`

Remove `auto_pick_mode` from the accepted body. Only `auto_pick` and `display_name` remain.

#### GET `/api/drafts/[id]/me`

Remove `autoPickMode` from the response. Only `seat`, `autoPick`, `displayName`.

### Auto-Pick Logic

There are two distinct pause paths:

1. **Reactive pause** — another player takes a card, which exhausts the first entry in your queue. Fires asynchronously when `removeCardFromAllQueues` runs.
2. **Walk-time pause** — during auto-pick candidate selection, the system walks past exhausted entries and hits a `"pause"` entry. Fires synchronously during the auto-pick cascade.

Both disable auto-pick for the affected seat. They are complementary — reactive pause catches the case where your queue is damaged between turns, walk-time pause catches it during your turn.

#### `getAutoPickCandidate`

Walks the queue to find the next available card. Returns one of three outcomes:

```typescript
type AutoPickResult =
  | { kind: 'candidate'; cardId: number; entryIndex: number }  // found a card to pick
  | { kind: 'paused' }                                          // hit an exhausted pause entry
  | { kind: 'empty' }                                           // queue exhausted, no pause entries hit

function getAutoPickCandidate(
  client: Client, draftId: string, seat: number, availableCardIds: Set<number>
): Promise<AutoPickResult>
```

Algorithm:
1. Parse `queue_json`.
2. Walk entries top to bottom.
3. For each entry, check cards in order for availability.
4. If an available card is found → return `{ kind: 'candidate', cardId, entryIndex }`.
5. If the entry is exhausted and its mode is `"flow-through"` → continue to the next entry.
6. If the entry is exhausted and its mode is `"pause"` → return `{ kind: 'paused' }`.
7. If all entries exhausted without hitting a pause → return `{ kind: 'empty' }`.

The cascade in `processPick` uses `kind` to decide behavior: `candidate` → pick the card, `paused` → disable auto-pick, `empty` → do nothing.

#### Queue Cleanup After a Pick

After the auto-pick cascade successfully picks a card from a group, `processPick` removes the **entire group entry** from the picking seat's queue (group fulfillment). This is a direct update to the picking seat's `queue_json`, separate from `removeCardFromAllQueues`.

For single-card entries, the entry is simply removed.

Then `removeCardFromAllQueues` runs for all *other* seats (card-level removal — see below).

#### Reactive Pause Trigger (Bug Fix)

When the last copy of a card is picked, `removeCardFromAllQueues` processes each affected seat's queue. After removing the card, it checks whether the **first entry** is now fully exhausted:

- **Single-card entry**: If the taken card was the sole card of the first entry and the entry's mode is `"pause"`, disable auto-pick for that seat.
- **Group entry**: If removing the card causes the first entry to become fully exhausted (all cards taken) and that entry's mode is `"pause"`, disable auto-pick. If the group still has available cards, no pause — the group can still fulfill.

In all non-pause cases, the card is removed silently. Empty entries are removed.

#### `removeCardFromAllQueues`

When the last copy of a card is picked: parse all seats' `queue_json`, remove that card from any entry it appears in, remove entries whose card arrays become empty, and write back. This performs **card-level removal only** — it never removes an entire group just because one card was taken. Group fulfillment (removing the whole group after auto-picking from it) is a separate step handled by `processPick` for the picking seat only.

After card removal, check whether the first entry is now exhausted and apply the reactive pause trigger described above.

#### `trimExcessQueueEntries`

When copies are limited: iterate each seat's queue entries from bottom to top (lowest priority first). For each entry containing the card, remove the card from that entry. Continue until the total count of that card across all entries for that seat equals `remainingCopies`. If removing a card leaves an entry empty, remove the entry. Trimming never triggers a pause, even if it empties the first entry.

### UI: Drag-and-Drop Queue Panel

Replaces the current up/down arrow interface with drag-and-drop, using the existing `@dnd-kit` dependency (`@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`), following patterns already established in the deck builder (`DeckBuilderPanel`, `DeckColumn`, `DeckCard`).

#### Layout

- Vertical list of entries.
- **Single-card entries**: Card name, mode toggle, remove button.
- **Group entries**: Visual container (bordered/indented) with a group header showing the mode toggle, and the group's cards listed inside with individual remove buttons.
- **Mode toggle**: Small button or icon on each entry switching between "pause" (default) and "flow-through."

#### Drag Interactions

- **Reorder entries**: Drag a top-level entry and drop it **between** other entries to change its position in the queue.
- **Reorder within a group**: Drag a card within a group to change its internal priority.
- **Create a group**: Drag a single-card entry and drop it **directly onto** another entry (single or group) to merge them. The target entry highlights as a drop target to distinguish this from reordering.
- **Ungroup**: Drag a card out of a group to the top level. If the group is left with one card, it collapses to a single-card entry.

#### Adding Cards

Same as today — click from the card table. New cards are added as a single-card entry at the bottom with mode `"pause"`.

#### Taken Cards

Same as today — cards already picked are visually crossed out / grayed. If all cards in a group are taken, the whole group appears exhausted.

### Zustand Store Changes

#### LiveStore

**Remove:**
- `autoPickMode` state
- `updateAutoPickMode()` action

**Change `queue` type:**

```typescript
interface QueueGroupEntry {
  mode: 'pause' | 'flow-through';
  cards: { cardId: number; cardName: string }[];
}
```

`queue` becomes `QueueGroupEntry[]`.

**Update `queuedCardCounts`** derivation to walk all entries and their card arrays.

**New/updated actions:**
- `addToQueue(cardName)` — appends a single-card pause entry at the bottom.
- `removeFromQueue(cardName)` — removes card from whichever entry contains it; removes empty entries.
- `reorderQueue(entries: QueueGroupEntry[])` — replaces entire queue (used after any drag operation: reorder, group, ungroup, reorder-within-group).
- `setEntryMode(entryIndex: number, mode: 'pause' | 'flow-through')` — toggle mode on a specific entry.
- `syncQueue()` — same pattern as today, sends full queue JSON to PUT endpoint.

**`triggerAutoPick` / `recomputePicking`** updates: The client-side auto-pick mirrors the server-side logic. When it's the player's turn and auto-pick is enabled:

1. Re-fetch queue and settings from the server (ensures latest state).
2. Walk entries top to bottom.
3. For each entry, try cards in order via `handlePick`.
4. If the pick succeeds → stop (queue cleanup happens server-side via the pick response).
5. If the pick fails (card unavailable) and the entry has more cards → try the next card in the entry.
6. If the entry is exhausted and its mode is `"flow-through"` → continue to the next entry.
7. If the entry is exhausted and its mode is `"pause"` → stop (server will have disabled auto-pick).

#### QueuePanel Props

```typescript
type QueuePanelProps = {
  queue: QueueGroupEntry[];
  autoPick: boolean;
  onReorder: (queue: QueueGroupEntry[]) => void;
  onRemove: (cardName: string) => void;
  onToggleAutoPick: () => void;
  onSetEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => void;
};
```

### Testing

#### Server-Side

- `getAutoPickCandidate`: returns first available card from first entry; skips exhausted flow-through entries; stops at exhausted pause entries.
- Pause trigger: only fires when the taken card was the first card of the first entry, not for deeper cards.
- Queue cleanup: removing a card from a group; group entry removal when empty; picking from a group removes the entire group.
- JSON round-trip: PUT/GET preserves structure, modes, ordering.
- Migration: existing flat queue rows convert to single-card pause entries.

#### UI

- QueuePanel renders groups visually distinct from single cards.
- Mode toggle switches between pause and flow-through.
- Drag interactions (unit-level with mocked dnd-kit): reorder entries, create group, ungroup, reorder within group.

#### E2E

- Auto-pick with flow-through skips exhausted entries and picks from the next entry.
- Auto-pick with pause stops when first entry's top card is taken.
- Group pick removes entire group from queue after one card is picked.
