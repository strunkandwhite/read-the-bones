# Auto-Pick Queue Commit and Cron Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-pick from deleting queue entries it never picks, and give live drafts a server-side heartbeat so a stalled turn does not need an open browser to recover.

**Architecture:** `selectAutoPickCandidateForSeat` currently removes the chosen queue entry (`fulfillGroupEntry`) and demotes the group's other cards to float *while choosing* the card. The pick itself is inserted later, by `insertPickAndCascade`. Any selection that never becomes a pick — a trigger that loses the `pick_n` race against a concurrent one, or a cascade that stops at its depth cap — therefore consumes a queue entry with nothing to show for it. We make selection read-only, thread the chosen `entryIndex` through to the insert, and commit the queue change only after `insertPickEvent` reports a row. Separately, the once-a-minute cron currently returns early unless a Google Sheets draft is active, so in-app drafts get no server-side nudge at all; we run `resumeAutoPickForCurrentSeat` for every in-app drafting draft before that early return.

**Tech Stack:** TypeScript, Next.js App Router, libSQL/Turso, Vitest, pnpm, Vercel Cron.

## Background

Diagnosed 2026-08-10 against the live `kishla-skimmer` draft, from seat 7's report that "many cards in my queue got skipped and I ended up with the two at the bottom."

The queue walk itself is sound: `getAutoPickCandidate` returns the first available card top-down and cannot pass over an available entry. The damage happens before the walk's result is ever committed. Reproduced against the real engine — four concurrent `{auto:true}` triggers on one turn (seat 7 had the draft open in three places, and the server cascade makes a fourth caller):

```
queue before: Q0, Q1, Q2, Q3, Q4, Q5, Q6, Q7
picked:       Q0
queue after:  Q4, Q5, Q6, Q7
VANISHED:     Q1, Q2, Q3
```

Each loser throws `ConflictError` → 409, which `src/app/stores/live/picking.ts:53` treats as "already handled — just refresh", so nothing surfaces to the player. The same premature removal fires when the cascade hits `maxCascade = numSeats * 2`: the final `advanceAutoPick` selects (and deletes) the next seat's entry, then the loop exits without inserting.

`autoPickInFlight` in `picking.ts` is module-scoped, so it deduplicates within a tab only — every open tab is an independent caller.

**Out of scope, deliberately:** the per-card vs per-slot pause semantics. Seat 7 also observed that a `pause` entry sitting mid-queue is deleted along with its card when another seat takes it, so the pause never fires (it only fires at entry index 0). That is real and confirmed, but it is a design change to the pause model and belongs in its own spec. Do not change pause behavior in this plan.

## Global Constraints

- A live draft (`kishla-skimmer`) is mid-flight. Every change must be backward compatible with in-progress drafts; no destructive migrations, no data rewrites. This plan needs **no schema change at all**.
- Never change the `pause` default for new queue entries (`src/app/stores/live/queueFloat.ts:204`).
- Do not change pause/flow-through traversal semantics in `getAutoPickCandidate`.
- Existing public behavior of `POST /api/drafts/[id]/pick` must not change for either `{card_name}` or `{auto:true}`. Both still return `picks[]`; `{auto:true}` still returns `pickedCard` and `autoPickDisabled`.
- All git commands use `git -C /Users/arpanet/code/read-the-bones ...`. Never combine `cd` and `git`.
- Vercel cron granularity is one minute (5-field cron expression, no seconds field). `vercel.json` is already at `* * * * *`; do not attempt a shorter interval.
- The client-side auto-pick trigger stays. The cron is a safety net for stalled chains, not a replacement — it would add up to 60s of latency on every turn.
- Quality gates: `pnpm typecheck`, `pnpm lint` (zero warnings), `pnpm knip`, `pnpm test`. Run `pnpm precommit` before any push (a husky pre-push hook enforces it).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/db/queries/pickQueue.ts` | Queue storage and traversal | Modify — `fulfillGroupEntry` takes the picked `cardId` and returns `QueueEntry \| null` |
| `src/core/db/queries/pickQueue.test.ts` | Query-layer unit tests | Modify — update the `fulfillGroupEntry` describe block |
| `src/core/processPick.ts` | Pick engine: validation, insert, cascade, auto-pick entry points | Modify — read-only selection, `entryIndex` threading, new `commitQueueEntryForPick` |
| `src/core/processPick.test.ts` | Engine unit tests (mocked client) | Modify — the tests that assert the old call ordering |
| `src/core/processPick.queueCommit.test.ts` | Regression guard: no entry is consumed without a pick | Create |
| `src/core/db/sync/lock.ts` | Sync lock and active-draft queries | Modify — add `getLiveDraftingDrafts` |
| `src/core/db/sync/lock.test.ts` | Query test for the new selector | Create |
| `src/app/api/sync/route.ts` | Vercel cron entry point | Modify — run the auto-pick heartbeat before the Sheets early return |
| `src/app/api/sync/route.test.ts` | Cron route tests | Modify — cover the heartbeat |
| `CLAUDE.md` | Project docs | Modify — describe the heartbeat on the `/api/sync` bullet |

---

### Task 1: Make auto-pick candidate selection read-only

**Files:**
- Modify: `src/core/db/queries/pickQueue.ts:200-216`
- Modify: `src/core/db/queries/pickQueue.test.ts:429-450`
- Modify: `src/core/processPick.ts`
- Modify: `src/core/processPick.test.ts`
- Create: `src/core/processPick.queueCommit.test.ts`

**Interfaces:**
- Consumes: existing `getAutoPickCandidate`, `addFloatedCard`, `updateAutoPick`, `insertPickEvent`, `advanceAutoPick`, `getAllSeatSettings`, `getDraftMeta`, `getNextPick`, `getLatestPickNumber`, `getTotalPicks` — all already present.
- Produces:
  ```ts
  // src/core/db/queries/pickQueue.ts
  export async function fulfillGroupEntry(
    client: Client, draftId: string, seat: number, entryIndex: number, cardId: number,
  ): Promise<QueueEntry | null>

  // src/core/processPick.ts (module-private)
  type SeatCandidateResult =
    | { kind: 'candidate'; cardId: number; cardName: string; entryIndex: number }
    | { kind: 'paused' }
    | { kind: 'none' };

  type AutoPickAdvance =
    | { kind: 'candidate'; seat: number; cardId: number; cardName: string; entryIndex: number }
    | { kind: 'none' };

  async function commitQueueEntryForPick(
    client: Client, draftId: string, seat: number, entryIndex: number, pickedCardId: number,
  ): Promise<void>
  ```
  `insertPickAndCascade`'s `firstPick` parameter gains `entryIndex: number | null`.

- [ ] **Step 1: Write the failing regression test**

Create `src/core/processPick.queueCommit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@libsql/client';

// Stagger candidate selection so each call lands after the previous winner's
// insert. This is the shape of several browser tabs plus the server cascade all
// firing on the same seat's turn.
vi.mock('./db/queries/pickQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/queries/pickQueue')>();
  let calls = 0;
  return {
    ...actual,
    getAutoPickCandidate: async (...args: Parameters<typeof actual.getAutoPickCandidate>) => {
      const n = calls++;
      // Modulo bounds the total delay across the whole file: `calls` is
      // module-scoped and never resets between tests, so an unbounded `25 * n`
      // grows past the default 5s timeout by the file's later describe blocks.
      // `% 4` preserves the within-test stagger (each concurrent batch still
      // sees increasing 0/25/50/75ms delays relative to its own calls).
      const staggerIndex = n % 4;
      if (staggerIndex > 0) await new Promise((r) => setTimeout(r, 25 * staggerIndex));
      return actual.getAutoPickCandidate(...args);
    },
  };
});

const { processPick, triggerAutoPickOnDemand } = await import('./processPick');
const { getQueue } = await import('./db/queries/pickQueue');
const { getFloatedCards } = await import('./db/queries/floatedCards');
const {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} = await import('./db/__tests__/testDb');

const DRAFT = 'd1';
const QUEUE_NAMES = ['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7'];

function singleEntries(names: string[]) {
  return names.map((name) => ({
    mode: 'pause',
    cards: [{ id: 100 + QUEUE_NAMES.indexOf(name), name }],
  }));
}

/** Seat 1 auto-picks from an 8-card queue; seats 2 and 3 sit out. */
async function seedOneAutoPicker(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (let n = 0; n < QUEUE_NAMES.length; n++) {
    await insertCard(client, 100 + n, QUEUE_NAMES[n]);
    await insertCubeCard(client, 1, 100 + n, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 8, double_pick_after_round = 8, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, {
    autoPick: true, queueJson: JSON.stringify(singleEntries(QUEUE_NAMES)),
  });
  await insertSeatToken(client, DRAFT, 2, { autoPick: false, queueJson: '[]' });
  await insertSeatToken(client, DRAFT, 3, { autoPick: false, queueJson: '[]' });
  return client;
}

async function pickedNames(client: Client): Promise<Set<string>> {
  const r = await client.execute({
    sql: `SELECT c.name FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?`,
    args: [DRAFT],
  });
  return new Set(r.rows.map((row) => row.name as string));
}

async function queuedNames(client: Client, seat: number): Promise<string[]> {
  const q = await getQueue(client, DRAFT, seat);
  return q.flatMap((e) => e.cards.map((c) => c.name));
}

describe('a selection that never becomes a pick leaves the queue alone', () => {
  it('losing triggers do not consume queue entries', async () => {
    const client = await seedOneAutoPicker();

    await Promise.allSettled([
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
    ]);

    const picked = await pickedNames(client);
    const queued = await queuedNames(client, 1);
    const vanished = QUEUE_NAMES.filter((n) => !queued.includes(n) && !picked.has(n));

    expect(picked.size).toBe(1);
    expect(vanished).toEqual([]);
    expect(queued.length).toBe(QUEUE_NAMES.length - 1);
  });

  it('exactly one trigger wins and it takes the top of the queue', async () => {
    const client = await seedOneAutoPicker();

    const results = await Promise.allSettled([
      triggerAutoPickOnDemand(client, DRAFT, 1),
      triggerAutoPickOnDemand(client, DRAFT, 1),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await pickedNames(client)).toEqual(new Set(['Q0']));
    expect((await queuedNames(client, 1))[0]).toBe('Q1');
  });
});

describe('a cascade stopping at its depth cap leaves the queue alone', () => {
  it('does not consume the entry it was about to pick', async () => {
    const client = await createMemDb();
    await insertCubeSnapshot(client, 1);

    const cards: Array<[number, string]> = [[1, 'Manual']];
    for (let seat = 1; seat <= 3; seat++) {
      for (let n = 0; n < 6; n++) cards.push([seat * 100 + n, `S${seat}-${n}`]);
    }
    for (const [id, name] of cards) {
      await insertCard(client, id, name);
      await insertCubeCard(client, 1, id, 1);
    }
    await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
    await client.execute({
      sql: `UPDATE drafts SET picks_per_player = 6, double_pick_after_round = 6, in_app = 1 WHERE draft_id = ?`,
      args: [DRAFT],
    });
    for (let seat = 1; seat <= 3; seat++) {
      const entries = [];
      for (let n = 0; n < 6; n++) {
        entries.push({ mode: 'pause', cards: [{ id: seat * 100 + n, name: `S${seat}-${n}` }] });
      }
      await insertSeatToken(client, DRAFT, seat, { autoPick: true, queueJson: JSON.stringify(entries) });
    }

    const before = new Map<number, string[]>();
    for (let s = 1; s <= 3; s++) before.set(s, await queuedNames(client, s));

    // maxCascade is numSeats * 2 = 6, so this run is truncated mid-chain.
    const res = await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual' });
    expect(res.picks).toHaveLength(6);

    const picked = await pickedNames(client);
    const vanished: string[] = [];
    for (let s = 1; s <= 3; s++) {
      const after = await queuedNames(client, s);
      for (const name of before.get(s)!) {
        if (!after.includes(name) && !picked.has(name)) vanished.push(`seat ${s}: ${name}`);
      }
    }
    expect(vanished).toEqual([]);
  });
});

describe('a pick that does land still fulfills its group', () => {
  it('removes the whole group entry and floats the cards that lost out', async () => {
    const client = await createMemDb();
    await insertCubeSnapshot(client, 1);
    const cards: Array<[number, string]> = [
      [1, 'Manual'], [10, 'Group A'], [11, 'Group B'], [12, 'Group C'],
    ];
    for (const [id, name] of cards) {
      await insertCard(client, id, name);
      await insertCubeCard(client, 1, id, 1);
    }
    await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 2, cubeSnapshotId: 1 });
    await client.execute({
      sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
      args: [DRAFT],
    });
    await insertSeatToken(client, DRAFT, 1, { autoPick: false, queueJson: '[]' });
    await insertSeatToken(client, DRAFT, 2, {
      autoPick: true,
      queueJson: JSON.stringify([
        { mode: 'pause', cards: [{ id: 10, name: 'Group A' }, { id: 11, name: 'Group B' }, { id: 12, name: 'Group C' }] },
      ]),
    });

    const res = await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual' });
    const seat2Pick = res.picks.find((p) => p.seat === 2);
    expect(seat2Pick?.cardName).toBe('Group A');

    expect(await queuedNames(client, 2)).toEqual([]);
    expect((await getFloatedCards(client, DRAFT, 2)).sort()).toEqual(['Group B', 'Group C']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/processPick.queueCommit.test.ts`

Expected: the two "leaves the queue alone" tests FAIL — the concurrency one reports vanished entries (`['Q1', 'Q2', 'Q3']` or similar, depending on interleaving), the depth-cap one reports `['seat 1: S1-1']`. The group-fulfillment test PASSES, because that behavior is correct today and must stay correct.

- [ ] **Step 3: Make `fulfillGroupEntry` identify its entry by card, not just index**

In `src/core/db/queries/pickQueue.ts`, replace the whole `fulfillGroupEntry` function (currently lines 200-216, including its doc comment) with:

```ts
/**
 * Remove the queue entry a just-landed auto-pick consumed, and return it so the
 * caller can demote the cards that lost out to float. Picking any card in a
 * group fulfills the whole entry.
 *
 * `entryIndex` is where the entry sat when the candidate was chosen and `cardId`
 * is what actually got picked. The index is only trusted while the entry there
 * still holds that card: a queue PUT landing in between would otherwise shift
 * everything down and make the index point at an innocent entry. Returns null
 * when the card is no longer in the queue at all, meaning something else already
 * removed it and there is nothing left to fulfill.
 */
export async function fulfillGroupEntry(
  client: Client,
  draftId: string,
  seat: number,
  entryIndex: number,
  cardId: number,
): Promise<QueueEntry | null> {
  const queue = await getQueue(client, draftId, seat);

  const indexHoldsCard = queue[entryIndex]?.cards.some((c) => c.id === cardId) ?? false;
  const index = indexHoldsCard
    ? entryIndex
    : queue.findIndex((entry) => entry.cards.some((c) => c.id === cardId));
  if (index === -1) return null;

  const removed = queue[index];
  await setQueue(client, draftId, seat, queue.filter((_, i) => i !== index));
  return removed;
}
```

- [ ] **Step 4: Update the `fulfillGroupEntry` unit tests**

In `src/core/db/queries/pickQueue.test.ts`, replace the entire `describe("fulfillGroupEntry", ...)` block (currently lines 429-450) with:

```ts
describe("fulfillGroupEntry", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  const QUEUE = JSON.stringify([
    { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
    { mode: "pause", cards: [{ id: 30, name: "Recall" }] },
  ]);

  it("removes the entry at the given index and returns it", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 10);

    expect(removed).toEqual({
      mode: "flow-through",
      cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }],
    });
    const call = client.execute.mock.calls[1][0]; // second call is the UPDATE
    expect(JSON.parse(call.args[0] as string)).toEqual([
      { mode: "pause", cards: [{ id: 30, name: "Recall" }] },
    ]);
  });

  it("finds the entry by card when the index has drifted", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    // Index 0 no longer holds Recall — a queue PUT reordered underneath us.
    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 30);

    expect(removed).toEqual({ mode: "pause", cards: [{ id: 30, name: "Recall" }] });
    const call = client.execute.mock.calls[1][0];
    expect(JSON.parse(call.args[0] as string)).toEqual([
      { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }, { id: 20, name: "Chain" }] },
    ]);
  });

  it("returns null and writes nothing when the card is already gone", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 999);

    expect(removed).toBeNull();
    expect(client.execute).toHaveBeenCalledTimes(1); // the SELECT only, no UPDATE
  });
});
```

- [ ] **Step 5: Add `entryIndex` to the candidate result types**

In `src/core/processPick.ts`, replace the two type declarations at lines 111-118 with:

```ts
type AutoPickAdvance =
  | { kind: 'candidate'; seat: number; cardId: number; cardName: string; entryIndex: number }
  | { kind: 'none' };

type SeatCandidateResult =
  | { kind: 'candidate'; cardId: number; cardName: string; entryIndex: number }
  | { kind: 'paused' }
  | { kind: 'none' };
```

- [ ] **Step 6: Strip the writes out of `selectAutoPickCandidateForSeat`**

In `src/core/processPick.ts`, replace the body of `selectAutoPickCandidateForSeat` from the `const autoPickResult = ...` line (currently line 160) through the closing `}` of the function (line 191) with:

```ts
  const autoPickResult = await getAutoPickCandidate(client, draftId, seat, availableSet);

  if (autoPickResult.kind !== 'candidate') {
    if (autoPickResult.kind === 'paused') {
      await updateAutoPick(client, draftId, seat, false);
      allSeatSettings.set(seat, { ...seatSettings, autoPick: false });
      return { kind: 'paused' };
    }
    return { kind: 'none' };
  }

  // Resolve the card name from the DB
  const cardRow = await client.execute({
    sql: `SELECT name FROM cards WHERE card_id = ?`,
    args: [autoPickResult.cardId],
  });
  if (cardRow.rows.length === 0) return { kind: 'none' };

  return {
    kind: 'candidate',
    cardId: autoPickResult.cardId,
    cardName: cardRow.rows[0].name as string,
    entryIndex: autoPickResult.entryIndex,
  };
}
```

Also update the function's doc comment: replace the sentence beginning "Runs the queue-traversal semantics (try entries in order..." with:

```
 * Runs the queue-traversal semantics (try entries in order, within each entry
 * try each card, pause-mode stops on exhaustion, flow-through continues).  When
 * the queue is exhausted in pause mode, auto-pick is disabled for the seat and
 * `{ kind: 'paused' }` is returned so the caller can surface the state change.
 *
 * Choosing is otherwise read-only: the chosen entry is reported by index and
 * removed only once its pick has actually landed (see `commitQueueEntryForPick`).
 * Removing it here instead meant a selection that never became a pick still
 * consumed the entry, silently deleting queued cards nobody picked.
```

The `addFloatedCard` import stays — the next step uses it.

- [ ] **Step 7: Pass `entryIndex` through `advanceAutoPick`**

In `src/core/processPick.ts`, replace the `if (result.kind === 'candidate')` block inside `advanceAutoPick` (currently lines 220-222) with:

```ts
  if (result.kind === 'candidate') {
    return {
      kind: 'candidate',
      seat: nextAfter.seat,
      cardId: result.cardId,
      cardName: result.cardName,
      entryIndex: result.entryIndex,
    };
  }
```

- [ ] **Step 8: Add `commitQueueEntryForPick`**

In `src/core/processPick.ts`, add this function immediately above `insertPickAndCascade` (i.e. after `triggerAutoPickOnDemand` ends at line 319):

```ts
/**
 * Commit the queue consequences of an auto-pick that has just landed: the entry
 * leaves the queue entirely (any one card fulfills a group) and the cards that
 * lost out are demoted to float.
 *
 * Runs after the INSERT, never before. The insert is the only step that can
 * fail on a race, so anything committed ahead of it is a change that outlives a
 * pick that never happened.
 */
async function commitQueueEntryForPick(
  client: Client,
  draftId: string,
  seat: number,
  entryIndex: number,
  pickedCardId: number,
): Promise<void> {
  const fulfilled = await fulfillGroupEntry(client, draftId, seat, entryIndex, pickedCardId);
  if (!fulfilled) return;

  const nonPicked = fulfilled.cards.filter((c) => c.id !== pickedCardId);
  await Promise.all(nonPicked.map((c) => addFloatedCard(client, draftId, seat, c.name)));
}
```

- [ ] **Step 9: Commit the queue change inside the cascade loop**

In `src/core/processPick.ts`, change `insertPickAndCascade`'s `firstPick` parameter type (line 337) from:

```ts
  firstPick: { seat: number; cardId: number; cardName: string },
```

to:

```ts
  firstPick: { seat: number; cardId: number; cardName: string; entryIndex: number | null },
```

Add a loop variable alongside the existing ones (after line 349, `let currentCardName = ...`):

```ts
  let currentEntryIndex = firstPick.entryIndex;
```

Then, immediately after the `picks.push(...)` line (currently line 363) and **before** the `getRemainingCopiesForPick` call, insert:

```ts
    // Before removeCardFromAllQueues / trimExcessQueueEntries, both of which
    // rewrite queue_json and would invalidate the entry index.
    if (currentEntryIndex !== null) {
      await commitQueueEntryForPick(
        client, draftId, currentSeat, currentEntryIndex, currentCardId,
      );
    }
```

Finally, in the block that advances the loop (currently lines 407-410), add the index:

```ts
    currentSeat = advance.seat;
    currentCardId = advance.cardId;
    currentCardName = advance.cardName;
    currentEntryIndex = advance.entryIndex;
    cascadeDepth++;
```

- [ ] **Step 10: Update the three call sites**

In `src/core/processPick.ts`:

`triggerAutoPickOnDemand` — change its `insertPickAndCascade` first-pick argument (currently line 304) from `{ seat, cardId, cardName },` to:

```ts
    { seat, cardId, cardName, entryIndex: candidateResult.entryIndex },
```

`resumeAutoPickForCurrentSeat` — change its argument (currently line 461) to:

```ts
    {
      seat: next.seat,
      cardId: candidateResult.cardId,
      cardName: candidateResult.cardName,
      entryIndex: candidateResult.entryIndex,
    },
```

`processPick` — a manual pick has no queue entry backing it, so pass null (currently line 515):

```ts
    { seat: input.seat, cardId: input.cardId, cardName: input.cardName, entryIndex: null },
```

- [ ] **Step 11: Run the regression test**

Run: `npx vitest run src/core/processPick.queueCommit.test.ts`

Expected: all 4 tests PASS.

- [ ] **Step 12: Repair the engine tests that encoded the old ordering**

Run: `npx vitest run src/core/processPick.test.ts`

`src/core/processPick.test.ts` drives a mocked client and asserts an exact sequence of `execute` calls, so moving `fulfillGroupEntry` moves where it appears in that sequence. Two changes are needed.

First, the module mock at line 11 must return the new type. Change:

```ts
  fulfillGroupEntry: vi.fn().mockResolvedValue({ mode: 'pause', cards: [] }),
```

to:

```ts
  fulfillGroupEntry: vi.fn().mockResolvedValue(null),
```

and update every `mockResolvedValue` / `mockResolvedValueOnce` override of it to keep returning its entry object — those are still valid, since a landed pick still gets a `QueueEntry` back.

Second, the test at line 546, `'calls fulfillGroupEntry after a successful auto-pick cascade step'`, asserts the *old* contract: it breaks the cascade by returning no card-name row, then expects `fulfillGroupEntry` to have been called anyway. Under the new ordering that call cannot happen, because no second pick was inserted. Replace that whole `it(...)` block with one that asserts the new contract:

```ts
    it('does not touch the queue when a cascade candidate never becomes a pick', async () => {
      const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 10, entryIndex: 0,
      });

      // 1. Draft metadata -- 2 seats, 3 picks each (6 total)
      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
      // 2. Latest pick number -- 0 (seat 1's turn)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ latest: 0 }]));
      // 3. Availability check -- qty=1, picked_count=0
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
      // 4. INSERT pick_events for seat 1 -- success
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // 5. Post-insert copy-check re-query (picked_count 1, qty 1 -> isLastCopy)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));
      // 6. Available cards query for seat 2
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 10 }]));
      // 7. Card name lookup returns nothing -> candidate is abandoned
      mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

      const result = await processPick(mockClient as never, baseInput);

      expect(result.picks).toHaveLength(1);
      expect(fulfillGroupEntry).not.toHaveBeenCalled();
    });
```

For every other failure in this file, the cause is the same and the fix is mechanical: `fulfillGroupEntry` and `addFloatedCard` no longer run between the availability query and the card-name lookup, they run after the *following* `insertPickEvent`. Move the affected `mockClient.execute.mockResolvedValueOnce(...)` entries to match, and where an assertion checks a `fulfillGroupEntry` argument list, add the picked card id as the fifth argument — e.g. `toHaveBeenCalledWith(mockClient, 'draft-1', 2, 0)` becomes `toHaveBeenCalledWith(mockClient, 'draft-1', 2, 0, 10)`. Do not weaken any assertion about which cards get floated; that behavior is unchanged.

- [ ] **Step 13: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`

Expected: all pass, zero lint warnings, no knip findings.

- [ ] **Step 14: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/pickQueue.ts src/core/db/queries/pickQueue.test.ts src/core/processPick.ts src/core/processPick.test.ts src/core/processPick.queueCommit.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Remove a queue entry only once its pick has landed

Candidate selection deleted the entry and floated the group's other cards
while choosing, but the INSERT happens later and is the only step that can
lose a race. Every trigger that lost one -- and every cascade truncated at its
depth cap -- silently ate a queued card nobody picked, with the client
swallowing the 409 that followed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Select the live drafts that need a heartbeat

**Files:**
- Modify: `src/core/db/sync/lock.ts` (add after `getActiveDrafts`, which ends at line 129)
- Create: `src/core/db/sync/lock.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  export async function getLiveDraftingDrafts(client: Client): Promise<string[]>
  ```
  Returns the `draft_id` of every in-app draft currently in the `drafting` phase, ascending. Task 3 consumes this.

- [ ] **Step 1: Write the failing test**

Create `src/core/db/sync/lock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { getLiveDraftingDrafts } from './lock';
import { createMemDb, insertDraft } from '../__tests__/testDb';

async function addDraft(
  client: Client,
  draftId: string,
  opts: { phase: string; inApp: boolean; sheetId?: string },
): Promise<void> {
  await insertDraft(client, draftId, { phase: opts.phase });
  await client.execute({
    sql: `UPDATE drafts SET in_app = ?, sheet_id = ? WHERE draft_id = ?`,
    args: [opts.inApp ? 1 : 0, opts.sheetId ?? null, draftId],
  });
}

describe('getLiveDraftingDrafts', () => {
  it('returns in-app drafts that are currently drafting', async () => {
    const client = await createMemDb();
    await addDraft(client, 'live-drafting', { phase: 'drafting', inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual(['live-drafting']);
  });

  it('ignores in-app drafts in any other phase', async () => {
    const client = await createMemDb();
    await addDraft(client, 'live-setup', { phase: 'setup', inApp: true });
    await addDraft(client, 'live-playing', { phase: 'playing', inApp: true });
    await addDraft(client, 'live-complete', { phase: 'complete', inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual([]);
  });

  it('ignores drafts that are not in-app', async () => {
    const client = await createMemDb();
    await addDraft(client, 'sheet-drafting', { phase: 'drafting', inApp: false, sheetId: 'abc' });

    expect(await getLiveDraftingDrafts(client)).toEqual([]);
  });

  it('returns every eligible draft, in id order', async () => {
    const client = await createMemDb();
    await addDraft(client, 'b-draft', { phase: 'drafting', inApp: true });
    await addDraft(client, 'a-draft', { phase: 'drafting', inApp: true });

    expect(await getLiveDraftingDrafts(client)).toEqual(['a-draft', 'b-draft']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/core/db/sync/lock.test.ts`

Expected: FAIL — `getLiveDraftingDrafts` is not exported from `./lock`.

- [ ] **Step 3: Add the query**

In `src/core/db/sync/lock.ts`, add immediately after `getActiveDrafts` (which ends at line 129):

```ts
/**
 * In-app drafts currently in the drafting phase.
 *
 * Deliberately separate from getActiveDrafts, which filters on
 * `sheet_id IS NOT NULL` because its callers ingest from Google Sheets. Live
 * drafts have no sheet and need the opposite treatment: nothing to ingest, but
 * a turn that can stall on an absent player until something nudges it.
 */
export async function getLiveDraftingDrafts(client: Client): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT draft_id FROM drafts WHERE phase = 'drafting' AND in_app = 1 ORDER BY draft_id`,
    args: [],
  });
  return result.rows.map((row) => row.draft_id as string);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/core/db/sync/lock.test.ts`

Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/sync/lock.ts src/core/db/sync/lock.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Add a selector for in-app drafts that are mid-draft

getActiveDrafts filters on sheet_id because its callers ingest from Sheets,
which makes live drafts invisible to everything driven by it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Run the auto-pick heartbeat from the cron

**Files:**
- Modify: `src/app/api/sync/route.ts:14-78`
- Modify: `src/app/api/sync/route.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `getLiveDraftingDrafts` from Task 2; `resumeAutoPickForCurrentSeat` from `src/core/processPick.ts` (already exported, signature `(client: Client, draftId: string) => Promise<CascadeOutcome>`).
- Produces: every `/api/sync` response body gains an `autoPicked: number` field — the count of picks the heartbeat made across all live drafts.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/sync/route.test.ts`, add `getLiveDraftingDrafts` to the existing `vi.mock("@/core/db/sync/lock", ...)` factory (currently lines 11-17):

```ts
vi.mock("@/core/db/sync/lock", () => ({
  acquireSyncLock: vi.fn().mockResolvedValue(true),
  releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  updateLastSyncedAt: vi.fn().mockResolvedValue("1234567890"),
  getActiveDrafts: vi.fn().mockResolvedValue([]),
  getLiveDraftingDrafts: vi.fn().mockResolvedValue([]),
  completeAgedPlayingDrafts: vi.fn().mockResolvedValue(0),
}));
```

Add a mock for the engine directly below the `syncActiveDraft` mock (after line 28):

```ts
vi.mock("@/core/processPick", () => ({
  resumeAutoPickForCurrentSeat: vi.fn().mockResolvedValue({
    picks: [], phaseChanged: false, newPhase: null,
  }),
}));
```

Extend the imports below them (currently lines 31-33):

```ts
import { GET } from "./route";
import { getActiveDrafts, getLiveDraftingDrafts } from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";
import { resumeAutoPickForCurrentSeat } from "@/core/processPick";
```

Then append this describe block to the end of the file:

```ts
// vi.clearAllMocks() clears recorded calls but leaves implementations and any
// queued mockResolvedValueOnce values in place, so each of these resets the
// mocks it drives rather than inheriting whatever the previous test left.
describe("GET /api/sync — live-draft auto-pick heartbeat", () => {
  beforeEach(() => {
    vi.mocked(getActiveDrafts).mockReset().mockResolvedValue([]);
    vi.mocked(getLiveDraftingDrafts).mockReset().mockResolvedValue([]);
    vi.mocked(resumeAutoPickForCurrentSeat).mockReset().mockResolvedValue({
      picks: [], phaseChanged: false, newPhase: null,
    });
  });

  it("nudges live drafts even when no Sheets draft is active", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["kishla-skimmer"]);
    vi.mocked(resumeAutoPickForCurrentSeat).mockResolvedValue({
      picks: [{ pickN: 384, seat: 4, cardId: 1, cardName: "Bolt" }],
      phaseChanged: false,
      newPhase: null,
    });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledWith(mockClient, "kishla-skimmer");
    expect(body.status).toBe("no_active_drafts");
    expect(body.autoPicked).toBe(1);
  });

  it("nudges every live draft and totals the picks", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["draft-a", "draft-b"]);
    vi.mocked(resumeAutoPickForCurrentSeat)
      .mockResolvedValueOnce({
        picks: [{ pickN: 1, seat: 1, cardId: 1, cardName: "A" }],
        phaseChanged: false, newPhase: null,
      })
      .mockResolvedValueOnce({
        picks: [
          { pickN: 2, seat: 2, cardId: 2, cardName: "B" },
          { pickN: 3, seat: 3, cardId: 3, cardName: "C" },
        ],
        phaseChanged: false, newPhase: null,
      });

    const body = await (await GET(cronRequest())).json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledTimes(2);
    expect(body.autoPicked).toBe(3);
  });

  it("keeps going when one draft's nudge throws", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["bad-draft", "good-draft"]);
    vi.mocked(resumeAutoPickForCurrentSeat)
      .mockRejectedValueOnce(new Error("Conflict: pick_n already exists — retry"))
      .mockResolvedValueOnce({
        picks: [{ pickN: 9, seat: 1, cardId: 1, cardName: "A" }],
        phaseChanged: false, newPhase: null,
      });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.autoPicked).toBe(1);
  });

  it("runs the heartbeat even without a Sheets API key", async () => {
    delete process.env.GOOGLE_SHEETS_API_KEY;
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["kishla-skimmer"]);

    await GET(cronRequest());

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledWith(mockClient, "kishla-skimmer");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/app/api/sync/route.test.ts`

Expected: the four new tests FAIL — `resumeAutoPickForCurrentSeat` is never called and `body.autoPicked` is `undefined`.

- [ ] **Step 3: Add the heartbeat helper**

In `src/app/api/sync/route.ts`, extend the imports from the lock module (currently lines 4-11) to include the new selector, and add an import for the engine:

```ts
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getActiveDrafts,
  getLiveDraftingDrafts,
  completeAgedPlayingDrafts,
} from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";
import { resumeAutoPickForCurrentSeat } from "@/core/processPick";
import { ConflictError } from "@/core/errors";
```

Then add this function immediately above `runSync` (before line 14):

```ts
/**
 * Pick for the seat on the clock in every in-app draft that has one, and cascade
 * from there.
 *
 * The cascade only ever runs as a side effect of a pick landing, and the client
 * trigger only runs in an open browser — so a live draft whose players are all
 * away sits dead, and strict rotisserie order means no other seat can pick to
 * restart it. This is the only thing that recovers it unattended.
 *
 * One draft failing must not cost the others their nudge or fail the cron run:
 * a client racing this call produces a ConflictError, which is a normal outcome
 * here, not an error worth a non-200.
 *
 * Returns the total number of picks made, for the response body. This count is
 * a lower bound, not a guarantee: if a draft lands some picks and then loses a
 * race partway through its cascade, the ConflictError is caught below and that
 * draft's picks so far are never added to the total, even though they are
 * already committed. `autoPicked: 0` in the response does not prove this
 * function did nothing.
 */
async function runAutoPickHeartbeat(client: Client): Promise<number> {
  const draftIds = await getLiveDraftingDrafts(client);
  let picksMade = 0;

  for (const draftId of draftIds) {
    try {
      const outcome = await resumeAutoPickForCurrentSeat(client, draftId);
      picksMade += outcome.picks.length;
    } catch (error) {
      if (error instanceof ConflictError) {
        // A client racing this same seat's turn is routine once players are
        // active, not a failure — console.error here would produce
        // false-positive alerts on every such race.
        console.warn(`[sync] auto-pick heartbeat raced a client for ${draftId}:`, error.message);
      } else {
        console.error(`[sync] auto-pick heartbeat failed for ${draftId}:`, error);
      }
    }
  }

  return picksMade;
}
```

This needs the `Client` type. Add to the imports at the top of the file:

```ts
import type { Client } from "@libsql/client";
```

- [ ] **Step 4: Call the heartbeat before the Sheets early return**

In `src/app/api/sync/route.ts`, replace the opening of `runSync` — from `const client = await getClient();` through the `no_active_drafts` return (currently lines 15-25) — with:

```ts
  const client = await getClient();

  // Age backstop first so long-stale playing drafts drop out of this run
  await completeAgedPlayingDrafts(client);

  // Before anything Sheets-related. Every early return below is about Sheets
  // ingest — no active sheet draft, no API key, a lock already held — and none
  // of them have any bearing on a live draft stalled on an absent player.
  const autoPicked = await runAutoPickHeartbeat(client);

  // Check for active drafts (cheap query)
  const activeDrafts = await getActiveDrafts(client);
  if (activeDrafts.length === 0) {
    return NextResponse.json({ status: "no_active_drafts", autoPicked });
  }

  // Try to acquire lock
  const locked = await acquireSyncLock(client);
  if (!locked) {
    return NextResponse.json({ status: "in_progress", autoPicked });
  }
```

The heartbeat runs outside the sync lock on purpose: the lock guards Sheets ingest against double-writing, while the heartbeat is idempotent and — after Task 1 — costs nothing when it loses a race.

- [ ] **Step 5: Report the count on the remaining responses**

In `src/app/api/sync/route.ts`, add `autoPicked` to the three response bodies inside the `try` block. The missing-key response (currently lines 36-39):

```ts
      return NextResponse.json(
        { error: "Server misconfiguration", autoPicked },
        { status: 500 },
      );
```

The `completed` response (currently lines 60-66):

```ts
      return NextResponse.json({
        status: "completed",
        lastSyncedAt,
        picksInserted: totalPicksInserted,
        picksUpdated: totalPicksUpdated,
        matchesReplaced: totalMatchesReplaced,
        autoPicked,
      });
```

The `no_change` response (currently lines 69-74):

```ts
    return NextResponse.json({
      status: "no_change",
      picksInserted: 0,
      picksUpdated: 0,
      matchesReplaced: 0,
      autoPicked,
    });
```

- [ ] **Step 6: Run the route tests**

Run: `npx vitest run src/app/api/sync/route.test.ts`

Expected: all tests PASS, including the pre-existing ones — they assert on `body.status`, which is unchanged.

- [ ] **Step 7: Document the heartbeat**

In `/Users/arpanet/code/read-the-bones/CLAUDE.md`, find the `/api/sync` bullet under **Internal routes** and append this sentence to the end of it, after the sync-lock sentence:

```
Each run also nudges auto-pick for every in-app draft in the `drafting` phase (`resumeAutoPickForCurrentSeat`), so a live draft stalled on an absent player recovers within a minute without anyone opening a browser; the response reports how many picks that made as `autoPicked`. The nudge runs before every Sheets-related early return and outside the sync lock, so it still fires when no Sheets draft is active. One minute is the floor — Vercel cron expressions have no seconds field — so the client-side trigger stays as the fast path.
```

- [ ] **Step 8: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`

Expected: all pass, zero lint warnings, no knip findings.

- [ ] **Step 9: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/api/sync/route.ts src/app/api/sync/route.test.ts CLAUDE.md
git -C /Users/arpanet/code/read-the-bones commit -m "Nudge stalled live drafts from the cron, not just open browsers

The once-a-minute cron returned early unless a Google Sheets draft was
active, so in-app drafts got no server-side heartbeat at all and a turn on an
absent player sat until someone opened a tab.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deployment

The live `kishla-skimmer` draft is mid-flight, so deploy deliberately rather than as a side effect. There is no schema change, so no migration step and no ordering constraint between migration and deploy.

- [ ] **Step 1: Run the full gate**

Run: `pnpm precommit`

- [ ] **Step 2: Record the pre-deploy queue state**

So the heartbeat's first run can be told apart from normal play:

```bash
turso db shell read-the-bones "SELECT seat, auto_pick, LENGTH(queue_json) AS qlen FROM seat_tokens WHERE draft_id='kishla-skimmer' ORDER BY seat;"
turso db shell read-the-bones "SELECT MAX(pick_n) FROM pick_events WHERE draft_id='kishla-skimmer';"
```

- [ ] **Step 3: Push**

```bash
git -C /Users/arpanet/code/read-the-bones push origin master
```

Pushing `master` deploys to production automatically.

- [ ] **Step 4: Verify the heartbeat runs**

After the deploy reports Ready, trigger the cron path by hand rather than waiting a minute:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://read-the-bones.vercel.app/api/sync
```

Expected: a JSON body containing an `autoPicked` field. It is `0` when no live draft has a seat that can be picked for, which is the normal steady state.

- [ ] **Step 5: Verify picks still record provenance and nothing vanished**

```bash
turso db shell read-the-bones "SELECT pick_n, seat, source, created_at FROM pick_events WHERE draft_id='kishla-skimmer' ORDER BY pick_n DESC LIMIT 10;"
turso db shell read-the-bones "SELECT seat, auto_pick, LENGTH(queue_json) AS qlen FROM seat_tokens WHERE draft_id='kishla-skimmer' ORDER BY seat;"
```

Expected: any picks made after the deploy carry a `source` of `resume` (heartbeat), `ondemand`, `manual`, or `cascade`. Queue lengths should only shrink by cards that appear in `pick_events` or that another seat took — that is the invariant Task 1 restores, and this is the production check on it.

- [ ] **Step 6: Ask seat 7 to confirm**

Get the list of cards seat 7 had queued before the incident, and check each one:

```bash
turso db shell read-the-bones "SELECT c.name, (SELECT COUNT(*) FROM pick_events pe WHERE pe.draft_id='kishla-skimmer' AND pe.card_id=c.card_id) AS picked FROM cards c WHERE c.name IN ('<names>');"
```

A card with `picked = 0` that is no longer in their queue is one this bug ate — that closes the diagnosis. A card with `picked > 0` was taken by another seat, which is the separate per-card pause problem noted in Background and is not addressed here.
