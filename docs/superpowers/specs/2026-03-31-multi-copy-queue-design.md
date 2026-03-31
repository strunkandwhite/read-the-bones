# Multi-Copy Card Queuing

Cards with multiple copies in the cube (e.g., 3x Scalding Tarn) can currently only be queued once. This spec adds the ability to queue a card up to N times, where N is the number of remaining copies available in the cube.

## Data Model

### `queuedCards` → `queuedCardCounts`

Replace `queuedCards: Map<string, number>` (cardName → priority) with `queuedCardCounts: Map<string, number>` (cardName → count of queue entries). Derived from the `queue: QueueEntry[]` array by counting occurrences of each card name.

The current `queuedCards` Map is built via `new Map(queue.map((e) => [e.cardName, e.priority]))`, which silently drops duplicate entries (the Map keeps only the last entry's priority for a given card name). This is the root cause of the single-queue limitation — even if the queue array contained duplicates, the derived Map would lose them. The new `queuedCardCounts` derivation counts all occurrences, fixing this.

**All consumers must update.** The rename propagates beyond `liveStore.ts` to every file that reads `queuedCards`:
- `selectors.ts` — `getCardStatus()` reads `queuedCards`
- `PageClient.tsx` — subscribes to `queuedCards`, derives `queuedCardNames`
- `CardStatsModal.tsx` — subscribes to `queuedCards`
- `liveStore.ts` — `recomputePicking` checks `queuedCards.size > 0` (update to `queuedCardCounts.size`)
- Test files for the above

Consumers that check `.has(name)` switch to `queuedCardCounts.has(name)`. Consumers that read `.get(name)` for a priority must scan the `queue` array directly.

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

Changes from current behavior. Currently uses `.filter((e) => e.cardName !== cardName)` which removes **all** entries for a card name. New behavior: removes only the **highest-priority (lowest number)** entry for that card name. The remaining entries stay in the queue. Priorities are re-numbered by the server on sync (`setQueue` does DELETE + batch INSERT via `client.batch()`).

This is the "unqueue from the top" rule: the user always removes their most urgent entry, which is the one displayed on the Unqueue button.

### `removeCardFromAllQueues` — system-initiated cascade

Currently calls `DELETE FROM pick_queue WHERE draft_id = ? AND card_id = ?`, blanket-removing all entries for a card across all seats, and is only invoked when `isLastCopy` is true (guarded in `processPick.ts:137`).

Two changes are needed:

1. **Invoke on every pick, not just last copy.** The `if (isLastCopy)` guard in `processPick.ts` must be replaced with a copy-aware check:

   ```
   remainingAfterPick = cube_qty - (picked_count + 1)  // +1 for current pick
   seatsWithExcessQueued = query seats where queued_count > remainingAfterPick
   if seatsWithExcessQueued is not empty:
     call removeCardFromAllQueues(client, draftId, cardId, remainingAfterPick)
   ```

   When the last copy is taken (`remainingAfterPick = 0`), every seat with any queue entry has excess — this degenerates to the current "remove all" behavior.

2. **Make the function copy-aware.** New algorithm:
   - Query remaining copies: `cube_qty - picked_count` for the card
   - For each seat that has the card queued, count their entries
   - If a seat's count exceeds remaining copies, delete the excess entries starting from the **lowest-priority (highest number)** entries
   - Re-number remaining priorities per seat

   Example: Player has Thoughtseize #1, Scalding Tarn #2, Phyrexia #3, Scalding Tarn #4. Another player picks a Scalding Tarn (1 copy remains). Cascade removes #4 (the lowest-priority Scalding Tarn). Result: Thoughtseize #1, Scalding Tarn #2, Phyrexia #3.

This is the "system unqueues from the bottom" rule: the player's highest-priority intent is always preserved.

### Server-side `setQueue`

No changes. Already does a full replace (delete all, insert all via `client.batch()`), so duplicate card names in the payload are handled naturally. The `pick_queue` table's primary key is `(draft_id, seat, priority)`, not `(draft_id, seat, card_id)`, so duplicates are already supported at the schema level.

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

`QueuePanel.tsx` renders from the `queue: QueueEntry[]` array. Duplicate card names naturally appear as separate rows at their respective positions (e.g., Scalding Tarn at #2 and #7).

However, the QueuePanel's remove button currently calls `onRemove(cardName)`. With duplicates, clicking remove on row #7 (Scalding Tarn) would incorrectly remove #2 (the highest-priority entry) instead. QueuePanel must change to pass the priority to `onRemove` so the correct row is removed.

Add `removeFromQueueByPriority(cardName, priority)` to the store. This removes the entry matching both the card name and the given priority number. Optimistically, it filters the queue array for the entry where `e.cardName === cardName && e.priority === priority`, removes that single entry, and re-derives `queuedCardCounts`. Then syncs the remaining queue to the server. The stats modal continues to use `removeFromQueue(cardName)` which removes from the top (highest priority / lowest number).

## Auto-Pick

When auto-pick fires and the highest-priority card is a multi-queued card:
- One queue entry is consumed by the pick
- Remaining entries for that card stay in the queue for future auto-picks of remaining copies
- "Cautious" mode still pauses if a cascade removed the card entirely (last copy taken by someone else)

## Float Interaction

A card can be both floated and queued. Existing logic in DeckZone treats queued as stronger intent than floated. With multi-copy queuing:
- The queue API route auto-floats cards that are fully removed from the queue (old card set minus new card set). If a card goes from 2 queue entries to 1, the card is still in the new set, so auto-float does **not** fire — correct behavior.
- Auto-float only fires when the card name disappears from the queue entirely (count drops to 0).

## Optimistic Updates

- `addToQueue`: optimistically appends to the queue array, increments count in `queuedCardCounts`
- `removeFromQueue`: optimistically removes the highest-priority entry for that card, decrements count (removes from map if count reaches 0)
- Server sync replaces with canonical state on completion, same as today

## Files Affected

| File | Change |
|------|--------|
| `src/core/cardStatus.ts` | Add `queuedCount`, `remainingCopies` to `CardStatusResult` |
| `src/app/stores/liveStore.ts` | Replace `queuedCards` with `queuedCardCounts`; change derivation to count occurrences; update `addToQueue`, `removeFromQueue` (remove only one entry), `recomputePicking` (`.size` check); add `removeFromQueueByPriority` for QueuePanel |
| `src/app/stores/selectors.ts` | Update `getCardStatus()` to return `queuedCount`, `remainingCopies`, scan queue for `queuePosition` |
| `src/app/components/CardStatsModal.tsx` | Update `ActionButtons` to show both Queue/Unqueue when partially queued; new label format; subscribe to `queuedCardCounts` instead of `queuedCards` |
| `src/app/components/PageClient.tsx` | Update subscription from `queuedCards` to `queuedCardCounts`; update `queuedCardNames` derivation |
| `src/app/components/deck-builder/DeckBuilderPanel.tsx` | Derives `effectiveQueuedCardNames` from queue — no change needed (already uses queue array directly) |
| `src/app/components/draft-board/QueuePanel.tsx` | Pass priority to `onRemove` callback; use `removeFromQueueByPriority` |
| `src/app/components/draft-board/DraftBoardModal.tsx` | Update `removeFromQueue` prop passed to QueuePanel |
| `src/core/db/queries/pickQueue.ts` | Rewrite `removeCardFromAllQueues` to be copy-aware (query remaining copies, remove excess from bottom, re-number) |
| `src/core/processPick.ts` | Relax `if (isLastCopy)` guard to call cascade on every pick |
| `src/app/stores/cardStore.ts` | No changes (already has `cubeCopies`, `takenCardCounts`) |
| `src/core/db/schema.sql` | No changes (PK already supports duplicate card entries) |
| `src/app/api/drafts/[id]/queue/route.ts` | No changes (full replace semantics handle duplicates; auto-float logic is already set-based) |
