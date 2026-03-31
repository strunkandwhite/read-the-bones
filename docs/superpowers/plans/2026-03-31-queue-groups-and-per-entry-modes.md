# Queue Groups and Per-Entry Modes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat pick queue with grouped entries that support per-entry pause/flow-through modes and drag-and-drop reordering.

**Architecture:** JSON blob (`queue_json`) on `seat_tokens` replaces the `pick_queue` table. Each queue entry is a group of 1+ cards with its own mode. Server-side auto-pick walks entries respecting per-entry modes. Client uses `@dnd-kit` for drag-and-drop (already in project).

**Tech Stack:** TypeScript, Next.js, Zustand, Turso/libsql, @dnd-kit, Vitest, React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-31-queue-groups-and-per-entry-modes-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/core/db/schema.sql` | Add `queue_json` column, drop `pick_queue` table |
| Modify | `src/core/db/migrate.ts` | Migration logic for queue data |
| Rewrite | `src/core/db/queries/pickQueue.ts` | JSON-based queue operations |
| Rewrite | `src/core/db/queries/pickQueue.test.ts` | Tests for new queue functions |
| Modify | `src/core/db/queries/seatTokens.ts` | Remove `autoPickMode` from queries/types |
| Modify | `src/core/processPick.ts` | New auto-pick cascade with entry modes |
| Modify | `src/core/processPick.test.ts` | Updated cascade tests |
| Modify | `src/app/api/drafts/[id]/queue/route.ts` | Structured JSON request/response |
| Modify | `src/app/api/drafts/[id]/seat-settings/route.ts` | Remove `auto_pick_mode` |
| Modify | `src/app/api/drafts/[id]/me/route.ts` | Remove `autoPickMode` from response |
| Modify | `src/app/stores/liveStore.ts` | New queue types, remove autoPickMode |
| Modify | `src/app/stores/liveStore.test.ts` | Updated store tests |
| Rewrite | `src/app/components/draft-board/QueuePanel.tsx` | Drag-and-drop grouped queue UI |
| Rewrite | `src/app/components/draft-board/QueuePanel.test.tsx` | Tests for new UI |

---

## Chunk 1: Server-Side Queue Data Model

### Task 1: Rewrite pickQueue.ts with JSON-Based Queue Functions

The current `pickQueue.ts` operates on the `pick_queue` table with SQL queries. Replace all functions to operate on the `queue_json` TEXT column on `seat_tokens`.

**Files:**
- Rewrite: `src/core/db/queries/pickQueue.ts`
- Rewrite: `src/core/db/queries/pickQueue.test.ts`

**Types to define at top of pickQueue.ts:**

```typescript
export interface QueueCard {
  id: number;
  name: string;
}

export interface QueueEntry {
  mode: 'pause' | 'flow-through';
  cards: QueueCard[];
}

export type AutoPickResult =
  | { kind: 'candidate'; cardId: number; entryIndex: number }
  | { kind: 'paused' }
  | { kind: 'empty' };
```

- [ ] **Step 1: Write failing tests for `getQueue`**

```typescript
// src/core/db/queries/pickQueue.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getQueue,
  setQueue,
  removeCardFromAllQueues,
  getAutoPickCandidate,
  trimExcessQueueEntries,
  type QueueEntry,
} from "./pickQueue";

function createMockClient() {
  return {
    execute: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as Client & { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };
}

describe("getQueue", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns parsed queue entries from queue_json", async () => {
    const queueJson: QueueEntry[] = [
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Counterspell" }, { id: 30, name: "Mana Drain" }] },
    ];
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: JSON.stringify(queueJson) }],
    });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual(queueJson);
  });

  it("returns empty array when queue_json is null", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: null }],
    });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual([]);
  });

  it("returns empty array when no seat_token row exists", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`
Expected: FAIL — old function signatures don't match new test expectations.

- [ ] **Step 3: Implement `getQueue`**

```typescript
export async function getQueue(
  client: Client,
  draftId: string,
  seat: number,
): Promise<QueueEntry[]> {
  const result = await client.execute({
    sql: `SELECT queue_json FROM seat_tokens WHERE draft_id = ? AND seat = ?`,
    args: [draftId, seat],
  });
  if (result.rows.length === 0) return [];
  const raw = result.rows[0].queue_json as string | null;
  if (!raw) return [];
  return JSON.parse(raw) as QueueEntry[];
}
```

- [ ] **Step 4: Run tests to verify `getQueue` passes**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`
Expected: `getQueue` tests PASS.

- [ ] **Step 5: Write failing tests for `setQueue`**

```typescript
describe("setQueue", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("writes queue entries as JSON to seat_tokens", async () => {
    const entries: QueueEntry[] = [
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Counterspell" }] },
    ];
    await setQueue(client, "draft-1", 1, entries);

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("UPDATE seat_tokens");
    expect(call.sql).toContain("queue_json");
    const storedJson = JSON.parse(call.args[0] as string);
    expect(storedJson).toEqual(entries);
  });

  it("writes empty array for empty queue", async () => {
    await setQueue(client, "draft-1", 1, []);

    const call = client.execute.mock.calls[0][0];
    expect(JSON.parse(call.args[0] as string)).toEqual([]);
  });
});
```

- [ ] **Step 6: Implement `setQueue`**

```typescript
export async function setQueue(
  client: Client,
  draftId: string,
  seat: number,
  entries: QueueEntry[],
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
    args: [JSON.stringify(entries), draftId, seat],
  });
}
```

- [ ] **Step 7: Run tests to verify `setQueue` passes**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 8: Write failing tests for `removeCardFromAllQueues`**

```typescript
describe("removeCardFromAllQueues", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("removes card from single-card entries across all seats", async () => {
    // SELECT all seat_tokens with non-null queue_json
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          ]),
        },
        {
          seat: 2,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          ]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    // Should batch-update both seats
    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(2);

    // Seat 1: Bolt removed, Recall remains
    const seat1Json = JSON.parse(statements[0].args[0] as string);
    expect(seat1Json).toEqual([{ mode: "pause", cards: [{ id: 20, name: "Recall" }] }]);

    // Seat 2: Bolt removed, queue empty
    const seat2Json = JSON.parse(statements[1].args[0] as string);
    expect(seat2Json).toEqual([]);

    // Returns pause triggers
    expect(result).toEqual({ pauseSeats: [2] });
  });

  it("removes card from within a group without removing the group", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
        ]),
      }],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([
      { mode: "flow-through", cards: [{ id: 20, name: "Chain" }] },
    ]);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("triggers pause when first entry top card removed and mode is pause", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
        ]),
      }],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [1] });
  });

  it("does not trigger pause when removed card is not in first entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("does not trigger pause when first entry group still has cards", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
        ]),
      }],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    // Group still has Chain, so no pause even though Bolt was first card
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("does not pause when first entry mode is flow-through", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("skips seats without the card in their queue", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { seat: 1, queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 99, name: "Other" }] }]) },
        { seat: 2, queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]) },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    // Only seat 2 should be updated
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1);
    expect(statements[0].args[1]).toBe("draft-1");
    expect(statements[0].args[2]).toBe(2);
    expect(result).toEqual({ pauseSeats: [2] });
  });
});
```

- [ ] **Step 9: Implement `removeCardFromAllQueues`**

New signature returns `{ pauseSeats: number[] }` so `processPick` can disable auto-pick for those seats.

```typescript
export async function removeCardFromAllQueues(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<{ pauseSeats: number[] }> {
  const result = await client.execute({
    sql: `SELECT seat, queue_json FROM seat_tokens WHERE draft_id = ? AND queue_json IS NOT NULL`,
    args: [draftId],
  });

  const updates: { seat: number; newQueue: QueueEntry[] }[] = [];
  const pauseSeats: number[] = [];

  for (const row of result.rows) {
    const seat = row.seat as number;
    const queue: QueueEntry[] = JSON.parse(row.queue_json as string);

    // Check if card is in this queue at all
    const hasCard = queue.some((entry) => entry.cards.some((c) => c.id === cardId));
    if (!hasCard) continue;

    // Check pause trigger before mutation: is the card in the first entry?
    const firstEntry = queue[0];
    const cardInFirstEntry = firstEntry?.cards.some((c) => c.id === cardId);

    // Remove card from all entries, drop empty entries
    const newQueue: QueueEntry[] = [];
    for (const entry of queue) {
      const filteredCards = entry.cards.filter((c) => c.id !== cardId);
      if (filteredCards.length > 0) {
        newQueue.push({ ...entry, cards: filteredCards });
      }
    }

    // Pause check: if card was in the first entry, that entry's mode is 'pause',
    // and the first entry is now fully exhausted (empty after removal)
    if (cardInFirstEntry && firstEntry.mode === 'pause') {
      const remainingInFirstEntry = firstEntry.cards.filter((c) => c.id !== cardId);
      if (remainingInFirstEntry.length === 0) {
        pauseSeats.push(seat);
      }
    }

    updates.push({ seat, newQueue });
  }

  if (updates.length > 0) {
    await client.batch(
      updates.map(({ seat, newQueue }) => ({
        sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
        args: [JSON.stringify(newQueue), draftId, seat] as (string | number)[],
      })),
    );
  }

  return { pauseSeats };
}
```

- [ ] **Step 10: Run tests to verify `removeCardFromAllQueues` passes**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 11: Write failing tests for `getAutoPickCandidate`**

```typescript
describe("getAutoPickCandidate", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns first available card from first entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
        ]),
      }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([10, 20]));
    expect(result).toEqual({ kind: "candidate", cardId: 10, entryIndex: 0 });
  });

  it("skips unavailable cards within an entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
        ]),
      }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "candidate", cardId: 20, entryIndex: 0 });
  });

  it("skips exhausted flow-through entries and continues", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
        ]),
      }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "candidate", cardId: 20, entryIndex: 1 });
  });

  it("returns paused when exhausted pause entry is reached", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
        ]),
      }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "paused" });
  });

  it("returns empty when all entries exhausted via flow-through", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "empty" });
  });

  it("returns empty when queue is empty", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: "[]" }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([10]));
    expect(result).toEqual({ kind: "empty" });
  });
});
```

- [ ] **Step 12: Implement `getAutoPickCandidate`**

```typescript
export async function getAutoPickCandidate(
  client: Client,
  draftId: string,
  seat: number,
  availableCardIds: Set<number>,
): Promise<AutoPickResult> {
  const queue = await getQueue(client, draftId, seat);
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    for (const card of entry.cards) {
      if (availableCardIds.has(card.id)) {
        return { kind: 'candidate', cardId: card.id, entryIndex: i };
      }
    }
    // Entry exhausted
    if (entry.mode === 'pause') return { kind: 'paused' };
    // flow-through: continue to next entry
  }
  return { kind: 'empty' };
}
```

- [ ] **Step 13: Run tests to verify `getAutoPickCandidate` passes**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 14: Write failing tests for `trimExcessQueueEntries`**

```typescript
describe("trimExcessQueueEntries", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("removes excess card references from lowest-priority entries", async () => {
    // Seat 1 has the card in entries at index 0 and 2 (two refs), remaining=1
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    // Entry at index 2 (lowest priority) should be removed
    expect(json).toEqual([
      { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
      { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
    ]);
  });

  it("removes card from within a group at lowest priority", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
        ]),
      }],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([
      { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Chain" }] },
    ]);
  });

  it("delegates to removeCardFromAllQueues when remainingCopies is 0", async () => {
    // removeCardFromAllQueues SELECT
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]),
      }],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 0);

    // Should have called removeCardFromAllQueues path
    expect(client.execute).toHaveBeenCalled();
  });

  it("does nothing when no seat has excess entries", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 2);

    expect(client.batch).not.toHaveBeenCalled();
  });

  it("never triggers a pause even if first entry is emptied", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        seat: 1,
        queue_json: JSON.stringify([
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
        ]),
      }],
    });

    // remainingCopies=1, so one Bolt ref stays, one gets trimmed. Bottom-up, so index 1 is trimmed.
    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]);
  });
});
```

- [ ] **Step 15: Implement `trimExcessQueueEntries`**

```typescript
export async function trimExcessQueueEntries(
  client: Client,
  draftId: string,
  cardId: number,
  remainingCopies: number,
): Promise<void> {
  if (remainingCopies <= 0) {
    await removeCardFromAllQueues(client, draftId, cardId);
    return;
  }

  const result = await client.execute({
    sql: `SELECT seat, queue_json FROM seat_tokens WHERE draft_id = ? AND queue_json IS NOT NULL`,
    args: [draftId],
  });

  const updates: { seat: number; newQueue: QueueEntry[] }[] = [];

  for (const row of result.rows) {
    const seat = row.seat as number;
    const queue: QueueEntry[] = JSON.parse(row.queue_json as string);

    // Count references to this card
    let count = 0;
    for (const entry of queue) {
      count += entry.cards.filter((c) => c.id === cardId).length;
    }
    if (count <= remainingCopies) continue;

    // Remove excess from bottom (highest index) up
    let toRemove = count - remainingCopies;
    const newQueue: QueueEntry[] = [];

    // Build new queue, marking removals bottom-up
    // First pass: find which entries to trim (iterate in reverse)
    const removeAtEntry = new Set<number>();
    for (let i = queue.length - 1; i >= 0 && toRemove > 0; i--) {
      if (queue[i].cards.some((c) => c.id === cardId)) {
        removeAtEntry.add(i);
        toRemove--;
      }
    }

    // Second pass: build new queue
    for (let i = 0; i < queue.length; i++) {
      if (removeAtEntry.has(i)) {
        const filteredCards = queue[i].cards.filter((c) => c.id !== cardId);
        if (filteredCards.length > 0) {
          newQueue.push({ ...queue[i], cards: filteredCards });
        }
        // else: entry removed entirely
      } else {
        newQueue.push(queue[i]);
      }
    }

    updates.push({ seat, newQueue });
  }

  if (updates.length > 0) {
    await client.batch(
      updates.map(({ seat, newQueue }) => ({
        sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
        args: [JSON.stringify(newQueue), draftId, seat] as (string | number)[],
      })),
    );
  }
}
```

- [ ] **Step 16: Run tests to verify `trimExcessQueueEntries` passes**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`

- [ ] **Step 17: Write a helper `fulfillGroupEntry` and test it**

This helper removes an entire group entry from a specific seat's queue (called after auto-picking from a group).

```typescript
// Test
describe("fulfillGroupEntry", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("removes the entry at the given index", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        queue_json: JSON.stringify([
          { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
          { mode: "pause", cards: [{ id: 30, name: "Recall" }] },
        ]),
      }],
    });

    await fulfillGroupEntry(client, "draft-1", 1, 0);

    const call = client.execute.mock.calls[1][0]; // second call is the UPDATE
    const json = JSON.parse(call.args[0] as string);
    expect(json).toEqual([{ mode: "pause", cards: [{ id: 30, name: "Recall" }] }]);
  });
});
```

```typescript
// Implementation
export async function fulfillGroupEntry(
  client: Client,
  draftId: string,
  seat: number,
  entryIndex: number,
): Promise<void> {
  const queue = await getQueue(client, draftId, seat);
  const newQueue = queue.filter((_, i) => i !== entryIndex);
  await setQueue(client, draftId, seat, newQueue);
}
```

- [ ] **Step 18: Run all pickQueue tests**

Run: `pnpm vitest run src/core/db/queries/pickQueue.test.ts`
Expected: All PASS.

- [ ] **Step 19: Remove `getQueuesContainingCard` export**

This function is no longer needed — `removeCardFromAllQueues` now handles pause detection internally. Remove the function from `pickQueue.ts`. Check that nothing else imports it.

Run: `grep -r "getQueuesContainingCard" src/` to verify only `pickQueue.ts` and `processPick.ts` reference it. The `processPick.ts` import will be updated in Task 3.

- [ ] **Step 20: Commit**

```bash
git add src/core/db/queries/pickQueue.ts src/core/db/queries/pickQueue.test.ts
git commit -m "Rewrite pickQueue to JSON-based queue with groups and per-entry modes"
```

### Task 2: Update seatTokens.ts — Remove autoPickMode

**Files:**
- Modify: `src/core/db/queries/seatTokens.ts`

- [ ] **Step 1: Remove `updateAutoPickMode` function** (lines 99-109)

- [ ] **Step 2: Remove `autoPickMode` from `resolveToken` return type and query** (lines 26-43)

Update the SQL to not select `auto_pick_mode`, and remove `autoPickMode` from the return object.

- [ ] **Step 3: Remove `autoPickMode` from `getAllSeatSettings`** (lines 133-150)

Update SQL, return type, and map construction to exclude `autoPickMode`.

- [ ] **Step 4: Remove `autoPickMode` from `getSeatSettings`** (lines 156-172)

Update SQL, return type, and return object to exclude `autoPickMode`.

- [ ] **Step 5: Run existing tests to check for breakage**

Run: `pnpm vitest run src/`
Expected: Some tests may fail due to removed `autoPickMode` references. Note which ones need updating.

- [ ] **Step 6: Commit**

```bash
git add src/core/db/queries/seatTokens.ts
git commit -m "Remove autoPickMode from seatTokens queries"
```

### Task 3: Update processPick.ts — New Auto-Pick Cascade

**Files:**
- Modify: `src/core/processPick.ts`
- Modify: `src/core/processPick.test.ts`

- [ ] **Step 1: Update imports in processPick.ts**

Replace:
```typescript
import { removeCardFromAllQueues, trimExcessQueueEntries, getAutoPickCandidate, getQueuesContainingCard } from './db/queries/pickQueue';
```
With:
```typescript
import { removeCardFromAllQueues, trimExcessQueueEntries, getAutoPickCandidate, fulfillGroupEntry } from './db/queries/pickQueue';
```

- [ ] **Step 2: Replace the cautious-mode pause block** (lines 139-156)

Replace the entire `if (isLastCopy)` block with:

```typescript
    if (isLastCopy) {
      const { pauseSeats } = await removeCardFromAllQueues(client, input.draftId, currentCardId);
      // Disable auto-pick for seats whose first entry was exhausted with pause mode
      await Promise.all(
        pauseSeats
          .filter((s) => s !== currentSeat)
          .map(async (s) => {
            await updateAutoPick(client, input.draftId, s, false);
            const prev = allSeatSettings.get(s);
            if (prev) allSeatSettings.set(s, { ...prev, autoPick: false });
          })
      );
      await removeFloatedCardByCardId(client, input.draftId, currentCardId);
    } else {
      await trimExcessQueueEntries(client, input.draftId, currentCardId, remainingAfterPick);
    }
```

- [ ] **Step 3: Replace the auto-pick candidate section** (lines 198-213)

Replace the entire block from `const candidate = await getAutoPickCandidate` through `currentCardName = cardRow.rows[0].name as string;` with:

```typescript
    const autoPickResult = await getAutoPickCandidate(
      client, input.draftId, nextAfter.seat, availableSet,
    );
    if (autoPickResult.kind !== 'candidate') {
      if (autoPickResult.kind === 'paused') {
        await updateAutoPick(client, input.draftId, nextAfter.seat, false);
        allSeatSettings.set(nextAfter.seat, { ...nextSettings, autoPick: false });
      }
      break;
    }

    // Fulfill the group entry (remove entire entry from picking seat's queue)
    await fulfillGroupEntry(client, input.draftId, nextAfter.seat, autoPickResult.entryIndex);

    const candidate = autoPickResult.cardId;

    // Look up card name for the candidate
    const cardRow = await client.execute({
      sql: `SELECT name FROM cards WHERE card_id = ?`,
      args: [candidate],
    });
    if (cardRow.rows.length === 0) break;

    currentSeat = nextAfter.seat;
    currentCardId = candidate;
    currentCardName = cardRow.rows[0].name as string;
```

- [ ] **Step 4: Remove `getQueuesContainingCard` import** (already done in step 1)

- [ ] **Step 5: Update processPick tests**

Update mocks in `processPick.test.ts`:
- Mock `getAutoPickCandidate` to return `AutoPickResult` objects instead of `number | null`
- Mock `fulfillGroupEntry` as a no-op
- Remove mocks for `getQueuesContainingCard`
- Update `removeCardFromAllQueues` mock to return `{ pauseSeats: [] }` or `{ pauseSeats: [seatNum] }` as needed
- Remove `autoPickMode` from `getAllSeatSettings` mock returns

- [ ] **Step 6: Run processPick tests**

Run: `pnpm vitest run src/core/processPick.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/processPick.ts src/core/processPick.test.ts
git commit -m "Update auto-pick cascade for grouped queue entries with per-entry modes"
```

### Task 4: Schema Migration

**Files:**
- Modify: `src/core/db/schema.sql`
- Modify: `src/core/db/migrate.ts`

- [ ] **Step 1: Add `queue_json` column to schema.sql**

After the existing `seat_tokens` CREATE TABLE (line 149), add:

```sql
ALTER TABLE seat_tokens ADD COLUMN queue_json TEXT;
```

Keep the `auto_pick_mode` ALTER and `pick_queue` CREATE TABLE in schema.sql for now — they're needed for the migration to read existing data. They'll be cleaned up after migration runs.

- [ ] **Step 2: Add migration logic in migrate.ts**

After the existing schema execution, add a data migration step:

```typescript
// Migrate pick_queue rows to queue_json on seat_tokens
async function migrateQueueToJson(client: Client) {
  // Check if pick_queue table exists
  const tableCheck = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='pick_queue'`,
    args: [],
  });
  if (tableCheck.rows.length === 0) return; // Already migrated

  // Check if queue_json column exists (migration may have already added it)
  const colCheck = await client.execute({
    sql: `PRAGMA table_info(seat_tokens)`,
    args: [],
  });
  const hasQueueJson = colCheck.rows.some((r) => r.name === 'queue_json');
  if (!hasQueueJson) return; // Column not yet added, skip

  // Read all queue entries joined with card names
  const entries = await client.execute({
    sql: `SELECT pq.draft_id, pq.seat, pq.priority, pq.card_id, c.name
          FROM pick_queue pq
          JOIN cards c ON c.card_id = pq.card_id
          ORDER BY pq.draft_id, pq.seat, pq.priority`,
    args: [],
  });

  // Group by (draft_id, seat)
  const grouped = new Map<string, { id: number; name: string }[]>();
  for (const row of entries.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    const arr = grouped.get(key) ?? [];
    arr.push({ id: row.card_id as number, name: row.name as string });
    grouped.set(key, arr);
  }

  // Write JSON to seat_tokens
  const statements = [];
  for (const [key, cards] of grouped) {
    const [draftId, seatStr] = key.split(':');
    const queueJson = cards.map((c) => ({
      mode: 'pause',
      cards: [{ id: c.id, name: c.name }],
    }));
    statements.push({
      sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
      args: [JSON.stringify(queueJson), draftId, parseInt(seatStr)] as (string | number)[],
    });
  }

  // Set empty queue for seats without queue entries
  statements.push({
    sql: `UPDATE seat_tokens SET queue_json = '[]' WHERE queue_json IS NULL`,
    args: [],
  });

  if (statements.length > 0) {
    await client.batch(statements);
  }

  // Drop pick_queue table and auto_pick_mode column
  await client.execute({ sql: `DROP TABLE IF EXISTS pick_queue`, args: [] });
  await client.execute({ sql: `ALTER TABLE seat_tokens DROP COLUMN auto_pick_mode`, args: [] });
}
```

Call `migrateQueueToJson(client)` at the end of the `migrate()` function.

- [ ] **Step 3: Run migration locally**

Run: `pnpm db:migrate`
Expected: Migration completes. Verify with `turso db shell read-the-bones` that `queue_json` column exists and `pick_queue` table is gone.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/schema.sql src/core/db/migrate.ts
git commit -m "Add queue_json column migration, drop pick_queue table"
```

---

## Chunk 2: API Layer

### Task 5: Update Queue API Route

**Files:**
- Modify: `src/app/api/drafts/[id]/queue/route.ts`

- [ ] **Step 1: Update GET handler**

Replace the current GET handler to read from `getQueue` (which now returns `QueueEntry[]`) and return the structured format:

```typescript
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const tokenData = await authenticateSeat(req, draftId);
  if (!tokenData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const client = getClient();
  const queue = await getQueue(client, draftId, tokenData.seat);
  return NextResponse.json({ queue });
}
```

- [ ] **Step 2: Update PUT handler**

Accept the new structured format. Validate entries, resolve card names to IDs, compute float diffs on flattened card name sets, and store via `setQueue`.

The request body is an array of `{ mode?, cards: (string | { cardName: string })[] }`. The server normalizes card references to `{ id, name }` objects.

```typescript
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: draftId } = await params;
  const tokenData = await authenticateSeat(req, draftId);
  if (!tokenData) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  if (!Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be an array" }, { status: 400 });
  }

  // Validate and normalize entries
  const entries: { mode: string; cards: string[] }[] = [];
  let totalCards = 0;
  const allCardNames = new Set<string>();

  for (const entry of body) {
    if (!entry.cards || !Array.isArray(entry.cards) || entry.cards.length === 0) {
      return NextResponse.json({ error: "Each entry must have a non-empty cards array" }, { status: 400 });
    }
    const mode = entry.mode || 'pause';
    if (mode !== 'pause' && mode !== 'flow-through') {
      return NextResponse.json({ error: "Mode must be 'pause' or 'flow-through'" }, { status: 400 });
    }
    const cardNames: string[] = entry.cards.map((c: string | { cardName: string }) =>
      typeof c === 'string' ? c : c.cardName
    );
    for (const name of cardNames) {
      if (allCardNames.has(name)) {
        return NextResponse.json({ error: `Duplicate card: ${name}` }, { status: 400 });
      }
      allCardNames.add(name);
    }
    totalCards += cardNames.length;
    entries.push({ mode, cards: cardNames });
  }

  if (totalCards > 500) {
    return NextResponse.json({ error: "Queue cannot exceed 500 cards" }, { status: 400 });
  }

  // Resolve all card names to IDs in a single query
  const client = getClient();
  const allNames = [...allCardNames];
  const placeholders = allNames.map(() => '?').join(',');
  const cardRows = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE name IN (${placeholders})`,
    args: allNames,
  });
  const nameToId = new Map<string, number>();
  for (const row of cardRows.rows) {
    nameToId.set(row.name as string, row.card_id as number);
  }

  // Validate all names resolved
  for (const name of allNames) {
    if (!nameToId.has(name)) {
      return NextResponse.json({ error: `Unknown card: ${name}` }, { status: 400 });
    }
  }

  // Build QueueEntry[] with { id, name } cards
  const queueEntries: QueueEntry[] = entries.map((e) => ({
    mode: e.mode as 'pause' | 'flow-through',
    cards: e.cards.map((name) => ({ id: nameToId.get(name)!, name })),
  }));

  // Float diff: compare flattened old vs new card name sets
  const oldQueue = await getQueue(client, draftId, tokenData.seat);
  const oldNames = new Set(oldQueue.flatMap((e) => e.cards.map((c) => c.name)));
  const newNames = allCardNames;

  // Auto-float cards removed from queue
  const removed = [...oldNames].filter((n) => !newNames.has(n));
  for (const name of removed) {
    await addFloatedCard(client, draftId, tokenData.seat, name);
  }

  // Auto-unfloat cards added to queue (queue supersedes float)
  const added = [...newNames].filter((n) => !oldNames.has(n));
  for (const name of added) {
    await removeFloatedCard(client, draftId, tokenData.seat, name);
  }

  await setQueue(client, draftId, tokenData.seat, queueEntries);
  return NextResponse.json({ queue: queueEntries });
}
```

Import `QueueEntry` from `pickQueue.ts` and the float management functions (adapt from existing imports in the current route).

- [ ] **Step 3: Run the full test suite to check for breakage**

Run: `pnpm vitest run`
Expected: Tests pass (some may need updating if they mock the queue route).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/drafts/[id]/queue/route.ts
git commit -m "Update queue API for structured entries with groups and modes"
```

### Task 6: Update seat-settings and /me Routes

**Files:**
- Modify: `src/app/api/drafts/[id]/seat-settings/route.ts`
- Modify: `src/app/api/drafts/[id]/me/route.ts`

- [ ] **Step 1: Remove `auto_pick_mode` from seat-settings PUT**

Remove the `auto_pick_mode` validation and `updateAutoPickMode` call (lines 32-36 in seat-settings route). Remove `autoPickMode` from the response body.

- [ ] **Step 2: Remove `autoPickMode` from /me GET response**

Remove `autoPickMode` from the response object (line ~27 in me route).

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/drafts/[id]/seat-settings/route.ts src/app/api/drafts/[id]/me/route.ts
git commit -m "Remove autoPickMode from seat-settings and /me routes"
```

---

## Chunk 3: Client-Side Store

### Task 7: Update LiveStore for New Queue Shape

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Modify: `src/app/stores/liveStore.test.ts`
- Modify: `src/app/stores/selectors.test.ts` (remove `autoPickMode` from mock state)
- Modify: `src/app/components/draft-board/PageClient.test.tsx` (remove `autoPickMode` from mock state)

- [ ] **Step 1: Update types**

Replace:
```typescript
export interface QueueEntry {
  priority: number;
  cardId: number;
  cardName: string;
}
```

With:
```typescript
export interface QueueCard {
  cardId: number;
  cardName: string;
}

export interface QueueGroupEntry {
  mode: 'pause' | 'flow-through';
  cards: QueueCard[];
}
```

- [ ] **Step 2: Update `deriveQueuedCardCounts`**

```typescript
function deriveQueuedCardCounts(queue: QueueGroupEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of queue) {
    for (const card of entry.cards) {
      counts.set(card.cardName, (counts.get(card.cardName) ?? 0) + 1);
    }
  }
  return counts;
}
```

- [ ] **Step 3: Update `LiveStoreState` interface**

- Change `queue: QueueEntry[]` to `queue: QueueGroupEntry[]`
- Remove `autoPickMode` state
- Remove `updateAutoPickMode` action
- Remove `removeFromQueueByPriority` action
- Change `reorderQueue` signature to `(entries: QueueGroupEntry[]) => void`
- Add `setEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => void`

- [ ] **Step 4: Update `syncQueue` helper**

Change from sending flat `{ card_name }` array to sending the structured format:

```typescript
async function syncQueue(set: SetState, get: GetState, newQueue: QueueGroupEntry[], previousQueue?: QueueGroupEntry[]) {
  const { seatToken } = get();
  const fallbackQueue = previousQueue ?? get().queue;
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft) return;

  set({ queueLoading: true });
  try {
    const body = newQueue.map((entry) => ({
      mode: entry.mode,
      cards: entry.cards.map((c) => c.cardName),
    }));
    const res = await fetch(`/api/drafts/${activeDraft}/queue`, {
      method: "PUT",
      headers: { "X-Seat-Token": seatToken, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      set({ queue: data.queue, queuedCardCounts: deriveQueuedCardCounts(data.queue), queueError: null });
    } else {
      set({ queue: fallbackQueue, queuedCardCounts: deriveQueuedCardCounts(fallbackQueue), queueError: "Failed to sync queue" });
    }
  } catch {
    set({ queue: fallbackQueue, queuedCardCounts: deriveQueuedCardCounts(fallbackQueue), queueError: "Failed to sync queue" });
  }
  set({ queueLoading: false });
}
```

- [ ] **Step 5: Update store actions**

- `fetchMySeat`: Remove `autoPickMode` from `set()` call
- `refreshSettings`: Remove `autoPickMode` from `set()` call
- Remove `updateAutoPickMode` action entirely
- Update `fetchQueue` to expect new response shape
- Update `addToQueue`: append `{ mode: 'pause', cards: [{ cardId: 0, cardName }] }` entry
- Update `removeFromQueue`: find entry containing card, remove card from it, remove empty entries
- Remove `removeFromQueueByPriority`
- Update `reorderQueue` to accept `QueueGroupEntry[]`
- Add `setEntryMode` action:
```typescript
setEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => {
  const { queue: original } = get();
  const newQueue = original.map((entry, i) =>
    i === entryIndex ? { ...entry, mode } : entry
  );
  set({ queue: newQueue, queuedCardCounts: deriveQueuedCardCounts(newQueue) });
  syncQueue(set, get, newQueue, original);
},
```

- [ ] **Step 6: Update `triggerAutoPick`**

```typescript
async function triggerAutoPick() {
  if (autoPickInFlight) return;
  autoPickInFlight = true;
  try {
    await useLiveStore.getState().refreshSettings();
    const { autoPick } = useLiveStore.getState();
    if (!autoPick) return;

    await useLiveStore.getState().fetchQueue();
    const { queue } = useLiveStore.getState();
    if (queue.length === 0) return;

    for (const entry of queue) {
      // Try each card in the entry
      let pickedFromEntry = false;
      for (const card of entry.cards) {
        await useLiveStore.getState().handlePick(card.cardName);
        if (!useLiveStore.getState().pickError) {
          pickedFromEntry = true;
          break; // Pick succeeded
        }
        // Card unavailable, try next in group
        useLiveStore.getState().setPickError(null);
      }
      if (pickedFromEntry) break;
      // Entry exhausted
      if (entry.mode === 'pause') break; // Stop
      // flow-through: continue to next entry
    }
  } finally {
    autoPickInFlight = false;
  }
}
```

- [ ] **Step 7: Update liveStore tests and related test files**

Update all tests referencing `autoPickMode`, `QueueEntry`, the old queue format, or `removeFromQueueByPriority`:
- `src/app/stores/liveStore.test.ts`: Update mock queue data to use `QueueGroupEntry[]` shape, remove `autoPickMode` from mock state, update queue action test expectations
- `src/app/stores/selectors.test.ts`: Remove `autoPickMode: "resilient"` from mock state objects
- `src/app/components/draft-board/PageClient.test.tsx`: Remove `autoPickMode` from mock state objects
- `src/app/api/drafts/[id]/seat-settings/route.test.ts`: Remove `autoPickMode` assertions from response checks

- [ ] **Step 8: Run tests**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Update LiveStore for grouped queue entries with per-entry modes"
```

---

## Chunk 4: UI — Drag-and-Drop Queue Panel

### Task 8: Rewrite QueuePanel with @dnd-kit

**Files:**
- Rewrite: `src/app/components/draft-board/QueuePanel.tsx`
- Rewrite: `src/app/components/draft-board/QueuePanel.test.tsx`

- [ ] **Step 1: Define component types and props**

```typescript
import type { QueueGroupEntry } from "../../stores/liveStore";

export type QueuePanelProps = {
  queue: QueueGroupEntry[];
  autoPick: boolean;
  onReorder: (queue: QueueGroupEntry[]) => void;
  onRemove: (cardName: string) => void;
  onToggleAutoPick: () => void;
  onSetEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => void;
  takenCards?: Set<string>;
};
```

- [ ] **Step 2: Build the QueuePanel layout**

Structure:
- Auto-pick checkbox (same as current, minus mode radio buttons)
- Entry list wrapped in `<DndContext>` from `@dnd-kit/core`
- Each entry rendered as either a single-card row or a group container
- Mode toggle button on each entry
- Remove buttons on individual cards

Follow the `@dnd-kit` patterns from `DeckBuilderPanel.tsx`:
- `DndContext` with `PointerSensor` and `KeyboardSensor`
- `useSortable` for each draggable item
- `DragOverlay` for the dragged item preview

- [ ] **Step 3: Implement drag interactions**

Key behaviors:
- **Drop between entries** (gap detection): Reorder top-level entries
- **Drop onto entry** (overlap detection): Merge into group. The target entry highlights when hovered.
- **Drag within group**: Reorder cards within the group
- **Drag out of group**: Move card to top level as new single-card entry. If source group has 1 card left, collapse to single-card entry.

Use `@dnd-kit`'s `closestCenter` collision detection combined with custom logic to distinguish "between" vs "onto" drops. The `DragOverlay` shows the card being dragged.

All drag end events call `onReorder(newQueue)` with the rebuilt `QueueGroupEntry[]`.

- [ ] **Step 4: Write QueuePanel tests**

```typescript
// src/app/components/draft-board/QueuePanel.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueuePanel } from "./QueuePanel";
import type { QueueGroupEntry } from "../../stores/liveStore";

describe("QueuePanel", () => {
  const singleEntryQueue: QueueGroupEntry[] = [
    { mode: "pause", cards: [{ cardId: 10, cardName: "Lightning Bolt" }] },
    { mode: "flow-through", cards: [{ cardId: 20, cardName: "Counterspell" }] },
  ];

  const groupEntryQueue: QueueGroupEntry[] = [
    { mode: "flow-through", cards: [
      { cardId: 10, cardName: "Counterspell" },
      { cardId: 20, cardName: "Mana Drain" },
      { cardId: 30, cardName: "Arcane Denial" },
    ]},
    { mode: "pause", cards: [{ cardId: 40, cardName: "Demonic Tutor" }] },
  ];

  const defaultProps = {
    queue: singleEntryQueue,
    autoPick: true,
    onReorder: vi.fn(),
    onRemove: vi.fn(),
    onToggleAutoPick: vi.fn(),
    onSetEntryMode: vi.fn(),
  };

  afterEach(() => { cleanup(); });

  it("renders single-card entries", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText("Lightning Bolt")).toBeTruthy();
    expect(screen.getByText("Counterspell")).toBeTruthy();
  });

  it("renders group entries with all cards", () => {
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} />);
    expect(screen.getByText("Counterspell")).toBeTruthy();
    expect(screen.getByText("Mana Drain")).toBeTruthy();
    expect(screen.getByText("Arcane Denial")).toBeTruthy();
    expect(screen.getByText("Demonic Tutor")).toBeTruthy();
  });

  it("shows mode indicator on each entry", () => {
    render(<QueuePanel {...defaultProps} />);
    // First entry is pause, second is flow-through
    const modeButtons = screen.getAllByRole("button", { name: /mode/i });
    expect(modeButtons).toHaveLength(2);
  });

  it("calls onSetEntryMode when mode toggle is clicked", () => {
    const onSetEntryMode = vi.fn();
    render(<QueuePanel {...defaultProps} onSetEntryMode={onSetEntryMode} />);
    const modeButtons = screen.getAllByRole("button", { name: /mode/i });
    fireEvent.click(modeButtons[0]); // Toggle first entry from pause to flow-through
    expect(onSetEntryMode).toHaveBeenCalledWith(0, "flow-through");
  });

  it("calls onRemove when remove button is clicked", () => {
    const onRemove = vi.fn();
    render(<QueuePanel {...defaultProps} onRemove={onRemove} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("Lightning Bolt");
  });

  it("shows empty state", () => {
    render(<QueuePanel {...defaultProps} queue={[]} />);
    expect(screen.getByText(/empty/i)).toBeTruthy();
  });

  it("shows auto-pick toggle", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("renders taken cards with strike-through", () => {
    render(
      <QueuePanel
        {...defaultProps}
        takenCards={new Set(["Lightning Bolt"])}
      />
    );
    const bolt = screen.getByText("Lightning Bolt");
    expect(bolt.className).toContain("line-through");
  });
});
```

- [ ] **Step 5: Run QueuePanel tests**

Run: `pnpm vitest run src/app/components/draft-board/QueuePanel.test.tsx`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/draft-board/QueuePanel.tsx src/app/components/draft-board/QueuePanel.test.tsx
git commit -m "Rewrite QueuePanel with drag-and-drop groups and per-entry mode toggles"
```

### Task 9: Update QueuePanel Consumers

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx` (primary consumer)
- Any other files found by search

- [ ] **Step 1: Find all consumers**

Run: `grep -r "QueuePanel\|QueueItem\|autoPickMode\|onChangeAutoPickMode\|removeFromQueueByPriority" src/app/`

- [ ] **Step 2: Update DraftBoardModal.tsx (primary consumer)**

This is the main file that wires QueuePanel to the store. Changes needed:
- Remove store selectors for `autoPickMode`, `removeFromQueueByPriority`, `updateAutoPickMode`
- Add `setEntryMode` selector from liveStore
- Change `onRemove` from `(cardName, position) => ...` to `(cardName) => ...`
- Change `onReorder` from passing flat `string[]` to passing `QueueGroupEntry[]`
- Add `onSetEntryMode` prop wired to `setEntryMode`
- Remove `autoPickMode` and `onChangeAutoPickMode` props from `<QueuePanel>`
- Pass `takenCards` set derived from card data if available

- [ ] **Step 3: Update any other consumers found in Step 1**

Apply the same pattern: remove old props, add new ones.

- [ ] **Step 4: Run full test suite**

Run: `pnpm vitest run`
Expected: All PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: No errors. Fix any unused exports/imports flagged by knip.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/draft-board/DraftBoardModal.tsx src/app/components/draft-board/QueuePanel.tsx
git commit -m "Wire up new QueuePanel props to all consumers"
```

---

## Chunk 5: Integration & Cleanup

### Task 10: End-to-End Testing

**Files:**
- Create: `e2e/queue-groups.spec.ts`
- Check existing e2e tests in `e2e/` directory for queue-related scenarios that need updating

- [ ] **Step 1: Identify existing e2e tests that touch the queue**

Run: `grep -r "queue\|autoPick\|auto.pick\|autoPickMode" e2e/`

Update any references to the old queue format or `autoPickMode`.

- [ ] **Step 2: Create e2e test file with setup helper**

Create `e2e/queue-groups.spec.ts`. The test setup should:
1. Create a live draft via CLI (`pnpm draft:create-live`)
2. Start the draft (`pnpm draft:start`)
3. Use the queue API directly (via `request.put` with seat token) to seed queue state
4. Use the pick API to simulate picks
5. Verify queue state via GET

```typescript
// e2e/queue-groups.spec.ts
import { test, expect } from "@playwright/test";

// Helper to set queue via API
async function setQueue(request, draftId: string, token: string, entries: any[]) {
  return request.put(`/api/drafts/${draftId}/queue`, {
    headers: { "X-Seat-Token": token, "Content-Type": "application/json" },
    data: entries,
  });
}

// Helper to get queue via API
async function getQueue(request, draftId: string, token: string) {
  const res = await request.get(`/api/drafts/${draftId}/queue`, {
    headers: { "X-Seat-Token": token },
  });
  return res.json();
}
```

- [ ] **Step 3: Add e2e test: flow-through skips exhausted entries**

Set up a queue with `[{ mode: "flow-through", cards: ["CardA"] }, { mode: "pause", cards: ["CardB"] }]`. Pick CardA with another seat. Verify that auto-pick for the queuing seat picks CardB (flow-through skips exhausted first entry).

- [ ] **Step 4: Add e2e test: pause stops auto-pick**

Set up a queue with `[{ mode: "pause", cards: ["CardA"] }, { mode: "pause", cards: ["CardB"] }]`. Pick CardA with another seat (last copy). Verify that auto-pick is disabled for the queuing seat.

- [ ] **Step 5: Add e2e test: group pick removes entire group**

Set up a queue with `[{ mode: "flow-through", cards: ["CardA", "CardB", "CardC"] }, { mode: "pause", cards: ["CardD"] }]`. Trigger auto-pick which picks CardA. Verify the entire group (CardA, CardB, CardC) is removed from the queue, and only the CardD entry remains.

- [ ] **Step 6: Run e2e tests**

Run: `pnpm test:e2e`

- [ ] **Step 7: Commit**

```bash
git add e2e/queue-groups.spec.ts
git commit -m "Add e2e tests for queue groups and per-entry modes"
```

### Task 11: Clean Up Schema and Run Final Checks

**Files:**
- Modify: `src/core/db/schema.sql`

- [ ] **Step 1: Remove `CREATE TABLE IF NOT EXISTS pick_queue` block from schema.sql**

Find the `CREATE TABLE IF NOT EXISTS pick_queue` statement and remove the entire block (through the closing `);`). The table has been dropped by migration.

- [ ] **Step 2: Remove `ALTER TABLE seat_tokens ADD COLUMN auto_pick_mode` from schema.sql**

Find the `ALTER TABLE seat_tokens ADD COLUMN auto_pick_mode` statement and remove it. The column has been dropped by migration.

- [ ] **Step 3: Verify `ALTER TABLE seat_tokens ADD COLUMN queue_json TEXT` exists in schema.sql**

This should have been added in Task 4. If not present, add it after the `seat_tokens` CREATE TABLE.

- [ ] **Step 4: Run `pnpm precommit`**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, tests, e2e all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/schema.sql
git commit -m "Clean up schema: remove pick_queue table and auto_pick_mode column"
```
