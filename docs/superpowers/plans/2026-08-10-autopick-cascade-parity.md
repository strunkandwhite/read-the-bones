# Auto-Pick Cascade Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an auto-pick continue the draft chain the same way a manual pick does, and make a draft resuming into `drafting` phase pick for the seat already on the clock.

**Architecture:** `processPick` currently owns a cascade loop that walks forward through subsequent seats auto-picking for each. `triggerAutoPickOnDemand` (the `{auto: true}` endpoint path) has no such loop — it inserts one pick and returns, so any auto-pick made by a player's client kills the chain. We extract the loop into one shared `insertPickAndCascade` function and call it from both entry points, exactly as both already share `selectAutoPickCandidateForSeat`. We then add `resumeAutoPickForCurrentSeat`, which derives the seat on the clock and runs the same cascade, and call it from the two places that move a draft into `drafting`. Finally we add `created_at` and `source` to `pick_events` so the three entry points are distinguishable in production.

**Tech Stack:** TypeScript, Next.js App Router, libSQL/Turso, Vitest, pnpm.

## Background

Diagnosed 2026-08-10 on the live Kishla Skimmer draft. A seat with auto-pick on, a stocked queue, and an available queued card sat on the clock for hours. Root cause: `triggerAutoPickOnDemand` does not cascade. Verified by experiment — from an identical 3-seat draft with all seats auto-picking, a manual pick produced **6 picks** and an on-demand auto-pick produced **1**.

The cascade was always the intent. `docs/superpowers/specs/2026-03-23-live-draft-design.md:211` specifies "derive the next seat… continue until a seat has no valid auto-pick", and step 6 specifies returning "all new picks created (including cascaded auto-picks)". The root `CLAUDE.md` REST table describes `{ auto: true }` as "trigger server-side auto-pick cascade". The gap was introduced in `2daee61` (2026-06-11), which moved queue traversal server-side; before it, the client auto-picked by calling `handlePick(cardName)`, which posts a normal `{card_name}` pick and therefore rode `processPick`'s cascade. The change's task list (`docs/superpowers/plans/2026-06-11-deep-clean-fixes.md:274`) specified only candidate-selection parity tests, so nothing caught the missing continuation.

**Decision recorded, not implemented:** `pause` remains the correct default mode for new queue entries (`src/app/stores/live/queueFloat.ts:204`). It was considered and deliberately kept. Do not change it in this plan.

## Global Constraints

- A live draft (`kishla-skimmer`) is mid-flight. Every change must be backward compatible with in-progress drafts; no destructive migrations, no data rewrites.
- Never change the `pause` default in `src/app/stores/live/queueFloat.ts:204`.
- SQLite forbids non-constant defaults in `ALTER TABLE ADD COLUMN`. New timestamp columns must be nullable with the value supplied by the INSERT, never `DEFAULT (datetime('now'))` on an ALTER.
- Historical picks predate the new columns and must stay `NULL` — do not backfill invented timestamps.
- All git commands use `git -C /Users/arpanet/code/read-the-bones ...`. Never combine `cd` and `git`.
- Existing public behavior of `POST /api/drafts/[id]/pick` with `{card_name}` must not change.
- The `AutoPickOnDemandResult.pickedCard` field must keep working — the client reads it (`src/app/stores/live/picking.ts:47`).
- Quality gates: `pnpm typecheck`, `pnpm lint` (zero warnings), `pnpm test`. Run `pnpm precommit` before any push (a husky pre-push hook enforces it).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/core/processPick.ts` | Pick engine: validation, insert, cascade, auto-pick entry points | Modify — extract `insertPickAndCascade`, add `resumeAutoPickForCurrentSeat` |
| `src/core/processPick.cascadeParity.test.ts` | Regression guard: both entry points cascade identically | Create |
| `src/core/processPick.resume.test.ts` | Regression guard: phase resume picks for the seat on the clock | Create |
| `src/core/db/schema.sql` | Canonical schema | Modify — add two `ALTER TABLE pick_events` statements |
| `src/core/pickSource.ts` | The `PickSource` union, shared by engine and tests | Create |
| `scripts/draft-start.ts` | `setup` → `drafting` CLI | Modify — call resume after transition |
| `scripts/draft-admin.ts` | Admin CLI incl. `set-phase` | Modify — call resume when target phase is `drafting` |
| `CLAUDE.md` | Project docs | Modify — correct the `{auto:true}` route description |

---

### Task 1: Extract the shared cascade and make the on-demand path use it

**Files:**
- Modify: `src/core/processPick.ts`
- Create: `src/core/processPick.cascadeParity.test.ts`

**Interfaces:**
- Consumes: existing `getRemainingCopiesForPick`, `insertPickEvent`, `advanceAutoPick`, `selectAutoPickCandidateForSeat`, `getAllSeatSettings`, `getDraftMeta`, `getNextPick`, `getTotalPicks` — all already in `src/core/processPick.ts`.
- Produces:
  ```ts
  interface CascadeOutcome {
    picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
    phaseChanged: boolean;
    newPhase: string | null;
  }

  async function insertPickAndCascade(
    client: Client,
    draftId: string,
    firstPick: { seat: number; cardId: number; cardName: string },
    currentCount: number,
    meta: { numSeats: number; picksPerPlayer: number; doublePickAfterRound: number | null },
    allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
  ): Promise<CascadeOutcome>
  ```
  `AutoPickOnDemandResult` gains a `picks` field alongside the existing `pickedCard`.

- [ ] **Step 1: Write the failing parity test**

Create `src/core/processPick.cascadeParity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { processPick, triggerAutoPickOnDemand } from './processPick';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

const CARDS: Array<[number, string]> = [
  [1, 'Manual Card'],
  [11, 'S1 First'], [12, 'S1 Second'],
  [21, 'S2 First'], [22, 'S2 Second'],
  [31, 'S3 First'], [32, 'S3 Second'],
];

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

/** 3 seats, 3 picks each, all single-pick rounds. Every seat auto-picks with a queue. */
async function seed(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (const [id, name] of CARDS) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: queueOf([[11, 'S1 First'], [12, 'S1 Second']]) });
  await insertSeatToken(client, DRAFT, 2, { autoPick: true, queueJson: queueOf([[21, 'S2 First'], [22, 'S2 Second']]) });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First'], [32, 'S3 Second']]) });
  return client;
}

async function pickCount(client: Client): Promise<number> {
  const r = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM pick_events WHERE draft_id = ?`,
    args: [DRAFT],
  });
  return r.rows[0].c as number;
}

describe('cascade parity between manual and on-demand auto-pick', () => {
  it('a manual pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await processPick(client, {
      draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card',
    });
    expect(result.picks.length).toBeGreaterThan(1);
    expect(await pickCount(client)).toBe(result.picks.length);
  });

  it('an on-demand auto-pick cascades into the following auto-pick seats', async () => {
    const client = await seed();
    const result = await triggerAutoPickOnDemand(client, DRAFT, 1);
    expect(result.pickedCard).not.toBeNull();
    expect(result.picks.length).toBeGreaterThan(1);
    expect(await pickCount(client)).toBe(result.picks.length);
  });

  it('both entry points advance the draft by the same number of picks', async () => {
    const manualClient = await seed();
    await processPick(manualClient, { draftId: DRAFT, seat: 1, cardId: 11, cardName: 'S1 First' });

    const autoClient = await seed();
    await triggerAutoPickOnDemand(autoClient, DRAFT, 1);

    expect(await pickCount(autoClient)).toBe(await pickCount(manualClient));
  });

  it('the on-demand result reports the seat that triggered it as its first pick', async () => {
    const client = await seed();
    const result = await triggerAutoPickOnDemand(client, DRAFT, 1);
    expect(result.picks[0].seat).toBe(1);
    expect(result.picks[0].pickN).toBe(1);
    expect(result.pickedCard?.cardName).toBe(result.picks[0].cardName);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.cascadeParity.test.ts`

Expected: the manual test passes; the three on-demand tests FAIL. The second fails on `expected 1 to be greater than 1`, and the fourth fails with a TypeScript/runtime error because `result.picks` does not exist yet.

- [ ] **Step 3: Add the `CascadeOutcome` type and extract `insertPickAndCascade`**

In `src/core/processPick.ts`, add after the `AutoPickOnDemandResult` interface:

```ts
/** The picks produced by one insert-plus-cascade run, and any phase change it caused. */
export interface CascadeOutcome {
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  phaseChanged: boolean;
  newPhase: string | null;
}
```

Then add this function immediately above `processPick` (after `triggerAutoPickOnDemand`'s helpers):

```ts
/**
 * Insert a pick and then cascade forward: after each pick lands, ask whether the
 * next seat on the clock has auto-pick enabled with an available queued card, and
 * if so pick for them too. Continues until a seat has no valid auto-pick.
 *
 * This is the single implementation of chain continuation. Both entry points use
 * it — a manual pick and an on-demand auto-pick differ only in how the FIRST card
 * is chosen, never in what happens afterward.
 *
 * The caller is responsible for all validation (phase, turn, availability, bans)
 * before calling. Copy counts are re-queried after every insert, including the
 * first, so the caller does not need to pass its own availability check in.
 */
async function insertPickAndCascade(
  client: Client,
  draftId: string,
  firstPick: { seat: number; cardId: number; cardName: string },
  currentCount: number,
  meta: { numSeats: number; picksPerPlayer: number; doublePickAfterRound: number | null },
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
): Promise<CascadeOutcome> {
  const { numSeats, picksPerPlayer, doublePickAfterRound } = meta;
  const picks: CascadeOutcome['picks'] = [];
  const maxCascade = numSeats * 2;

  let currentSeat = firstPick.seat;
  let currentCardId = firstPick.cardId;
  let currentCardName = firstPick.cardName;
  let cascadeDepth = 0;

  while (cascadeDepth < maxCascade) {
    const pickN = currentCount + picks.length + 1;

    const rowsAffected = await insertPickEvent(
      client, draftId, pickN, currentSeat, currentCardId,
    );
    if (rowsAffected === 0) {
      throw new ConflictError('Conflict: pick_n already exists — retry');
    }

    picks.push({ pickN, seat: currentSeat, cardId: currentCardId, cardName: currentCardName });

    // Re-query after the insert, so pickedCount already includes the pick just made.
    const copyInfo = await getRemainingCopiesForPick(
      client, draftId, currentCardId, currentCardName,
    );
    const isLastCopy = copyInfo.pickedCount >= copyInfo.qty;
    const remainingAfterPick = copyInfo.qty - copyInfo.pickedCount;

    if (isLastCopy) {
      const { pauseSeats } = await removeCardFromAllQueues(client, draftId, currentCardId);
      await Promise.all(
        pauseSeats
          .filter((s) => s !== currentSeat)
          .map(async (s) => {
            await updateAutoPick(client, draftId, s, false);
            const prev = allSeatSettings.get(s);
            if (prev) allSeatSettings.set(s, { ...prev, autoPick: false });
          })
      );
      await removeFloatedCardByCardId(client, draftId, currentCardId);
    } else {
      await trimExcessQueueEntries(client, draftId, currentCardId, remainingAfterPick);
    }

    const totalAfter = currentCount + picks.length;
    const totalExpected = getTotalPicks(numSeats, picksPerPlayer);
    if (totalAfter >= totalExpected) {
      await client.execute({
        sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
        args: [draftId],
      });
      await client.execute({
        sql: `UPDATE seat_tokens SET queue_json = '[]' WHERE draft_id = ?`,
        args: [draftId],
      });
      return { picks, phaseChanged: true, newPhase: 'playing' };
    }

    const advance = await advanceAutoPick(
      client, draftId, totalAfter, numSeats, picksPerPlayer, doublePickAfterRound, allSeatSettings,
    );
    if (advance.kind !== 'candidate') break;

    currentSeat = advance.seat;
    currentCardId = advance.cardId;
    currentCardName = advance.cardName;
    cascadeDepth++;
  }

  return { picks, phaseChanged: false, newPhase: null };
}
```

- [ ] **Step 4: Rewrite `processPick`'s tail to call the shared function**

In `src/core/processPick.ts`, replace everything in `processPick` from the comment `// 4. Insert with optimistic concurrency + cascade` through the closing `return { picks, phaseChanged: false, newPhase: null };` (the whole `while` loop and its surrounding declarations) with:

```ts
  // 4. Insert with optimistic concurrency + cascade
  const allSeatSettings = await getAllSeatSettings(client, input.draftId);

  return insertPickAndCascade(
    client,
    input.draftId,
    { seat: input.seat, cardId: input.cardId, cardName: input.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );
```

Leave every validation step above it untouched, including the `availCheck` call that throws when the card is already picked or off-cube. Its post-insert reuse is intentionally dropped; the shared loop re-queries instead.

- [ ] **Step 5: Add `picks` to `AutoPickOnDemandResult` and route the on-demand path through the cascade**

In `src/core/processPick.ts`, add the field to the interface:

```ts
export interface AutoPickOnDemandResult {
  /** The card that was picked, or null when the queue yielded nothing. */
  pickedCard: { pickN: number; cardId: number; cardName: string } | null;
  /** Every pick this call produced, including cascaded picks for later seats. */
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  /**
   * True when pause-mode exhaustion caused the seat's auto-pick to be
   * disabled server-side. The client should reflect this state change.
   */
  autoPickDisabled: boolean;
  phaseChanged: boolean;
  newPhase: string | null;
}
```

In `triggerAutoPickOnDemand`, update the three early returns to include `picks: []`:

```ts
  if (!seatSettings.autoPick) {
    return { pickedCard: null, picks: [], autoPickDisabled: true, phaseChanged: false, newPhase: null };
  }

  const candidateResult = await selectAutoPickCandidateForSeat(
    client, draftId, seat, seatSettings, allSeatSettings,
  );

  if (candidateResult.kind === 'paused') {
    return { pickedCard: null, picks: [], autoPickDisabled: true, phaseChanged: false, newPhase: null };
  }
  if (candidateResult.kind === 'none') {
    return { pickedCard: null, picks: [], autoPickDisabled: false, phaseChanged: false, newPhase: null };
  }
```

Then replace everything from `const { cardId, cardName } = candidateResult;` to the end of the function with:

```ts
  const { cardId, cardName } = candidateResult;

  const outcome = await insertPickAndCascade(
    client,
    draftId,
    { seat, cardId, cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );

  const first = outcome.picks[0];
  return {
    pickedCard: first ? { pickN: first.pickN, cardId: first.cardId, cardName: first.cardName } : null,
    picks: outcome.picks,
    autoPickDisabled: false,
    phaseChanged: outcome.phaseChanged,
    newPhase: outcome.newPhase,
  };
```

- [ ] **Step 6: Run the parity test**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.cascadeParity.test.ts`

Expected: all 4 tests PASS.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm typecheck && pnpm test`

Expected: all pass. Existing `triggerAutoPickOnDemand` tests in `src/core/processPick.test.ts` assert single-pick behavior against a **mocked** client whose queues are empty for later seats, so they should still pass. If any now fails because a mock advanced further than expected, update that test's expectation to the cascaded result and note it in the commit message — do not re-add the single-pick behavior.

- [ ] **Step 8: Correct the route description in CLAUDE.md**

In `/Users/arpanet/code/read-the-bones/CLAUDE.md`, find the live-draft routes table row for `/api/drafts/[id]/pick` and replace its Description cell text with:

```
Submit a pick. Body: `{ card_name: string }` or `{ auto: true }` to auto-pick from the seat's queue. Both forms cascade: after each pick lands, following seats with auto-pick and an available queued card are picked for automatically. Returns `picks[]` with every pick made. `{ auto: true }` returns `autoPickDisabled: true` without picking when the seat has auto-pick off.
```

- [ ] **Step 9: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/processPick.ts src/core/processPick.cascadeParity.test.ts CLAUDE.md
git -C /Users/arpanet/code/read-the-bones commit -m "Cascade after on-demand auto-picks, not just manual ones

An auto-pick made through the {auto:true} endpoint inserted one pick and
returned, so any seat whose client auto-picked silently ended the chain and
stranded the next seat until someone opened a browser. Both entry points now
share one insert-and-cascade implementation.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Pick for the seat on the clock when a draft enters `drafting`

**Files:**
- Modify: `src/core/processPick.ts`
- Modify: `scripts/draft-start.ts`
- Modify: `scripts/draft-admin.ts:118-131`
- Create: `src/core/processPick.resume.test.ts`

**Interfaces:**
- Consumes: `insertPickAndCascade` and `CascadeOutcome` from Task 1; `selectAutoPickCandidateForSeat`, `getAllSeatSettings`, `getDraftMeta`, `getNextPick`.
- Produces:
  ```ts
  export async function resumeAutoPickForCurrentSeat(
    client: Client,
    draftId: string,
  ): Promise<CascadeOutcome>
  ```
  Returns `{ picks: [], phaseChanged: false, newPhase: null }` when the draft is not in `drafting`, all picks are made, the seat on the clock has auto-pick off, or its queue yields no available card.

- [ ] **Step 1: Write the failing resume test**

Create `src/core/processPick.resume.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { resumeAutoPickForCurrentSeat } from './processPick';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft,
  insertSeatToken, insertPickEvent,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

/**
 * 3 seats, 3 picks each. Seat 1 has already picked, so seat 2 is on the clock.
 * Seats 2 and 3 both auto-pick with stocked queues.
 */
async function seed(opts: { phase?: string; seat2AutoPick?: boolean; seat2Queue?: string } = {}): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  for (const [id, name] of [[1, 'Taken'], [21, 'S2 First'], [31, 'S3 First']] as Array<[number, string]>) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: opts.phase ?? 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertPickEvent(client, DRAFT, 1, 1, 1);

  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: '[]' });
  await insertSeatToken(client, DRAFT, 2, {
    autoPick: opts.seat2AutoPick ?? true,
    queueJson: opts.seat2Queue ?? queueOf([[21, 'S2 First']]),
  });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First']]) });
  return client;
}

describe('resumeAutoPickForCurrentSeat', () => {
  it('picks for the seat on the clock and cascades onward', async () => {
    const client = await seed();
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);

    expect(result.picks[0].seat).toBe(2);
    expect(result.picks[0].pickN).toBe(2);
    expect(result.picks[0].cardName).toBe('S2 First');
    expect(result.picks.length).toBeGreaterThan(1);
  });

  it('does nothing when the draft is not in drafting phase', async () => {
    const client = await seed({ phase: 'setup' });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('does nothing when the seat on the clock has auto-pick off', async () => {
    const client = await seed({ seat2AutoPick: false });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('does nothing when the seat on the clock has an empty queue', async () => {
    const client = await seed({ seat2Queue: '[]' });
    const result = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(result.picks).toEqual([]);
  });

  it('is safe to call twice — the second call finds nothing left to do', async () => {
    const client = await seed();
    await resumeAutoPickForCurrentSeat(client, DRAFT);
    const second = await resumeAutoPickForCurrentSeat(client, DRAFT);
    expect(second.picks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.resume.test.ts`

Expected: FAIL — `resumeAutoPickForCurrentSeat` is not exported from `./processPick`.

- [ ] **Step 3: Implement `resumeAutoPickForCurrentSeat`**

Add to `src/core/processPick.ts`, after `triggerAutoPickOnDemand`:

```ts
/**
 * Re-evaluate auto-pick for whichever seat is currently on the clock, and cascade
 * from there.
 *
 * The cascade only ever runs as a side effect of a pick landing, and the client
 * trigger only runs in an open browser. That leaves a gap: a draft moving into
 * `drafting` re-arms on a seat nobody is watching, and because rotisserie order is
 * strict, no other seat can pick to restart the chain. Called on every transition
 * into `drafting` so a resumed draft does not sit dead on an absent player.
 *
 * Safe to call at any time — returns an empty outcome when there is nothing to do.
 */
export async function resumeAutoPickForCurrentSeat(
  client: Client,
  draftId: string,
): Promise<CascadeOutcome> {
  const empty: CascadeOutcome = { picks: [], phaseChanged: false, newPhase: null };

  const meta = await getDraftMeta(client, draftId);
  if (!meta) return empty;
  const { phase, numSeats, picksPerPlayer, doublePickAfterRound } = meta;
  if (phase !== 'drafting') return empty;

  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;

  const next = getNextPick(currentCount, numSeats, picksPerPlayer, doublePickAfterRound);
  if (!next) return empty;

  const allSeatSettings = await getAllSeatSettings(client, draftId);
  const seatSettings = allSeatSettings.get(next.seat);
  if (!seatSettings?.autoPick) return empty;

  const candidateResult = await selectAutoPickCandidateForSeat(
    client, draftId, next.seat, seatSettings, allSeatSettings,
  );
  if (candidateResult.kind !== 'candidate') return empty;

  return insertPickAndCascade(
    client,
    draftId,
    { seat: next.seat, cardId: candidateResult.cardId, cardName: candidateResult.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );
}
```

- [ ] **Step 4: Run the resume test**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.resume.test.ts`

Expected: all 5 tests PASS.

- [ ] **Step 5: Call it from `draft-start.ts`**

In `scripts/draft-start.ts`, add to the imports:

```ts
import { resumeAutoPickForCurrentSeat } from "../src/core/processPick";
```

Then replace the final `console.log` line with:

```ts
  const resumed = await resumeAutoPickForCurrentSeat(client, draftId);

  console.log(`Draft "${draftId}" is now in drafting phase`);
  if (resumed.picks.length > 0) {
    console.log(`Auto-picked ${resumed.picks.length} card(s) on start:`);
    for (const p of resumed.picks) {
      console.log(`  pick ${p.pickN}  seat ${p.seat}  ${p.cardName}`);
    }
  }
```

- [ ] **Step 6: Call it from `draft-admin.ts` `set-phase`**

In `scripts/draft-admin.ts`, add to the imports:

```ts
import { resumeAutoPickForCurrentSeat } from "../src/core/processPick";
```

Then replace the body of `setPhase` (lines 118-131) with:

```ts
async function setPhase(client: Client, draftId: string, args: string[]) {
  const phase = requireArg(args, "--phase");
  if (!VALID_PHASES.includes(phase as (typeof VALID_PHASES)[number])) {
    throw new Error(`Invalid phase "${phase}". Valid phases: ${VALID_PHASES.join(", ")}`);
  }

  const result = await client.execute({
    sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
    args: [phase, draftId],
  });
  if (result.rowsAffected === 0) throw new Error(`Draft "${draftId}" not found`);

  console.log(`Draft "${draftId}" phase set to "${phase}"`);

  if (phase === "drafting") {
    const resumed = await resumeAutoPickForCurrentSeat(client, draftId);
    if (resumed.picks.length > 0) {
      console.log(`Auto-picked ${resumed.picks.length} card(s) on resume:`);
      for (const p of resumed.picks) {
        console.log(`  pick ${p.pickN}  seat ${p.seat}  ${p.cardName}`);
      }
    }
  }
}
```

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm typecheck && pnpm lint && pnpm test`

Expected: all pass, zero lint warnings.

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/processPick.ts src/core/processPick.resume.test.ts scripts/draft-start.ts scripts/draft-admin.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Auto-pick for the seat on the clock when a draft enters drafting

A draft resuming from setup re-armed on whichever seat was on the clock, and
nothing re-evaluated them: the cascade only runs off a landing pick, the client
trigger needs an open browser, and strict rotisserie order means no other seat
can pick to restart it. draft:start and set-phase now run the cascade directly.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Record when each pick landed and which path produced it

**Files:**
- Create: `src/core/pickSource.ts`
- Modify: `src/core/db/schema.sql:70-76`
- Modify: `src/core/processPick.ts`
- Create: `src/core/processPick.provenance.test.ts`
- Modify: `src/core/db/__tests__/testDb.ts:60-68`

**Interfaces:**
- Consumes: `insertPickAndCascade` from Task 1, `resumeAutoPickForCurrentSeat` from Task 2.
- Produces:
  ```ts
  // src/core/pickSource.ts
  export type PickSource = 'manual' | 'ondemand' | 'resume' | 'cascade';
  ```
  `insertPickAndCascade` gains a 7th parameter `firstSource: PickSource`. Every pick after the first in a run is recorded as `'cascade'`.

- [ ] **Step 1: Create the `PickSource` type**

Create `src/core/pickSource.ts`:

```ts
/**
 * How a pick entered the system.
 *
 * - `manual`   — a player chose the card themselves (`{card_name}`)
 * - `ondemand` — a player's client asked the server to auto-pick for them (`{auto:true}`)
 * - `resume`   — the draft entered `drafting` and the seat on the clock was auto-picked for
 * - `cascade`  — auto-picked as the chain continued after an earlier pick in the same run
 *
 * Picks made before this column existed are NULL.
 */
export type PickSource = 'manual' | 'ondemand' | 'resume' | 'cascade';
```

- [ ] **Step 2: Add the columns to the schema**

In `src/core/db/schema.sql`, immediately after the `CREATE TABLE IF NOT EXISTS pick_events (...)` statement that ends at line 76, add:

```sql
-- Pick provenance. Added 2026-08-10. Both columns are nullable: SQLite forbids a
-- non-constant DEFAULT in ALTER TABLE ADD COLUMN, and picks made before this
-- change have no honest value to backfill.
ALTER TABLE pick_events ADD COLUMN created_at TEXT;
ALTER TABLE pick_events ADD COLUMN source TEXT;
```

`migrate.ts` already skips statements that fail with "duplicate column", so re-running `pnpm db:migrate` is safe.

- [ ] **Step 3: Add the columns to the test schema**

In `src/core/db/__tests__/testDb.ts`, replace the `pick_events` DDL (lines 60-68) with:

```ts
  await client.execute(`
    CREATE TABLE IF NOT EXISTS pick_events (
      draft_id TEXT NOT NULL,
      pick_n INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      created_at TEXT,
      source TEXT,
      PRIMARY KEY (draft_id, pick_n)
    )
  `);
```

- [ ] **Step 4: Write the failing provenance test**

Create `src/core/processPick.provenance.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Client } from '@libsql/client';
import { processPick, triggerAutoPickOnDemand, resumeAutoPickForCurrentSeat } from './processPick';
import {
  createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertSeatToken,
} from './db/__tests__/testDb';

const DRAFT = 'd1';

function queueOf(entries: Array<[number, string]>): string {
  return JSON.stringify(
    entries.map(([id, name]) => ({ mode: 'pause', cards: [{ id, name }] })),
  );
}

async function seed(): Promise<Client> {
  const client = await createMemDb();
  await insertCubeSnapshot(client, 1);
  const cards: Array<[number, string]> = [
    [1, 'Manual Card'], [11, 'S1 First'], [21, 'S2 First'], [31, 'S3 First'],
  ];
  for (const [id, name] of cards) {
    await insertCard(client, id, name);
    await insertCubeCard(client, 1, id, 1);
  }
  await insertDraft(client, DRAFT, { phase: 'drafting', numSeats: 3, cubeSnapshotId: 1 });
  await client.execute({
    sql: `UPDATE drafts SET picks_per_player = 3, double_pick_after_round = 3, in_app = 1 WHERE draft_id = ?`,
    args: [DRAFT],
  });
  await insertSeatToken(client, DRAFT, 1, { autoPick: true, queueJson: queueOf([[11, 'S1 First']]) });
  await insertSeatToken(client, DRAFT, 2, { autoPick: true, queueJson: queueOf([[21, 'S2 First']]) });
  await insertSeatToken(client, DRAFT, 3, { autoPick: true, queueJson: queueOf([[31, 'S3 First']]) });
  return client;
}

async function sources(client: Client): Promise<Array<{ pick_n: number; source: string | null }>> {
  const r = await client.execute({
    sql: `SELECT pick_n, source FROM pick_events WHERE draft_id = ? ORDER BY pick_n`,
    args: [DRAFT],
  });
  return r.rows.map((row) => ({ pick_n: row.pick_n as number, source: row.source as string | null }));
}

describe('pick provenance', () => {
  it('records a manual pick as manual and its cascade as cascade', async () => {
    const client = await seed();
    await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card' });
    const rows = await sources(client);
    expect(rows[0].source).toBe('manual');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records an on-demand auto-pick as ondemand and its cascade as cascade', async () => {
    const client = await seed();
    await triggerAutoPickOnDemand(client, DRAFT, 1);
    const rows = await sources(client);
    expect(rows[0].source).toBe('ondemand');
    expect(rows.slice(1).every((r) => r.source === 'cascade')).toBe(true);
  });

  it('records a phase resume as resume', async () => {
    const client = await seed();
    await resumeAutoPickForCurrentSeat(client, DRAFT);
    const rows = await sources(client);
    expect(rows[0].source).toBe('resume');
  });

  it('stamps created_at on every pick it writes', async () => {
    const client = await seed();
    await processPick(client, { draftId: DRAFT, seat: 1, cardId: 1, cardName: 'Manual Card' });
    const r = await client.execute({
      sql: `SELECT COUNT(*) AS c FROM pick_events WHERE draft_id = ? AND created_at IS NULL`,
      args: [DRAFT],
    });
    expect(r.rows[0].c as number).toBe(0);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.provenance.test.ts`

Expected: FAIL — every `source` is `null`.

- [ ] **Step 6: Thread the source through the insert**

In `src/core/processPick.ts`, add the import:

```ts
import type { PickSource } from './pickSource';
```

Replace `insertPickEvent` with:

```ts
/**
 * Insert a single pick event using an optimistic-concurrency guard: the INSERT
 * is conditional on pick_n not yet existing. Returns rowsAffected.
 */
async function insertPickEvent(
  client: Client,
  draftId: string,
  pickN: number,
  seat: number,
  cardId: number,
  source: PickSource,
): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO pick_events (draft_id, pick_n, seat, card_id, created_at, source)
          SELECT ?, ?, ?, ?, datetime('now'), ?
          WHERE NOT EXISTS (
            SELECT 1 FROM pick_events WHERE draft_id = ? AND pick_n = ?
          )`,
    args: [draftId, pickN, seat, cardId, source, draftId, pickN],
  });
  return result.rowsAffected;
}
```

- [ ] **Step 7: Add the `firstSource` parameter to `insertPickAndCascade`**

In `src/core/processPick.ts`, add a 7th parameter to `insertPickAndCascade`:

```ts
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
  firstSource: PickSource,
): Promise<CascadeOutcome> {
```

and inside the loop, change the insert call to:

```ts
    const rowsAffected = await insertPickEvent(
      client, draftId, pickN, currentSeat, currentCardId,
      cascadeDepth === 0 ? firstSource : 'cascade',
    );
```

- [ ] **Step 8: Pass the source at each call site**

In `processPick`, append `'manual'` to the `insertPickAndCascade` call:

```ts
  return insertPickAndCascade(
    client,
    input.draftId,
    { seat: input.seat, cardId: input.cardId, cardName: input.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
    'manual',
  );
```

In `triggerAutoPickOnDemand`, append `'ondemand'`:

```ts
  const outcome = await insertPickAndCascade(
    client,
    draftId,
    { seat, cardId, cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
    'ondemand',
  );
```

In `resumeAutoPickForCurrentSeat`, append `'resume'`:

```ts
  return insertPickAndCascade(
    client,
    draftId,
    { seat: next.seat, cardId: candidateResult.cardId, cardName: candidateResult.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
    'resume',
  );
```

- [ ] **Step 9: Run the provenance test**

Run: `cd /Users/arpanet/code/read-the-bones && npx vitest run src/core/processPick.provenance.test.ts`

Expected: all 4 tests PASS.

- [ ] **Step 10: Document the columns in CLAUDE.md**

In `/Users/arpanet/code/read-the-bones/CLAUDE.md`, directly beneath the "Terminology: Picks vs Rounds" heading's first paragraph, add a paragraph reading exactly:

> **Pick provenance:** `pick_events.created_at` and `pick_events.source` record when a pick landed and which path produced it — `manual`, `ondemand`, `resume`, or `cascade`. Both are NULL for picks made before 2026-08-10. To see how a draft is actually advancing, group by source: `SELECT source, COUNT(*) FROM pick_events WHERE draft_id = ? GROUP BY source;`

Write it as a normal Markdown paragraph (bold lead-in, inline code spans), not as a blockquote and not inside a fenced code block.

- [ ] **Step 11: Run the full gate**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm typecheck && pnpm lint && pnpm knip && pnpm test`

Expected: all pass, zero lint warnings, no knip findings. If knip reports `PickSource` as unused, confirm it is imported as a type in `processPick.ts` — a type-only export used across files is legitimate and knip is configured to allow it.

- [ ] **Step 12: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/pickSource.ts src/core/processPick.ts src/core/processPick.provenance.test.ts src/core/db/schema.sql src/core/db/__tests__/testDb.ts CLAUDE.md
git -C /Users/arpanet/code/read-the-bones commit -m "Record when each pick landed and which path produced it

Diagnosing a stalled draft meant guessing which entry point made a pick, because
pick_events stored neither a timestamp nor a source. Both are now written on
insert; rows predating this change stay NULL rather than being backfilled.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Deployment

The live `kishla-skimmer` draft is mid-flight, so deploy deliberately rather than as a side effect.

- [ ] **Step 1: Run the full gate**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm precommit`

- [ ] **Step 2: Apply the migration to Turso**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm db:migrate`

Expected: two `OK` lines for the new `ALTER TABLE pick_events` statements, or `SKIP (already exists)` if re-run. Verify:

```bash
turso db shell read-the-bones ".schema pick_events"
```

Expected: `created_at TEXT` and `source TEXT` present.

- [ ] **Step 3: Push**

```bash
git -C /Users/arpanet/code/read-the-bones push origin master
```

Pushing `master` deploys to production automatically. **The migration must land before the deploy**, because the new INSERT names both columns — running the new code against the old schema fails every pick.

- [ ] **Step 4: Verify in production**

After the deploy reports Ready, confirm the next real pick records provenance:

```bash
turso db shell read-the-bones "SELECT pick_n, seat, source, created_at FROM pick_events WHERE draft_id='kishla-skimmer' ORDER BY pick_n DESC LIMIT 5;"
```

Expected: newly made picks carry a `source` and `created_at`; older rows stay NULL. A `cascade` row appearing after an `ondemand` row is the fix working.
