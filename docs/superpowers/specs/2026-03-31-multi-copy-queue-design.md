# Multi-Copy Card Queuing

Cards with multiple copies in the cube (e.g., 3x Scalding Tarn) can currently only be queued once. This spec adds the ability to queue a card up to N times, where N is the number of remaining copies available in the cube.

## Data Model

### `queuedCards` → `queuedCardCounts` (liveStore.ts)

Replace `queuedCards: Map<string, number>` (cardName → priority) with `queuedCardCounts: Map<string, number>` (cardName → count of queue entries). Derived from the `queue: QueueEntry[]` array by counting occurrences of each card name.

All consumers that currently check `queuedCards.has(name)` switch to `queuedCardCounts.has(name)`. All consumers that read `queuedCards.get(name)` for a priority position must instead scan the `queue` array directly.

### `CardStatusResult` expansion (cardStatus.ts)

```ts
export type CardStatusResult = {
  status: CardStatus;
  queuePosition?: number;   // priority of highest-priority (lowest number) entry
  queuedCount?: number;     // how many times this card appears in the queue
  remainingCopies?: number; // cube qty minus picked count
};
```

### `getCardStatus()` changes (selectors.ts)

When the card appears in `queuedCardCounts`:
- `status: "queued"`
- `queuePosition`: scan `queue` array for the minimum priority entry matching this card name
- `queuedCount`: value from `queuedCardCounts`
- `remainingCopies`: `cubeCopies[name] - (takenCardCounts.get(name) ?? 0)`

For single-copy cards, `queuedCount` is 1 and `remainingCopies` is 1 (or 0 if taken), so behavior is identical to today.

## Queue Actions

### `addToQueue(cardName)`

No signature change. Appends the card name to the queue array, allowing duplicate names. The UI gates this — the Queue button is only enabled when `queuedCount < remainingCopies`.

### `removeFromQueue(cardName)` — user-initiated unqueue

Removes the **highest-priority (lowest number)** entry for that card name. The remaining entries stay in the queue. Priorities are re-numbered by the server on sync (`setQueue` does DELETE + batch INSERT).

This is the "unqueue from the top" rule: the user always removes their most urgent entry, which is the one displayed on the Unqueue button.

### `removeCardFromAllQueues` — system-initiated cascade

When a copy of a card is picked by any player, the cascade logic becomes copy-aware:

- Instead of removing all entries for a card name, remove only entries that exceed the remaining available copies.
- Remove from the **bottom** (lowest-priority / highest number entries first).
- Example: Player has Thoughtseize #1, Scalding Tarn #2, Phyrexia #3, Scalding Tarn #4. Another player picks a Scalding Tarn (1 copy remains). Cascade removes #4 (the lowest-priority Scalding Tarn). Result: Thoughtseize #1, Scalding Tarn #2, Phyrexia #3.

This is the "system unqueues from the bottom" rule: the player's highest-priority intent is always preserved.

### Server-side `setQueue`

No changes. Already does a full replace (delete all, insert all), so duplicate card names in the payload are handled naturally. The `pick_queue` table's primary key is `(draft_id, seat, priority)`, not `(draft_id, seat, card_id)`, so duplicates are already supported at the schema level.

## Stats Modal UI

### Button states by card status

**`status: "none"`** (not queued, not floated, not picked):
- Shows: Pick (hold), Queue, Float
- Queue button enabled when `remainingCopies > 0`

**`status: "queued"`** (at least one queue entry):
- Shows: Pick (hold), Unqueue, and **also Queue if `queuedCount < remainingCopies`**
- This is the key change — both Queue and Unqueue appear simultaneously when partially queued
- Unqueue label: `Unqueue (#3) · 2/3 queued` — position of highest-priority entry, then queued/remaining ratio

**`status: "floated"`**:
- Shows: Pick (hold), Queue, Unfloat
- Queue button respects same `queuedCount < remainingCopies` check

**`status: "picked"` / `"taken"`**:
- No actions shown (unchanged)

### Single-copy cards

Behavior is identical to today. After one queue entry, `queuedCount` equals `remainingCopies` (both 1), so the Queue button disappears and only Unqueue shows.

## Queue Panel

`QueuePanel.tsx` already renders from the `queue: QueueEntry[]` array. Duplicate card names naturally appear as separate rows at their respective positions (e.g., Scalding Tarn at #2 and #7). No structural change needed.

## Auto-Pick

When auto-pick fires and the highest-priority card is a multi-queued card:
- One queue entry is consumed by the pick
- Remaining entries for that card stay in the queue for future auto-picks of remaining copies
- "Cautious" mode still pauses if a cascade removed the card entirely (last copy taken by someone else)

## Optimistic Updates

- `addToQueue`: optimistically appends to the queue array, increments count in `queuedCardCounts`
- `removeFromQueue`: optimistically removes the highest-priority entry for that card, decrements count (removes from map if count reaches 0)
- Server sync replaces with canonical state on completion, same as today

## Files Affected

| File | Change |
|------|--------|
| `src/core/cardStatus.ts` | Add `queuedCount`, `remainingCopies` to `CardStatusResult` |
| `src/app/stores/liveStore.ts` | Replace `queuedCards` with `queuedCardCounts`; update `addToQueue`, `removeFromQueue`, and all derivation logic |
| `src/app/stores/selectors.ts` | Update `getCardStatus()` to return new fields |
| `src/app/components/CardStatsModal.tsx` | Update `ActionButtons` to show both Queue/Unqueue when partially queued; new label format |
| `src/core/db/queries/pickQueue.ts` | Update `removeCardFromAllQueues` to be copy-aware (remove from bottom, only excess entries) |
| `src/app/components/draft-board/QueuePanel.tsx` | No structural changes (already renders from queue array) |
| `src/app/stores/cardStore.ts` | No changes (already has `cubeCopies`, `takenCardCounts`) |
| `src/core/db/schema.sql` | No changes (PK already supports duplicate card entries) |
| `src/app/api/drafts/[id]/queue/route.ts` | No changes (full replace semantics handle duplicates) |
