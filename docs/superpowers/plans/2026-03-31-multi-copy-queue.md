# Multi-Copy Card Queuing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to queue a card multiple times (up to the number of remaining copies in the cube), with each queue entry acting as an independent auto-pick target.

**Architecture:** Replace the `queuedCards: Map<string, number>` (name→priority) derived state with `queuedCardCounts: Map<string, number>` (name→count). Change `removeFromQueue` to remove only one entry (highest priority). Update the server-side cascade in `processPick` to trim excess queue entries copy-aware. Update the stats modal to show both Queue and Unqueue buttons when partially queued.

**Tech Stack:** TypeScript, React, Zustand, Turso (libsql), Vitest

**Spec:** `docs/superpowers/specs/2026-03-31-multi-copy-queue-design.md`

---

## Chunk 1: Data Model & Store Layer

### Task 1: Replace `queuedCards` with `queuedCardCounts` in liveStore

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Test: `src/app/stores/liveStore.test.ts`

This task changes the derived state from a name→priority Map to a name→count Map, and updates every place in liveStore that builds or references it.

- [ ] **Step 1: Write failing tests for `queuedCardCounts` derivation**

In `liveStore.test.ts`, update the existing test "sets queue and queuedCards from response" to expect `queuedCardCounts` instead. Add a new test for multi-copy derivation:

```ts
it("sets queue and queuedCardCounts from response", async () => {
  // ... existing fetch mock setup ...
  const s = useLiveStore.getState();
  expect(s.queuedCardCounts.get("Bolt")).toBe(1);
  expect(s.queuedCardCounts.get("Counterspell")).toBe(1);
});

it("queuedCardCounts counts duplicate card names", async () => {
  // Mock fetch to return queue with duplicate card names
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({
      queue: [
        { priority: 1, cardId: 10, cardName: "Bolt" },
        { priority: 2, cardId: 20, cardName: "Counterspell" },
        { priority: 3, cardId: 10, cardName: "Bolt" },
      ],
    }))
  );
  // ... trigger fetchQueue ...
  const s = useLiveStore.getState();
  expect(s.queuedCardCounts.get("Bolt")).toBe(2);
  expect(s.queuedCardCounts.get("Counterspell")).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: FAIL — `queuedCardCounts` does not exist.

- [ ] **Step 3: Implement the rename in liveStore.ts**

Replace all occurrences of `queuedCards` with `queuedCardCounts` in `liveStore.ts`. Change the derivation helper:

```ts
// Old (in syncQueue, fetchQueue, addToQueue, removeFromQueue, and reset block):
queuedCards: new Map(queue.map((e) => [e.cardName, e.priority])),

// New — build a count map:
queuedCardCounts: deriveQueuedCardCounts(queue),
```

Add a helper function near the top of the file (after imports):

```ts
function deriveQueuedCardCounts(queue: QueueEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of queue) {
    counts.set(e.cardName, (counts.get(e.cardName) ?? 0) + 1);
  }
  return counts;
}
```

Update the interface:

```ts
// In LiveStoreState:
queuedCardCounts: Map<string, number>;  // was queuedCards
```

Update the initial state:

```ts
queuedCardCounts: new Map(),  // was queuedCards
```

Update `recomputePicking` (line 654):

```ts
const { mySeat, autoPick, queuedCardCounts } = useLiveStore.getState();
// ...
if (isMyTurn && autoPick && queuedCardCounts.size > 0) {
```

Update the reset block in the activeDraft subscription (line 702):

```ts
queuedCardCounts: new Map(),  // was queuedCards
```

There are ~10 occurrences to change. Use find-and-replace for the field name, then manually update each derivation call.

- [ ] **Step 4: Update all existing tests that reference `queuedCards`**

In `liveStore.test.ts`, rename all `queuedCards` references to `queuedCardCounts`. Tests that assert `queuedCards.get("Bolt")` returns a priority number (e.g., `1`) now assert `queuedCardCounts.get("Bolt")` returns a count (e.g., `1` — same for single-copy, but semantics changed).

For tests that set state directly with `queuedCards: new Map([["Bolt", 1]])`, update to `queuedCardCounts: new Map([["Bolt", 1]])`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Replace queuedCards with queuedCardCounts in liveStore"
```

### Task 2: Update `removeFromQueue` to remove only the highest-priority entry

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Test: `src/app/stores/liveStore.test.ts`

- [ ] **Step 1: Write failing test for single-entry removal**

```ts
it("removeFromQueue removes only the highest-priority entry for a card", async () => {
  // Set up queue with duplicate card names
  useLiveStore.setState({
    seatToken: "tok",
    queue: [
      { priority: 1, cardId: 10, cardName: "Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
      { priority: 3, cardId: 10, cardName: "Bolt" },
    ],
    queuedCardCounts: new Map([["Bolt", 2], ["Counterspell", 1]]),
  });

  // Mock fetch for sync
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({
      queue: [
        { priority: 1, cardId: 20, cardName: "Counterspell" },
        { priority: 2, cardId: 10, cardName: "Bolt" },
      ],
    }))
  );

  useLiveStore.getState().removeFromQueue("Bolt");

  // Check optimistic state — Bolt should still appear once
  const s = useLiveStore.getState();
  expect(s.queue.filter((e) => e.cardName === "Bolt")).toHaveLength(1);
  expect(s.queue.filter((e) => e.cardName === "Counterspell")).toHaveLength(1);
  expect(s.queuedCardCounts.get("Bolt")).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: FAIL — current `.filter()` removes all Bolt entries.

- [ ] **Step 3: Implement single-entry removal**

In `liveStore.ts`, change `removeFromQueue`:

```ts
removeFromQueue: (cardName: string) => {
  const { queue: original } = get();
  // Remove only the highest-priority (lowest number) entry for this card
  const targetIndex = original.reduce<number | null>((best, e, i) => {
    if (e.cardName !== cardName) return best;
    if (best === null || e.priority < original[best].priority) return i;
    return best;
  }, null);
  if (targetIndex === null) return;
  const optimisticQueue = original.filter((_, i) => i !== targetIndex);
  set({
    queue: optimisticQueue,
    queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
  });
  const newNames = optimisticQueue.map((e) => e.cardName);
  syncQueue(set, get, newNames, original);
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Change removeFromQueue to remove only highest-priority entry"
```

### Task 3: Add `removeFromQueueByPriority` for QueuePanel

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Test: `src/app/stores/liveStore.test.ts`

- [ ] **Step 1: Write failing test**

```ts
it("removeFromQueueByPriority removes the entry matching both card name and priority", () => {
  useLiveStore.setState({
    seatToken: "tok",
    queue: [
      { priority: 1, cardId: 10, cardName: "Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
      { priority: 3, cardId: 10, cardName: "Bolt" },
    ],
    queuedCardCounts: new Map([["Bolt", 2], ["Counterspell", 1]]),
  });

  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({
      queue: [
        { priority: 1, cardId: 10, cardName: "Bolt" },
        { priority: 2, cardId: 20, cardName: "Counterspell" },
      ],
    }))
  );

  useLiveStore.getState().removeFromQueueByPriority("Bolt", 3);

  // Priority-3 Bolt removed, priority-1 Bolt remains
  const s = useLiveStore.getState();
  const bolts = s.queue.filter((e) => e.cardName === "Bolt");
  expect(bolts).toHaveLength(1);
  expect(bolts[0].priority).toBe(1);
  expect(s.queuedCardCounts.get("Bolt")).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: FAIL — `removeFromQueueByPriority` does not exist.

- [ ] **Step 3: Implement `removeFromQueueByPriority`**

Add to the `LiveStoreState` interface:

```ts
removeFromQueueByPriority: (cardName: string, priority: number) => void;
```

Add the implementation in the store:

```ts
removeFromQueueByPriority: (cardName: string, priority: number) => {
  const { queue: original } = get();
  const optimisticQueue = original.filter(
    (e) => !(e.cardName === cardName && e.priority === priority)
  );
  if (optimisticQueue.length === original.length) return; // no match
  set({
    queue: optimisticQueue,
    queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
  });
  const newNames = optimisticQueue.map((e) => e.cardName);
  syncQueue(set, get, newNames, original);
},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Add removeFromQueueByPriority for QueuePanel row removal"
```

### Task 4: Update `CardStatusResult` and `getCardStatus`

**Files:**
- Modify: `src/core/cardStatus.ts`
- Modify: `src/app/stores/selectors.ts`
- Test: `src/app/stores/selectors.test.ts`

- [ ] **Step 1: Write failing tests**

In `selectors.test.ts`, update the existing test and add a multi-copy test:

```ts
it("returns 'queued' with queuedCount and remainingCopies for multi-copy card", () => {
  useDraftStore.setState({ selectedSeat: 2 });
  useLiveStore.setState({
    mySeat: 2,
    queuedCardCounts: new Map([["Scalding Tarn", 2]]),
    queue: [
      { priority: 1, cardId: 10, cardName: "Scalding Tarn" },
      { priority: 3, cardId: 10, cardName: "Scalding Tarn" },
    ],
  });
  useCardStore.setState({
    seatCardNames: new Set(),
    takenCardNamesSet: new Set(),
    takenCardCounts: new Map([["Scalding Tarn", 1]]),
    cardData: { ...defaultCardData, cubeCopies: { "Scalding Tarn": 3 } },
  });

  const result = getCardStatus("Scalding Tarn");
  expect(result.status).toBe("queued");
  expect(result.queuePosition).toBe(1);
  expect(result.queuedCount).toBe(2);
  expect(result.remainingCopies).toBe(2); // 3 - 1 taken
});
```

Also update existing tests that reference `queuedCards` to use `queuedCardCounts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/selectors.test.ts`
Expected: FAIL — `queuedCount` and `remainingCopies` are not returned.

- [ ] **Step 3: Update `CardStatusResult` type**

In `src/core/cardStatus.ts`:

```ts
export type CardStatusResult = {
  status: CardStatus;
  queuePosition?: number;
  queuedCount?: number;
  remainingCopies?: number;
};
```

- [ ] **Step 4: Update `getCardStatus` in selectors.ts**

```ts
export function getCardStatus(cardName: string): CardStatusResult {
  const { seatCardNames, takenCardNamesSet, takenCardCounts, cardData } = useCardStore.getState();
  const { queuedCardCounts, floatedCardsSet, queue } = useLiveStore.getState();

  if (seatCardNames?.has(cardName)) return { status: "picked" };

  if (getIsAuthed()) {
    const count = queuedCardCounts.get(cardName);
    if (count != null && count > 0) {
      // Find highest-priority (lowest number) entry
      let minPriority = Infinity;
      for (const e of queue) {
        if (e.cardName === cardName && e.priority < minPriority) {
          minPriority = e.priority;
        }
      }
      const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
      const takenCount = takenCardCounts?.get(cardName) ?? 0;
      return {
        status: "queued",
        queuePosition: minPriority,
        queuedCount: count,
        remainingCopies: cubeCopies - takenCount,
      };
    }
    if (floatedCardsSet.has(cardName)) return { status: "floated" };
  }

  if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}
```

Note: `getCardStatus` now reads `queue` (the array) in addition to `queuedCardCounts` and also reads `takenCardCounts` and `cardData` from `useCardStore`. The `cardData` field is already available in `useCardStore.getState()`.

- [ ] **Step 5: Update remaining tests referencing `queuedCards` in selectors.test.ts**

Rename all `queuedCards` to `queuedCardCounts` in test state setup.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/app/stores/selectors.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/cardStatus.ts src/app/stores/selectors.ts src/app/stores/selectors.test.ts
git commit -m "Expand CardStatusResult with queuedCount and remainingCopies"
```

### Task 5: Update consumers of `queuedCards` rename

**Files:**
- Modify: `src/app/components/CardStatsModal.tsx`
- Modify: `src/app/components/PageClient.tsx`
- Modify: `src/app/components/PageClient.test.tsx` (references `queuedCards` in test state)
- Modify: `src/app/components/CardStatsModal.test.tsx` (references `queuedCards` in test state)

These files subscribe to or set `queuedCards` from the store. Rename to `queuedCardCounts`.

- [ ] **Step 1: Update CardStatsModal.tsx**

Line 51: change `const queuedCards = useLiveStore((s) => s.queuedCards);` to:

```ts
const queuedCardCounts = useLiveStore((s) => s.queuedCardCounts);
```

Line 61: update the dependency array in the `useMemo` — replace `queuedCards` with `queuedCardCounts`.

Also add subscriptions for the new data that `getCardStatus` now reads (needed for `useMemo` reactivity):

```ts
const takenCardCounts = useCardStore((s) => s.takenCardCounts);
const cardData = useCardStore((s) => s.cardData);
```

Add `takenCardCounts` and `cardData` to the `useMemo` dependency array for `cardStatusResult` (line 61). This ensures `remainingCopies` recomputes when another player picks a copy.

- [ ] **Step 2: Update PageClient.tsx**

Line 69: change `const queuedCards = useLiveStore((s) => s.queuedCards);` to:

```ts
const queuedCardCounts = useLiveStore((s) => s.queuedCardCounts);
```

Lines 134-137: update the `queuedCardNames` derivation:

```ts
const queuedCardNames = useMemo(
  () => Array.from(queuedCardCounts.keys()),
  [queuedCardCounts],
);
```

- [ ] **Step 3: Update test files**

In `CardStatsModal.test.tsx` and `PageClient.test.tsx`, rename all `queuedCards` references in state setup to `queuedCardCounts`.

- [ ] **Step 4: Run typecheck to catch any remaining references**

Run: `pnpm typecheck`
Expected: PASS (no remaining references to `queuedCards`)

- [ ] **Step 5: Commit**

```bash
git add src/app/components/CardStatsModal.tsx src/app/components/PageClient.tsx \
  src/app/components/CardStatsModal.test.tsx src/app/components/PageClient.test.tsx
git commit -m "Rename queuedCards to queuedCardCounts in consumer components and tests"
```

## Chunk 2: Stats Modal & QueuePanel UI

### Task 6: Update ActionButtons to support partial queuing

**Files:**
- Modify: `src/app/components/CardStatsModal.tsx`

The `"queued"` case currently hides the Queue button. It must now show Queue when `queuedCount < remainingCopies`, and the Unqueue button label must show both position and count.

- [ ] **Step 1: Add `queuedCount` and `remainingCopies` to ActionButtonsProps**

```ts
interface ActionButtonsProps {
  cardStatus?: CardStatus;
  isMyTurn?: boolean;
  queuePosition?: number;
  queuedCount?: number;
  remainingCopies?: number;
  disabled?: boolean;
  onPick?: () => void;
  onQueue?: () => void;
  onUnqueue?: () => void;
  onFloat?: () => void;
  onUnfloat?: () => void;
}
```

- [ ] **Step 2: Update the `"queued"` case in ActionButtons**

```ts
case "queued": {
  const canQueueMore = props.onQueue &&
    props.queuedCount != null &&
    props.remainingCopies != null &&
    props.queuedCount < props.remainingCopies;
  const countLabel = props.queuedCount != null && props.remainingCopies != null
    ? ` · ${props.queuedCount}/${props.remainingCopies} queued`
    : "";
  return (
    <>
      {isMyTurn && props.onPick && <HoldToPickButton onPick={props.onPick} disabled={disabled} />}
      {canQueueMore && (
        <button className={queueBtn} onClick={props.onQueue} disabled={disabled}>
          Queue
        </button>
      )}
      {props.onUnqueue && (
        <button className={secondaryBtn} onClick={props.onUnqueue} disabled={disabled}>
          Unqueue{props.queuePosition != null ? ` (#${props.queuePosition})` : ""}{countLabel}
        </button>
      )}
    </>
  );
}
```

- [ ] **Step 3: Pass new props from CardStatsModal**

In the `CardStatsModal` component, extract the new fields from `cardStatusResult` and pass them to `ActionButtons`:

```ts
const queuedCount = cardStatusResult?.queuedCount;
const remainingCopies = cardStatusResult?.remainingCopies;
```

Update the `canQueue` logic to account for partially-queued cards:

```ts
const canQueue = isAuthed && !(isMyTurn && queue.length === 0 && autoPick);
```

This stays the same — it gates whether the Queue action is available at all. The per-card copy limit is handled inside ActionButtons via `queuedCount < remainingCopies`.

Pass to ActionButtons:

```ts
<ActionButtons
  cardStatus={cardStatus}
  isMyTurn={isAuthed && isMyTurn}
  queuePosition={queuePosition}
  queuedCount={queuedCount}
  remainingCopies={remainingCopies}
  disabled={actionPending}
  onPick={isAuthed ? handlePick : undefined}
  onQueue={canQueue ? handleQueue : undefined}
  onUnqueue={isAuthed ? handleUnqueue : undefined}
  onFloat={isAuthed ? handleFloat : undefined}
  onUnfloat={isAuthed ? handleUnfloat : undefined}
/>
```

- [ ] **Step 4: Update the `"none"` case to also respect remaining copies**

For single-copy cards that aren't queued yet, we should still hide Queue if `remainingCopies === 0`. But this is already handled by the `"taken"` status (all copies gone = taken). For multi-copy where some copies remain, status is `"none"` and Queue should appear — which it already does. No change needed.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardStatsModal.tsx
git commit -m "Show Queue and Unqueue together when card is partially queued"
```

### Task 7: Update QueuePanel to pass priority on remove

**Files:**
- Modify: `src/app/components/draft-board/QueuePanel.tsx`
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx`

- [ ] **Step 1: Change QueuePanel `onRemove` signature**

In `QueuePanel.tsx`, update the type:

```ts
type QueuePanelProps = {
  queue: QueueItem[];
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  onReorder: (queue: string[]) => void;
  onRemove: (cardName: string, position: number) => void;  // was (cardName: string)
  onToggleAutoPick: () => void;
  onChangeAutoPickMode: (mode: "resilient" | "cautious") => void;
};
```

Update the remove button's onClick (line 136):

```ts
onClick={() => onRemove(item.cardName, item.position)}
```

Update the `key` on the `<li>` element (line 93). Currently `key={item.cardName}` which will collide for duplicate cards. Change to:

```ts
key={`${item.cardName}-${item.position}`}
```

- [ ] **Step 2: Update DraftBoardModal to use `removeFromQueueByPriority`**

In `DraftBoardModal.tsx`, change the import/subscription:

Line 52: change `const removeFromQueue = useLiveStore((s) => s.removeFromQueue);` to:

```ts
const removeFromQueueByPriority = useLiveStore((s) => s.removeFromQueueByPriority);
```

Line 163: update the prop:

```ts
onRemove={removeFromQueueByPriority}
```

The signature `(cardName: string, priority: number) => void` matches the new `onRemove` prop type.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/components/draft-board/QueuePanel.tsx src/app/components/draft-board/DraftBoardModal.tsx
git commit -m "Pass priority to QueuePanel onRemove for correct row removal"
```

## Chunk 3: Server-Side Cascade

### Task 8: Make `removeCardFromAllQueues` copy-aware

**Files:**
- Modify: `src/core/db/queries/pickQueue.ts`
- Test: `src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 1: Write failing test for copy-aware removal**

```ts
it("removes only excess entries per seat when remainingCopies > 0", async () => {
  // remainingCopies = 1
  // Seat 1 has the card queued at priority 2 and 4 (2 entries, excess = 1)
  // Seat 2 has the card queued at priority 1 (1 entry, no excess)
  client.execute.mockResolvedValueOnce({
    // Query for all queue entries of this card across seats
    rows: [
      { seat: 1, priority: 2, card_id: 10 },
      { seat: 1, priority: 4, card_id: 10 },
      { seat: 2, priority: 1, card_id: 10 },
    ],
  });
  // After removing excess, fetch remaining entries for renumbering
  client.execute.mockResolvedValueOnce({
    rows: [
      { seat: 1, card_id: 20 },    // was priority 1
      { seat: 1, card_id: 10 },    // was priority 2, kept (highest priority)
      { seat: 1, card_id: 30 },    // was priority 3
      { seat: 2, card_id: 10 },    // was priority 1, kept
      { seat: 2, card_id: 40 },    // was priority 2
    ],
  });

  await trimExcessQueueEntries(client, "draft-1", 10, 1);

  // Should have called batch to delete excess + renumber
  expect(client.batch).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/core/db/queries/pickQueue.test.ts`
Expected: FAIL — `trimExcessQueueEntries` does not exist.

- [ ] **Step 3: Implement `trimExcessQueueEntries`**

Add a new exported function to `pickQueue.ts`:

```ts
/**
 * Remove queue entries that exceed remainingCopies for a given card.
 * Removes from the bottom (highest priority number) per seat.
 * Called after a pick to trim queues across all seats.
 */
export async function trimExcessQueueEntries(
  client: Client,
  draftId: string,
  cardId: number,
  remainingCopies: number,
): Promise<void> {
  if (remainingCopies <= 0) {
    // No copies left — remove all entries (existing behavior)
    await removeCardFromAllQueues(client, draftId, cardId);
    return;
  }

  // Find all queue entries for this card across all seats
  const entries = await client.execute({
    sql: `SELECT seat, priority, card_id
          FROM pick_queue
          WHERE draft_id = ? AND card_id = ?
          ORDER BY seat, priority`,
    args: [draftId, cardId],
  });

  // Group by seat, find entries to delete (lowest-priority = highest number)
  const toDelete: { seat: number; priority: number }[] = [];
  const bySeat = new Map<number, { priority: number }[]>();
  for (const row of entries.rows) {
    const seat = row.seat as number;
    const priority = row.priority as number;
    const arr = bySeat.get(seat) ?? [];
    arr.push({ priority });
    bySeat.set(seat, arr);
  }

  for (const [seat, seatEntries] of bySeat) {
    if (seatEntries.length <= remainingCopies) continue;
    // Sort by priority ascending, keep the first `remainingCopies`, delete the rest
    seatEntries.sort((a, b) => a.priority - b.priority);
    for (let i = remainingCopies; i < seatEntries.length; i++) {
      toDelete.push({ seat, priority: seatEntries[i].priority });
    }
  }

  if (toDelete.length === 0) return;

  // Delete excess entries
  const deleteStatements = toDelete.map(({ seat, priority }) => ({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ? AND priority = ?`,
    args: [draftId, seat, priority] as (string | number)[],
  }));
  await client.batch(deleteStatements);

  // Renumber remaining entries per affected seat
  const affectedSeats = new Set(toDelete.map((d) => d.seat));
  const renumberStatements: { sql: string; args: (string | number)[] }[] = [];

  for (const seat of affectedSeats) {
    const remaining = await client.execute({
      sql: `SELECT card_id FROM pick_queue WHERE draft_id = ? AND seat = ? ORDER BY priority`,
      args: [draftId, seat],
    });

    renumberStatements.push({
      sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
      args: [draftId, seat],
    });
    remaining.rows.forEach((row, i) => {
      renumberStatements.push({
        sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
        args: [draftId, seat, i + 1, row.card_id as number],
      });
    });
  }

  if (renumberStatements.length > 0) {
    await client.batch(renumberStatements);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/pickQueue.test.ts`
Expected: PASS

- [ ] **Step 5: Write test for remainingCopies=0 (delegates to removeCardFromAllQueues)**

```ts
it("calls removeCardFromAllQueues when remainingCopies is 0", async () => {
  // Mock the same sequence removeCardFromAllQueues expects
  client.execute.mockResolvedValueOnce({ rows: [] }); // DELETE
  client.execute.mockResolvedValueOnce({ rows: [] }); // remaining query

  await trimExcessQueueEntries(client, "draft-1", 10, 0);

  // Should have called execute (the removeCardFromAllQueues path)
  expect(client.execute).toHaveBeenCalled();
});
```

- [ ] **Step 6: Run all pickQueue tests**

Run: `pnpm test src/core/db/queries/pickQueue.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/db/queries/pickQueue.ts src/core/db/queries/pickQueue.test.ts
git commit -m "Add trimExcessQueueEntries for copy-aware cascade removal"
```

### Task 9: Update `processPick` to call cascade on every pick

**Files:**
- Modify: `src/core/processPick.ts`
- Test: `src/core/processPick.test.ts`

- [ ] **Step 1: Update `processPick` to use `trimExcessQueueEntries`**

Import the new function:

```ts
import { removeCardFromAllQueues, trimExcessQueueEntries, getAutoPickCandidate, getQueuesContainingCard } from './db/queries/pickQueue';
```

Restructure the `isLastCopy` computation block (lines 109-134) to hoist `remainingAfterPick`, then replace the `if (isLastCopy)` block (lines 136-156):

```ts
    // Determine remaining copies after this pick
    let isLastCopy: boolean;
    let remainingAfterPick: number;
    if (cascadeDepth === 0) {
      // Initial pick: reuse the validation query result
      const prevPickedCount = availCheck.rows.length > 0
        ? (availCheck.rows[0].picked_count as number)
        : 0;
      const totalQty = availCheck.rows.length > 0
        ? (availCheck.rows[0].qty as number)
        : 1;
      isLastCopy = prevPickedCount + 1 >= totalQty;
      remainingAfterPick = totalQty - (prevPickedCount + 1);
    } else {
      // Cascade pick: check the count now
      const copyCheck = await client.execute({
        sql: `SELECT COUNT(pe.pick_n) as picked_count, csc.qty
              FROM cube_snapshot_cards csc
              JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
              LEFT JOIN pick_events pe ON pe.card_id = csc.card_id AND pe.draft_id = d.draft_id
              WHERE d.draft_id = ? AND csc.card_id = ?
              GROUP BY csc.card_id, csc.qty`,
        args: [input.draftId, currentCardId],
      });
      const pickedNow = copyCheck.rows.length > 0 ? (copyCheck.rows[0].picked_count as number) : 1;
      const totalQty = copyCheck.rows.length > 0 ? (copyCheck.rows[0].qty as number) : 1;
      isLastCopy = pickedNow >= totalQty;
      remainingAfterPick = totalQty - pickedNow;
    }

    if (isLastCopy) {
      // Last copy taken: pause cautious-mode players, remove all queue entries + floats
      const affectedSeats = await getQueuesContainingCard(client, input.draftId, currentCardId);
      await Promise.all(
        affectedSeats
          .filter(({ seat: s }) => s !== currentSeat)
          .map(async ({ seat: affectedSeat }) => {
            const settings = allSeatSettings.get(affectedSeat);
            if (settings?.autoPickMode === 'cautious') {
              await updateAutoPick(client, input.draftId, affectedSeat, false);
              allSeatSettings.set(affectedSeat, { ...settings, autoPick: false });
            }
          })
      );
      await Promise.all([
        removeCardFromAllQueues(client, input.draftId, currentCardId),
        removeFloatedCardByCardId(client, input.draftId, currentCardId),
      ]);
    } else {
      // Not last copy: trim queue entries that exceed remaining availability
      await trimExcessQueueEntries(client, input.draftId, currentCardId, remainingAfterPick);
    }
```

This hoists `remainingAfterPick` alongside `isLastCopy` so both branches of the cascade check compute it, and `copyCheck` stays scoped inside the `else` where it belongs.

- [ ] **Step 2: Update the mock in processPick.test.ts**

Add `trimExcessQueueEntries` to the mock:

```ts
vi.mock('./db/queries/pickQueue', () => ({
  removeCardFromAllQueues: vi.fn().mockResolvedValue(undefined),
  trimExcessQueueEntries: vi.fn().mockResolvedValue(undefined),
  getAutoPickCandidate: vi.fn().mockResolvedValue(null),
  getQueuesContainingCard: vi.fn().mockResolvedValue([]),
}));
```

- [ ] **Step 3: Add test for non-last-copy pick calling trimExcessQueueEntries**

Write a test where `qty=3` and `picked_count=0` (so after pick, remaining=2, isLastCopy=false). Verify `trimExcessQueueEntries` is called with `remainingCopies=2`:

```ts
it('calls trimExcessQueueEntries when pick is not last copy', async () => {
  const { trimExcessQueueEntries } = await import('./db/queries/pickQueue');
  // ... set up mocks for draft, pick count, availability with qty=3 picked_count=0 ...
  // ... mock the INSERT returning rowsAffected=1 ...
  // ... mock the post-pick count check ...

  await processPick(mockClient, {
    draftId: 'd1', seat: 1, cardId: 100, cardName: 'Scalding Tarn',
  });

  expect(trimExcessQueueEntries).toHaveBeenCalledWith(
    mockClient, 'd1', 100, 2, // 3 - (0+1) = 2 remaining
  );
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/processPick.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/processPick.ts src/core/processPick.test.ts
git commit -m "Call trimExcessQueueEntries on every pick, not just last copy"
```

## Chunk 4: Integration Verification

### Task 10: Run full test suite and fix any remaining issues

**Files:** Various (fix as needed)

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS (zero warnings)

- [ ] **Step 4: Run knip (unused exports)**

Run: `pnpm knip`
Expected: PASS — no unused exports introduced

- [ ] **Step 5: Fix any issues found**

Address test failures, type errors, lint warnings, or unused exports. Each fix should be a separate commit.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "Fix integration issues from multi-copy queue changes"
```
