# Live Draft Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable complete rotisserie drafts to run within Read the Bones — pool definition, snake drafting with pick queues, match reporting, and standings — replacing Google Sheets as the primary drafting interface.

**Architecture:** Derived state + transactional picks. No stored "current turn" — always computed from pick_events + snake formula. New tables for seat tokens and pick queues. Existing card table becomes the pick interface. Draft board modal shows the pick matrix. Polling (3-5s) with optimistic local updates for real-time feel.

**Tech Stack:** Next.js App Router, Turso/libSQL, TanStack React Table, React (modals, hooks), tsx CLI scripts, CubeCobra API.

**Spec:** `docs/superpowers/specs/2026-03-23-live-draft-design.md`

---

## Chunk 1: Schema, Core Logic, and Query Modules

### Task 1: Database Migration — New Tables and Column Extensions

**Files:**
- Modify: `src/core/db/schema.sql`
- Modify: `src/core/db/schema.ts`

- [ ] **Step 1: Write the migration SQL**

Add to the end of `src/core/db/schema.sql`:

```sql
-- Live draft: phase replaces is_complete
ALTER TABLE drafts ADD COLUMN phase TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE drafts ADD COLUMN in_app INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN picks_per_player INTEGER;

-- Backfill phase from is_complete
UPDATE drafts SET phase = CASE WHEN is_complete = 1 THEN 'complete' ELSE 'drafting' END;

-- Drop is_complete after migration (SQLite 3.35.0+)
ALTER TABLE drafts DROP COLUMN is_complete;

-- Match reporting attribution
ALTER TABLE match_events ADD COLUMN reported_by_seat INTEGER;

-- Seat tokens for live draft identity
CREATE TABLE IF NOT EXISTS seat_tokens (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auto_pick INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (draft_id, seat)
);

-- Backfill picks_per_player for historical drafts
UPDATE drafts SET picks_per_player = (
  SELECT MAX(pe.pick_n) / d2.num_seats
  FROM pick_events pe
  JOIN drafts d2 ON d2.draft_id = pe.draft_id
  WHERE pe.draft_id = drafts.draft_id
) WHERE picks_per_player IS NULL AND phase = 'complete';

-- Pick queue for banking picks
-- Uses card_id (integer FK) to match pick_events and cube_snapshot_cards
CREATE TABLE IF NOT EXISTS pick_queue (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  card_id INTEGER NOT NULL REFERENCES cards(card_id),
  PRIMARY KEY (draft_id, seat, priority)
);
```

- [ ] **Step 2: Update TypeScript type definitions**

In `src/core/db/schema.ts`, update the `Draft` interface:

```typescript
export interface Draft {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  num_seats: number;
  sheet_id: string | null;
  banned_cards: string | null;
  pool_hash: string | null;
  picks_hash: string | null;
  matches_hash: string | null;
  cube_snapshot_id: number;
  phase: 'setup' | 'drafting' | 'playing' | 'complete';
  in_app: number;
  picks_per_player: number | null;
}
```

Add new interfaces:

```typescript
export interface SeatToken {
  draft_id: string;
  seat: number;
  token: string;
  display_name: string | null;
  auto_pick: number;
}

export interface PickQueueEntry {
  draft_id: string;
  seat: number;
  priority: number;
  card_id: number;
}
```

- [ ] **Step 3: Run migration**

Run: `pnpm db:migrate`
Expected: Tables created, columns added. "duplicate column" warnings for already-migrated DBs are normal.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/schema.sql src/core/db/schema.ts
git commit -m "Add live draft schema: phase, seat_tokens, pick_queue tables"
```

### Task 2: Deprecate is_complete — Update All References

**Files:**
- Modify: `src/core/db/schema.ts` (remove `is_complete` from Draft interface — done in Task 1)
- Modify: `src/core/db/sync/index.ts` (lines 110, 142, 222-226)
- Modify: `src/core/getCards.ts` (lines 66, 125)
- Modify: `src/core/getDraftStats.ts` (line 210)
- Modify: `src/core/sync.ts` (lines 197, 339, 345, 361)
- Modify: `src/core/db/ingest/db-helpers.ts` (line 17)
- Modify: `scripts/draft-create.ts` (line 77)
- Modify: `src/core/db/sync/__tests__/sync.test.ts` (references to `is_complete` in assertions)

Each file needs `is_complete` replaced with `phase`:

- [ ] **Step 1: Update sync/index.ts**

Replace `is_complete` references:
- Line ~110: Parse `isComplete` → set `phase = 'complete'` instead of `is_complete = 1`
- Line ~222-226: `UPDATE drafts SET phase = 'complete' WHERE draft_id = ?`

- [ ] **Step 2: Update getCards.ts**

- Line ~66: `SELECT ... d.phase` instead of `d.is_complete`
- Line ~125: `is_complete: row.phase === 'complete'` (or remove if the consumer can use `phase` directly)

- [ ] **Step 3: Update getDraftStats.ts**

- Line ~210: `WHERE phase = 'complete'` instead of `WHERE is_complete = 1`

- [ ] **Step 4: Update sync.ts (old sync module)**

- Line ~197: `UPDATE drafts SET phase = 'complete'` instead of `is_complete = 1`
- Line ~345: `WHERE phase IN ('setup', 'drafting') AND sheet_id IS NOT NULL` instead of `is_complete = 0`
- Line ~361: `WHERE phase != 'complete'` instead of `is_complete = 0`

- [ ] **Step 5: Update db-helpers.ts**

- Line ~17: `phase = 'drafting'` instead of `is_complete = 0` in resetDraft

- [ ] **Step 6: Update draft-create.ts**

- Line ~77: Insert with `phase = 'setup'` instead of `is_complete = 0`

- [ ] **Step 7: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. Fix any failures caused by the is_complete → phase migration.

- [ ] **Step 8: Run precommit checks**

Run: `pnpm precommit`
Expected: Typecheck, lint, knip, and tests all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "Replace is_complete with phase column across all queries"
```

### Task 3: Snake Draft Order — Core Logic

**Files:**
- Create: `src/core/snakeDraft.ts`
- Create: `src/core/snakeDraft.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/snakeDraft.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { derivePickSeat, getTotalPicks } from './snakeDraft';

describe('derivePickSeat', () => {
  describe('single-pick region (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('round 1 forward: seats 1,2,3,4', () => {
      expect(derivePickSeat(1, opts)).toMatchObject({ seat: 1, round: 1 });
      expect(derivePickSeat(2, opts)).toMatchObject({ seat: 2, round: 1 });
      expect(derivePickSeat(3, opts)).toMatchObject({ seat: 3, round: 1 });
      expect(derivePickSeat(4, opts)).toMatchObject({ seat: 4, round: 1 });
    });

    it('round 2 reverse: seats 4,3,2,1', () => {
      expect(derivePickSeat(5, opts)).toMatchObject({ seat: 4, round: 2 });
      expect(derivePickSeat(6, opts)).toMatchObject({ seat: 3, round: 2 });
      expect(derivePickSeat(7, opts)).toMatchObject({ seat: 2, round: 2 });
      expect(derivePickSeat(8, opts)).toMatchObject({ seat: 1, round: 2 });
    });

    it('round 3 forward: seats 1,2,3,4', () => {
      expect(derivePickSeat(9, opts)).toMatchObject({ seat: 1, round: 3 });
      expect(derivePickSeat(12, opts)).toMatchObject({ seat: 4, round: 3 });
    });

    it('all single picks have isDoublePick = false', () => {
      for (let i = 1; i <= 12; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(false);
      }
    });
  });

  describe('double-pick region (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };
    // singlePickRounds = floor(6/2) = 3, singlePickTotal = 12

    it('round 4 reverse (double): seats 4,4,3,3,2,2,1,1', () => {
      expect(derivePickSeat(13, opts)).toMatchObject({ seat: 4, round: 4, isDoublePick: true });
      expect(derivePickSeat(14, opts)).toMatchObject({ seat: 4, round: 4 });
      expect(derivePickSeat(15, opts)).toMatchObject({ seat: 3, round: 4 });
      expect(derivePickSeat(16, opts)).toMatchObject({ seat: 3, round: 4 });
      expect(derivePickSeat(17, opts)).toMatchObject({ seat: 2, round: 4 });
      expect(derivePickSeat(18, opts)).toMatchObject({ seat: 2, round: 4 });
      expect(derivePickSeat(19, opts)).toMatchObject({ seat: 1, round: 4 });
      expect(derivePickSeat(20, opts)).toMatchObject({ seat: 1, round: 4 });
    });

    it('round 5 forward (double): seats 1,1,2,2', () => {
      expect(derivePickSeat(21, opts)).toMatchObject({ seat: 1, round: 5 });
      expect(derivePickSeat(22, opts)).toMatchObject({ seat: 1, round: 5 });
      expect(derivePickSeat(23, opts)).toMatchObject({ seat: 2, round: 5 });
      expect(derivePickSeat(24, opts)).toMatchObject({ seat: 2, round: 5 });
    });
  });

  describe('10 seats, 45 picks each', () => {
    const opts = { numSeats: 10, picksPerPlayer: 45 };
    // singlePickRounds = 22, singlePickTotal = 220

    it('pick 1 is seat 1 round 1', () => {
      expect(derivePickSeat(1, opts)).toMatchObject({ seat: 1, round: 1 });
    });

    it('pick 10 is seat 10 round 1', () => {
      expect(derivePickSeat(10, opts)).toMatchObject({ seat: 10, round: 1 });
    });

    it('pick 11 is seat 10 round 2 (reverse)', () => {
      expect(derivePickSeat(11, opts)).toMatchObject({ seat: 10, round: 2 });
    });

    it('pick 220 is last single pick', () => {
      const result = derivePickSeat(220, opts);
      expect(result.isDoublePick).toBe(false);
    });

    it('pick 221 is first double pick', () => {
      const result = derivePickSeat(221, opts);
      expect(result.isDoublePick).toBe(true);
      expect(result.round).toBe(23);
    });

    it('total picks = 450', () => {
      expect(getTotalPicks(10, 45)).toBe(450);
    });

    it('every seat gets exactly 45 picks', () => {
      const counts = new Map<number, number>();
      for (let i = 1; i <= 450; i++) {
        const { seat } = derivePickSeat(i, opts);
        counts.set(seat, (counts.get(seat) ?? 0) + 1);
      }
      for (let s = 1; s <= 10; s++) {
        expect(counts.get(s)).toBe(45);
      }
    });
  });
});

describe('getTotalPicks', () => {
  it('returns numSeats * picksPerPlayer', () => {
    expect(getTotalPicks(10, 45)).toBe(450);
    expect(getTotalPicks(4, 6)).toBe(24);
    expect(getTotalPicks(8, 40)).toBe(320);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/snakeDraft.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/core/snakeDraft.ts`:

```typescript
export interface PickSeatResult {
  seat: number;
  round: number;
  isDoublePick: boolean;
}

interface SnakeDraftOpts {
  numSeats: number;
  picksPerPlayer: number;
}

export function derivePickSeat(
  pickNumber: number,
  opts: SnakeDraftOpts,
): PickSeatResult {
  const { numSeats, picksPerPlayer } = opts;
  const singlePickRounds = Math.floor(picksPerPlayer / 2);
  const singlePickTotal = singlePickRounds * numSeats;
  const picksPerDoubleRound = numSeats * 2;

  let round: number;
  let posInRound: number;
  let isDoublePick: boolean;

  if (pickNumber <= singlePickTotal) {
    round = Math.ceil(pickNumber / numSeats);
    posInRound = (pickNumber - 1) % numSeats;
    isDoublePick = false;
  } else {
    const doublePickIndex = pickNumber - singlePickTotal - 1;
    const doubleRound = Math.floor(doublePickIndex / picksPerDoubleRound);
    const posInDoubleRound = doublePickIndex % picksPerDoubleRound;
    round = singlePickRounds + 1 + doubleRound;
    posInRound = Math.floor(posInDoubleRound / 2);
    isDoublePick = true;
  }

  const isForward = round % 2 === 1;
  const seat = isForward ? posInRound + 1 : numSeats - posInRound;

  return { seat, round, isDoublePick };
}

export function getTotalPicks(
  numSeats: number,
  picksPerPlayer: number,
): number {
  return numSeats * picksPerPlayer;
}

/**
 * Derive the next pick number and seat for a draft.
 * Returns null if all picks are made.
 */
export function getNextPick(
  currentPickCount: number,
  numSeats: number,
  picksPerPlayer: number,
): { pickNumber: number; seat: number } | null {
  const total = getTotalPicks(numSeats, picksPerPlayer);
  if (currentPickCount >= total) return null;
  const pickNumber = currentPickCount + 1;
  const { seat } = derivePickSeat(pickNumber, { numSeats, picksPerPlayer });
  return { pickNumber, seat };
}

/**
 * Build the full pick matrix: for each round, the ordered list of seats.
 * Used by the draft board to render the grid.
 */
export function buildPickMatrix(
  numSeats: number,
  picksPerPlayer: number,
): { round: number; isForward: boolean; isDoublePick: boolean; seats: number[] }[] {
  const total = getTotalPicks(numSeats, picksPerPlayer);
  const rounds: Map<number, { isForward: boolean; isDoublePick: boolean; seats: number[] }> = new Map();

  for (let p = 1; p <= total; p++) {
    const { seat, round, isDoublePick } = derivePickSeat(p, { numSeats, picksPerPlayer });
    if (!rounds.has(round)) {
      rounds.set(round, {
        isForward: round % 2 === 1,
        isDoublePick,
        seats: [],
      });
    }
    rounds.get(round)!.seats.push(seat);
  }

  return Array.from(rounds.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, data]) => ({ round, ...data }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/snakeDraft.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/snakeDraft.ts src/core/snakeDraft.test.ts
git commit -m "Add snake draft order logic with single/double pick support"
```

### Task 4: Seat Token Query Module

**Files:**
- Create: `src/core/db/queries/seatTokens.ts`
- Create: `src/core/db/queries/seatTokens.test.ts`
- Modify: `src/core/db/queries/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/db/queries/seatTokens.test.ts`. Test the module's functions against a mock client (same pattern as existing query tests — check `src/core/db/queries.test.ts` for the mock pattern).

Key test cases:
- `generateSeatTokens(draftId, numSeats)` → creates N tokens with cryptographic randomness
- `resolveToken(token)` → returns `{ draftId, seat }` or null
- `getSeatTokens(draftId)` → returns all tokens for a draft
- `regenerateToken(draftId, seat)` → replaces token for a seat
- `updateDisplayName(draftId, seat, name)` → sets display name
- `updateAutoPick(draftId, seat, enabled)` → toggles auto-pick

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/seatTokens.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/core/db/queries/seatTokens.ts`:

```typescript
import { randomBytes } from 'crypto';
import type { Client } from '@libsql/client';

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function generateSeatTokens(
  client: Client,
  draftId: string,
  numSeats: number,
): Promise<{ seat: number; token: string }[]> {
  const tokens: { seat: number; token: string }[] = [];
  for (let seat = 1; seat <= numSeats; seat++) {
    const token = generateToken();
    await client.execute({
      sql: `INSERT INTO seat_tokens (draft_id, seat, token, auto_pick)
            VALUES (?, ?, ?, 1)`,
      args: [draftId, seat, token],
    });
    tokens.push({ seat, token });
  }
  return tokens;
}

export async function resolveToken(
  client: Client,
  token: string,
): Promise<{ draftId: string; seat: number; autoPick: boolean } | null> {
  const result = await client.execute({
    sql: `SELECT draft_id, seat, auto_pick FROM seat_tokens WHERE token = ?`,
    args: [token],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    draftId: row.draft_id as string,
    seat: row.seat as number,
    autoPick: row.auto_pick === 1,
  };
}

export async function getSeatTokens(
  client: Client,
  draftId: string,
): Promise<{ seat: number; token: string; displayName: string | null; autoPick: boolean }[]> {
  const result = await client.execute({
    sql: `SELECT seat, token, display_name, auto_pick
          FROM seat_tokens WHERE draft_id = ? ORDER BY seat`,
    args: [draftId],
  });
  return result.rows.map((row) => ({
    seat: row.seat as number,
    token: row.token as string,
    displayName: row.display_name as string | null,
    autoPick: row.auto_pick === 1,
  }));
}

export async function regenerateToken(
  client: Client,
  draftId: string,
  seat: number,
): Promise<string> {
  const newToken = generateToken();
  await client.execute({
    sql: `UPDATE seat_tokens SET token = ? WHERE draft_id = ? AND seat = ?`,
    args: [newToken, draftId, seat],
  });
  return newToken;
}

export async function updateDisplayName(
  client: Client,
  draftId: string,
  seat: number,
  displayName: string | null,
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET display_name = ? WHERE draft_id = ? AND seat = ?`,
    args: [displayName, draftId, seat],
  });
}

export async function updateAutoPick(
  client: Client,
  draftId: string,
  seat: number,
  enabled: boolean,
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET auto_pick = ? WHERE draft_id = ? AND seat = ?`,
    args: [enabled ? 1 : 0, draftId, seat],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/seatTokens.test.ts`
Expected: All pass.

- [ ] **Step 5: Export from index**

Add to `src/core/db/queries/index.ts`:
```typescript
export * from './seatTokens';
```

- [ ] **Step 6: Commit**

```bash
git add src/core/db/queries/seatTokens.ts src/core/db/queries/seatTokens.test.ts src/core/db/queries/index.ts
git commit -m "Add seat token query module for live draft identity"
```

### Task 5: Pick Queue Query Module

**Files:**
- Create: `src/core/db/queries/pickQueue.ts`
- Create: `src/core/db/queries/pickQueue.test.ts`
- Modify: `src/core/db/queries/index.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/db/queries/pickQueue.test.ts`. Key test cases:
- `getQueue(draftId, seat)` → returns ordered queue entries with card names
- `setQueue(draftId, seat, cardIds)` → replaces entire queue (uses integer card_ids)
- `removeCardFromAllQueues(draftId, cardId)` → removes a picked card from all seats' queues, renumbers priorities
- `getAutoPickCandidate(draftId, seat, availableCardIds)` → returns highest priority queued card_id that's still available, or null

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/pickQueue.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/db/queries/pickQueue.ts`:

```typescript
import type { Client } from '@libsql/client';

export async function getQueue(
  client: Client,
  draftId: string,
  seat: number,
): Promise<{ priority: number; cardId: number; cardName: string }[]> {
  const result = await client.execute({
    sql: `SELECT pq.priority, pq.card_id, c.name
          FROM pick_queue pq
          JOIN cards c ON c.card_id = pq.card_id
          WHERE pq.draft_id = ? AND pq.seat = ?
          ORDER BY pq.priority`,
    args: [draftId, seat],
  });
  return result.rows.map((row) => ({
    priority: row.priority as number,
    cardId: row.card_id as number,
    cardName: row.name as string,
  }));
}

export async function setQueue(
  client: Client,
  draftId: string,
  seat: number,
  cardIds: number[],
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
    args: [draftId, seat],
  });
  for (let i = 0; i < cardIds.length; i++) {
    await client.execute({
      sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id)
            VALUES (?, ?, ?, ?)`,
      args: [draftId, seat, i + 1, cardIds[i]],
    });
  }
}

export async function removeCardFromAllQueues(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<void> {
  // Delete the card from all queues
  await client.execute({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND card_id = ?`,
    args: [draftId, cardId],
  });
  // Renumber priorities to compact gaps
  const seats = await client.execute({
    sql: `SELECT DISTINCT seat FROM pick_queue WHERE draft_id = ? ORDER BY seat`,
    args: [draftId],
  });
  for (const row of seats.rows) {
    const seat = row.seat as number;
    const entries = await client.execute({
      sql: `SELECT card_id FROM pick_queue
            WHERE draft_id = ? AND seat = ?
            ORDER BY priority`,
      args: [draftId, seat],
    });
    await client.execute({
      sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
      args: [draftId, seat],
    });
    for (let i = 0; i < entries.rows.length; i++) {
      await client.execute({
        sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id)
              VALUES (?, ?, ?, ?)`,
        args: [draftId, seat, i + 1, entries.rows[i].card_id],
      });
    }
  }
}

export async function getAutoPickCandidate(
  client: Client,
  draftId: string,
  seat: number,
  availableCardIds: Set<number>,
): Promise<number | null> {
  const queue = await getQueue(client, draftId, seat);
  for (const entry of queue) {
    if (availableCardIds.has(entry.cardId)) {
      return entry.cardId;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/pickQueue.test.ts`
Expected: All pass.

- [ ] **Step 5: Export from index and commit**

```bash
git add src/core/db/queries/pickQueue.ts src/core/db/queries/pickQueue.test.ts src/core/db/queries/index.ts
git commit -m "Add pick queue query module for banking draft picks"
```

### Task 6: Process Pick — Core Transaction Logic

**Files:**
- Create: `src/core/processPick.ts`
- Create: `src/core/processPick.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/processPick.test.ts`. Key test cases:
- Rejects pick when phase is not `drafting`
- Rejects pick when it's not this seat's turn
- Rejects pick for a card that's already been picked
- Rejects pick for a banned card
- Records pick and returns it
- Removes picked card from all queues
- Cascades to next seat when auto-pick queue matches
- Stops cascade when next seat has no queue or auto_pick is off
- Stops cascade at max depth (`num_seats * 2`)
- Transitions to `playing` phase when all picks are made
- Uses optimistic concurrency (conflict on duplicate pick_n)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/processPick.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/processPick.ts`:

```typescript
import type { Client } from '@libsql/client';
import { getNextPick, getTotalPicks } from './snakeDraft';
import { removeCardFromAllQueues, getAutoPickCandidate } from './db/queries/pickQueue';

export interface ProcessPickResult {
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  phaseChanged: boolean;
  newPhase: string | null;
}

export interface ProcessPickInput {
  draftId: string;
  seat: number;
  cardId: number;      // integer FK from cards table
  cardName: string;
}

export async function processPick(
  client: Client,
  input: ProcessPickInput,
): Promise<ProcessPickResult> {
  // 1. Load draft metadata
  const draft = await client.execute({
    sql: `SELECT phase, num_seats, picks_per_player, banned_cards
          FROM drafts WHERE draft_id = ?`,
    args: [input.draftId],
  });
  if (draft.rows.length === 0) throw new Error('Draft not found');
  const row = draft.rows[0];
  const phase = row.phase as string;
  const numSeats = row.num_seats as number;
  const picksPerPlayer = row.picks_per_player as number;
  const bannedCards: string[] = row.banned_cards
    ? JSON.parse(row.banned_cards as string)
    : [];

  if (phase !== 'drafting') {
    throw new Error(`Draft is in '${phase}' phase, not 'drafting'`);
  }

  // 2. Derive whose turn it is
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [input.draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
  const next = getNextPick(currentCount, numSeats, picksPerPlayer);
  if (!next) throw new Error('All picks are made');
  if (next.seat !== input.seat) {
    throw new Error(`It's seat ${next.seat}'s turn, not seat ${input.seat}'s`);
  }

  // 3. Validate card is available and not banned
  if (bannedCards.includes(input.cardName)) {
    throw new Error(`${input.cardName} is banned`);
  }
  const alreadyPicked = await client.execute({
    sql: `SELECT 1 FROM pick_events
          WHERE draft_id = ? AND card_id = ?`,
    args: [input.draftId, input.cardId],
  });
  if (alreadyPicked.rows.length > 0) {
    throw new Error(`${input.cardName} has already been picked`);
  }

  // 4. Insert with optimistic concurrency
  const picks: ProcessPickResult['picks'] = [];
  const maxCascade = numSeats * 2;

  let currentSeat = input.seat;
  let currentCardId = input.cardId;
  let currentCardName = input.cardName;
  let cascadeDepth = 0;

  while (cascadeDepth < maxCascade) {
    const pickN = currentCount + picks.length + 1;

    const inserted = await client.execute({
      sql: `INSERT INTO pick_events (draft_id, pick_n, seat, card_id)
            SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM pick_events WHERE draft_id = ? AND pick_n = ?
            )`,
      args: [input.draftId, pickN, currentSeat, currentCardId,
             input.draftId, pickN],
    });
    if (inserted.rowsAffected === 0) {
      throw new Error('Conflict: pick_n already exists — retry');
    }

    picks.push({
      pickN,
      seat: currentSeat,
      cardId: currentCardId,
      cardName: currentCardName,
    });

    // Remove from all queues (uses card_id, matching pick_queue schema)
    await removeCardFromAllQueues(client, input.draftId, currentCardId);

    // Check if draft is complete
    const totalAfter = currentCount + picks.length;
    const totalExpected = getTotalPicks(numSeats, picksPerPlayer);
    if (totalAfter >= totalExpected) {
      await client.execute({
        sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
        args: [input.draftId],
      });
      return { picks, phaseChanged: true, newPhase: 'playing' };
    }

    // Check next seat for auto-pick
    const nextAfter = getNextPick(totalAfter, numSeats, picksPerPlayer);
    if (!nextAfter) break;

    const nextSeatToken = await client.execute({
      sql: `SELECT auto_pick FROM seat_tokens WHERE draft_id = ? AND seat = ?`,
      args: [input.draftId, nextAfter.seat],
    });
    if (nextSeatToken.rows.length === 0 || nextSeatToken.rows[0].auto_pick !== 1) {
      break; // No auto-pick for next seat
    }

    // Get available card_ids for the draft (integer IDs from cube_snapshot_cards)
    const available = await client.execute({
      sql: `SELECT csc.card_id
            FROM cube_snapshot_cards csc
            JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE d.draft_id = ?
            AND csc.card_id NOT IN (
              SELECT card_id FROM pick_events WHERE draft_id = ?
            )`,
      args: [input.draftId, input.draftId],
    });
    const availableSet = new Set(available.rows.map((r) => r.card_id as number));

    const candidate = await getAutoPickCandidate(
      client, input.draftId, nextAfter.seat, availableSet,
    );
    if (!candidate) break;

    // Look up card name for the candidate
    const cardRow = await client.execute({
      sql: `SELECT name FROM cards WHERE card_id = ?`,
      args: [candidate],
    });
    if (cardRow.rows.length === 0) break;

    currentSeat = nextAfter.seat;
    currentCardId = candidate;
    currentCardName = cardRow.rows[0].name as string;
    cascadeDepth++;
  }

  return { picks, phaseChanged: false, newPhase: null };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/processPick.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/processPick.ts src/core/processPick.test.ts
git commit -m "Add processPick with cascade auto-pick and concurrency control"
```

### Task 7: CubeCobra Card Pool Fetcher

**Files:**
- Create: `src/core/cubecobra.ts`
- Create: `src/core/cubecobra.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/cubecobra.test.ts`. Key test cases:
- `parseCubeCobraInput('cubecobra:my_cube_id')` → returns `'my_cube_id'`
- `parseCubeCobraInput('https://cubecobra.com/cube/list/my_cube_id')` → returns `'my_cube_id'`
- `parseCubeCobraInput('file:path/to/list.txt')` → returns null (not a CubeCobra input)
- `fetchCubeCobraList(cubeId)` → returns array of card names (mock fetch)
- Handles fetch errors gracefully

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/cubecobra.test.ts`
Expected: FAIL

- [ ] **Step 3: Write implementation**

Create `src/core/cubecobra.ts`:

```typescript
export function parseCubeCobraInput(input: string): string | null {
  if (input.startsWith('cubecobra:')) {
    return input.slice('cubecobra:'.length);
  }
  const urlMatch = input.match(
    /cubecobra\.com\/cube\/(?:list|overview|analysis)\/([^/?#]+)/,
  );
  if (urlMatch) return urlMatch[1];
  return null;
}

export async function fetchCubeCobraList(cubeId: string): Promise<string[]> {
  const url = `https://cubecobra.com/cube/api/cubelist/${encodeURIComponent(cubeId)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `CubeCobra API returned ${response.status} for cube "${cubeId}". ` +
      `Try the file: fallback instead (--pool file:path/to/list.txt).`,
    );
  }
  const text = await response.text();
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function loadCardPool(poolArg: string): Promise<string[]> {
  const cubeId = parseCubeCobraInput(poolArg);
  if (cubeId) {
    return fetchCubeCobraList(cubeId);
  }
  if (poolArg.startsWith('file:')) {
    const fs = await import('fs/promises');
    const filePath = poolArg.slice('file:'.length);
    const text = await fs.readFile(filePath, 'utf-8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  throw new Error(
    `Unrecognized pool format: "${poolArg}". ` +
    `Use cubecobra:<id>, a CubeCobra URL, or file:<path>.`,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/cubecobra.test.ts`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/cubecobra.ts src/core/cubecobra.test.ts
git commit -m "Add CubeCobra card pool fetcher with file fallback"
```

## Chunk 2: CLI Scripts and API Routes

### Task 8: CLI — draft:create-live Script

**Files:**
- Create: `scripts/draft-create-live.ts`
- Modify: `package.json` (add script)

This script orchestrates draft creation: parses args, fetches pool, resolves cards, creates cube snapshot, generates tokens.

- [ ] **Step 1: Write the script**

Create `scripts/draft-create-live.ts`. Follow the pattern from `scripts/draft-create.ts` (arg parsing with `process.argv`). The script:

1. Parse args: `--name`, `--date`, `--seats`, `--picks-per-player`, `--pool`, `--banned-cards`
2. Validate all required args present
3. Slugify name to create `draft_id`
4. Call `loadCardPool(poolArg)` to get card names
5. Initialize CardCache from DB, resolve all card names through Scryfall pipeline
6. Create cube snapshot via existing `ensureCubeSnapshot()`
7. Insert draft record with `in_app = 1`, `phase = 'setup'`, `picks_per_player`
8. Call `generateSeatTokens(draftId, numSeats)`
9. Print seat URLs: `https://<host>/drafts/<id>?token=<token>`

Reference: `scripts/draft-create.ts` for DB client initialization and arg parsing pattern. Reference: `src/core/db/sync/index.ts` for card resolution and cube snapshot creation pattern.

- [ ] **Step 2: Add package.json script**

Add to `package.json` scripts:
```json
"draft:create-live": "tsx scripts/draft-create-live.ts"
```

- [ ] **Step 3: Test manually**

Run: `pnpm draft:create-live --name "Test Draft" --date 2026-04-01 --seats 4 --picks-per-player 6 --pool file:test-pool.txt`
(Create a small test-pool.txt with a few card names first)
Expected: Draft created, tokens printed.

- [ ] **Step 4: Commit**

```bash
git add scripts/draft-create-live.ts package.json
git commit -m "Add draft:create-live CLI for creating in-app rotisserie drafts"
```

### Task 9: CLI — draft:start Script

**Files:**
- Create: `scripts/draft-start.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the script**

Simple script: takes draft name/id, validates phase is `setup`, updates to `drafting`.

```typescript
// Parse draft name from args
// Look up draft, verify phase === 'setup'
// UPDATE drafts SET phase = 'drafting' WHERE draft_id = ?
// Print confirmation
```

- [ ] **Step 2: Add package.json script**

```json
"draft:start": "tsx scripts/draft-start.ts"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/draft-start.ts package.json
git commit -m "Add draft:start CLI to transition draft from setup to drafting"
```

### Task 10: CLI — Admin Tools (undo-pick, edit-pick, regen-token, set-phase, enter-match)

**Files:**
- Create: `scripts/draft-admin.ts` (single script with subcommands)
- Modify: `package.json`

Rather than 8 separate scripts (as listed in the spec), consolidate into a single entry point with subcommands for maintainability:

```bash
pnpm draft:admin undo-pick <name> [--pick <n>]
pnpm draft:admin edit-pick <name> --pick <n> --card <name>
pnpm draft:admin regen-token <name> --seat <n>
pnpm draft:admin set-phase <name> --phase <phase>
pnpm draft:admin add-ban <name> --card <name>
pnpm draft:admin remove-ban <name> --card <name>
pnpm draft:admin reorder-seats <name> --order 3,1,4,2,...
pnpm draft:admin enter-match <name> --seats 1,5 --wins 2,1
```

- [ ] **Step 1: Write the admin script**

Create `scripts/draft-admin.ts`. Each subcommand is a function that takes parsed args and a DB client. The main function dispatches based on `process.argv[2]`.

Key implementations:
- `undoPick`: `DELETE FROM pick_events WHERE draft_id = ? AND pick_n = (SELECT MAX(pick_n) FROM pick_events WHERE draft_id = ?)`
- `editPick`: Resolve new card name, update `card_id` on the pick_events row
- `regenToken`: Call `regenerateToken()` from seatTokens query module
- `setPhase`: Validate phase value, update draft
- `addBan/removeBan`: Parse/update `banned_cards` JSON array on draft
- `reorderSeats`: Validate setup phase, remap seat numbers in seat_tokens
- `enterMatch`: Insert into match_events with `reported_by_seat = NULL`

- [ ] **Step 2: Add package.json script**

```json
"draft:admin": "tsx scripts/draft-admin.ts"
```

- [ ] **Step 3: Test key subcommands manually**

Run: `pnpm draft:admin set-phase test-draft --phase drafting`
Expected: Phase updated confirmation.

- [ ] **Step 4: Commit**

```bash
git add scripts/draft-admin.ts package.json
git commit -m "Add draft:admin CLI with undo, edit, token, phase, ban, and match tools"
```

### Task 11: Token Auth Middleware

**Files:**
- Create: `src/core/tokenAuth.ts`
- Create: `src/core/tokenAuth.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases:
- `extractToken(request)` → reads from `X-Seat-Token` header
- `extractToken(request)` → reads from `?token=` query param
- `extractToken(request)` → returns null if neither present
- `authenticateSeat(client, request, draftId)` → returns `{ seat, autoPick }` for valid token
- `authenticateSeat(client, request, draftId)` → throws for invalid token
- `authenticateSeat(client, request, draftId)` → throws if token's draftId doesn't match

- [ ] **Step 2: Write implementation**

```typescript
import { NextRequest } from 'next/server';
import type { Client } from '@libsql/client';
import { resolveToken } from './db/queries/seatTokens';

export function extractToken(request: NextRequest): string | null {
  const header = request.headers.get('X-Seat-Token');
  if (header) return header;
  const url = new URL(request.url);
  return url.searchParams.get('token');
}

export async function authenticateSeat(
  client: Client,
  request: NextRequest,
  draftId: string,
): Promise<{ seat: number; autoPick: boolean }> {
  const token = extractToken(request);
  if (!token) throw new Error('Missing seat token');
  const resolved = await resolveToken(client, token);
  if (!resolved) throw new Error('Invalid seat token');
  if (resolved.draftId !== draftId) throw new Error('Token does not match draft');
  return { seat: resolved.seat, autoPick: resolved.autoPick };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/core/tokenAuth.ts src/core/tokenAuth.test.ts
git commit -m "Add token auth utility for live draft seat validation"
```

### Task 12: API Route — POST /api/drafts/[id]/pick

**Files:**
- Create: `src/app/api/drafts/[id]/pick/route.ts`
- Create: `src/app/api/drafts/[id]/pick/route.test.ts`

- [ ] **Step 1: Write failing tests**

Follow the pattern from `src/app/api/drafts/[id]/picks/route.test.ts`. Test:
- 401 when no token provided
- 400 when card_name missing from body
- 409 on concurrency conflict
- 200 with picks array on success
- Response includes cascaded auto-picks

- [ ] **Step 2: Write the route**

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@/core/db/client';
import { authenticateSeat } from '@/core/tokenAuth';
import { processPick } from '@/core/processPick';
// ... card resolution from existing helpers

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: draftId } = await params;
  const client = getClient();

  try {
    const { seat } = await authenticateSeat(client, request, draftId);
    const body = await request.json();
    const { card_name } = body;
    if (!card_name) {
      return NextResponse.json({ error: 'card_name required' }, { status: 400 });
    }

    // Resolve card_name to card_id (integer) via the cards table
    // Use resolveCard from queries/cards.ts or a direct lookup:
    const cardRow = await client.execute({
      sql: `SELECT card_id FROM cards WHERE name = ?`,
      args: [card_name],
    });
    if (cardRow.rows.length === 0) {
      return NextResponse.json({ error: `Card not found: ${card_name}` }, { status: 400 });
    }
    const cardId = cardRow.rows[0].card_id as number;

    const result = await processPick(client, {
      draftId,
      seat,
      cardId,
      cardName: card_name,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Conflict')) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.message.includes('Missing seat token') || error.message.includes('Invalid seat token')) {
        return NextResponse.json({ error: error.message }, { status: 401 });
      }
      if (error.message.includes('turn') || error.message.includes('banned') || error.message.includes('already been picked')) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    }
    console.error('[/api/drafts/[id]/pick] Error:', error);
    return NextResponse.json({ error: 'Pick failed' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/pick/
git commit -m "Add POST /api/drafts/[id]/pick route for submitting draft picks"
```

### Task 13: API Route — GET /api/drafts/[id]/status

**Files:**
- Create: `src/app/api/drafts/[id]/status/route.ts`
- Create: `src/app/api/drafts/[id]/status/route.test.ts`

- [ ] **Step 1: Write failing tests, then implement**

The route returns:
```json
{
  "phase": "drafting",
  "latestPickN": 42,
  "nextSeat": 3,
  "numSeats": 10,
  "picksPerPlayer": 45,
  "recentPicks": [
    { "pickN": 42, "seat": 2, "cardName": "Lightning Bolt" },
    { "pickN": 41, "seat": 1, "cardName": "Counterspell" }
  ],
  "matchCount": 0,
  "totalMatches": 45,
  "seatNames": { "1": "Ray Bees", "2": "joshez" }
}
```

Query pattern: `SELECT MAX(pick_n)` + `derivePickSeat` for next seat + last 10 picks joined with card names + seat token display names.

- [ ] **Step 2: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/status/
git commit -m "Add GET /api/drafts/[id]/status route for live draft polling"
```

### Task 14: API Route — GET/PUT /api/drafts/[id]/queue

**Files:**
- Create: `src/app/api/drafts/[id]/queue/route.ts`
- Create: `src/app/api/drafts/[id]/queue/route.test.ts`

- [ ] **Step 1: Write tests and implementation**

GET: Authenticated, returns the player's queue with card names.
PUT: Authenticated, replaces the queue. Body is `[{ card_name }]`. Resolve each card name to `card_id` (integer) via the cards table, then call `setQueue()` with the integer card_ids.

Both require token auth. Return 401 if unauthenticated.

- [ ] **Step 2: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/queue/
git commit -m "Add GET/PUT /api/drafts/[id]/queue routes for pick queue management"
```

### Task 15: API Route — GET /api/drafts/[id]/board

**Files:**
- Create: `src/app/api/drafts/[id]/board/route.ts`
- Create: `src/app/api/drafts/[id]/board/route.test.ts`

- [ ] **Step 1: Write tests and implementation**

Returns the full pick matrix for the draft board modal:
```json
{
  "draftId": "tarkir-rotisserie",
  "numSeats": 10,
  "picksPerPlayer": 45,
  "phase": "drafting",
  "seatNames": { "1": "Ray Bees", "2": "joshez", ... },
  "picks": [
    { "pickN": 1, "seat": 1, "cardName": "Sol Ring", "oracleId": "...", "colorIdentity": ["C"], "manaCost": "{1}" },
    ...
  ],
  "bannedCards": ["Card A"]
}
```

The client builds the matrix from this data using `derivePickSeat` + `buildPickMatrix`.

- [ ] **Step 2: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/board/
git commit -m "Add GET /api/drafts/[id]/board route for draft board matrix data"
```

### Task 16: API Route — POST /api/drafts/[id]/match

**Files:**
- Create: `src/app/api/drafts/[id]/match/route.ts`
- Create: `src/app/api/drafts/[id]/match/route.test.ts`

- [ ] **Step 1: Write tests and implementation**

Authenticated route. Body: `{ opponent_seat, wins, losses }`.

Validates:
- Draft phase is `playing` or `complete`
- Token holder's seat is one of the two seats in the match
- Inserts or replaces match_events row (upsert on `draft_id, seat1, seat2` where seat1 < seat2)
- Sets `reported_by_seat`

- [ ] **Step 2: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/match/
git commit -m "Add POST /api/drafts/[id]/match route for match result reporting"
```

### Task 17: API Route — PUT /api/drafts/[id]/seat-settings

**Files:**
- Create: `src/app/api/drafts/[id]/seat-settings/route.ts`
- Create: `src/app/api/drafts/[id]/seat-settings/route.test.ts`

- [ ] **Step 1: Write tests and implementation**

Authenticated route for updating seat-level settings (auto-pick toggle, display name).

Body: `{ auto_pick?: boolean, display_name?: string }`

Calls `updateAutoPick()` and/or `updateDisplayName()` from the seatTokens query module.

- [ ] **Step 2: Run tests, commit**

```bash
git add src/app/api/drafts/[id]/seat-settings/
git commit -m "Add PUT /api/drafts/[id]/seat-settings for auto-pick and display name"
```

## Chunk 3: Frontend — Draft Board Modal

### Task 18: Draft Board Data Hook and Status Polling Hook

**Files:**
- Create: `src/app/hooks/useLiveDraftStatus.ts`
- Create: `src/app/hooks/useLiveDraftStatus.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases:
- Polls `/api/drafts/[id]/status` at 3s intervals when draft is in `drafting` phase
- Polls at 15s intervals during `playing` phase
- Does not poll when phase is `complete` or `setup`
- Updates `latestPickN` and `nextSeat` on response
- Sets `dataChanged` flag when `latestPickN` increases

- [ ] **Step 2: Write implementation**

Two hooks in one file. `useLiveDraftStatus` polls the status endpoint. `useDraftBoard` fetches full board data from `GET /api/drafts/[id]/board` when `dataChanged` fires (or on manual refresh). Follow the pattern from `src/app/hooks/useSyncStatus.ts`. Returns:

```typescript
interface LiveDraftStatus {
  phase: string;
  latestPickN: number;
  nextSeat: number | null;
  recentPicks: { pickN: number; seat: number; cardName: string }[];
  seatNames: Record<string, string>;
  numSeats: number;
  picksPerPlayer: number;
  matchCount: number;
  totalMatches: number;
  dataChanged: boolean;
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/app/hooks/useLiveDraftStatus.ts src/app/hooks/useLiveDraftStatus.test.ts
git commit -m "Add useLiveDraftStatus polling hook for live draft updates"
```

### Task 18: Token Persistence Hook

**Files:**
- Create: `src/app/hooks/useSeatToken.ts`
- Create: `src/app/hooks/useSeatToken.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases:
- Extracts token from URL `?token=abc123` on first visit
- Persists token in localStorage keyed by draftId
- Returns stored token on subsequent visits (no URL param)
- Returns null when no token present
- `hasSeatToken` boolean for conditional UI

- [ ] **Step 2: Write implementation**

```typescript
export function useSeatToken(draftId: string | null) {
  // On mount: check URL for ?token= param
  // If found, store in localStorage as `seatToken:${draftId}`
  // Clean the URL (remove token param via replaceState)
  // Return { token, seat (from status response), hasSeatToken }
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/app/hooks/useSeatToken.ts src/app/hooks/useSeatToken.test.ts
git commit -m "Add useSeatToken hook for token extraction and persistence"
```

### Task 19: Draft Board Modal Component

**Files:**
- Create: `src/app/components/draft-board/DraftBoardModal.tsx`
- Create: `src/app/components/draft-board/DraftBoardMatrix.tsx`
- Create: `src/app/components/draft-board/DraftBoardCell.tsx`
- Create: `src/app/components/draft-board/StandingsSection.tsx`
- Create: `src/app/components/draft-board/MatchReporting.tsx`

This is the largest UI task. Break into sub-steps:

- [ ] **Step 1: Create DraftBoardModal shell**

Follow the deck builder modal pattern from `src/app/components/PageClient.tsx` (lines 111-153, 575-580):
- Full-screen modal overlay
- Close on Escape, click outside
- localStorage persistence for open state
- Toggle button in the draft header area

- [ ] **Step 2: Create DraftBoardMatrix**

The core matrix table component:
- Receives picks array and draft config from the board API
- Uses `buildPickMatrix()` from `src/core/snakeDraft.ts` to compute the grid structure
- Renders sticky header row with seat names/colors
- Renders rows with round number, snake arrow (→/←), and pick cells
- Groups round pairs with visual separators
- Labels double-pick rounds with "DOUBLE" marker
- Highlights the authenticated player's column
- Pulsing border on the active pick cell
- Auto-scrolls to current round on open

- [ ] **Step 3: Create DraftBoardCell**

Individual cell component:
- Displays card name
- Shows mana symbol icons from Scryfall color_identity data (use SVG symbols from Scryfall, same approach as existing mana cost rendering in card table)
- Hover tooltip showing card image + oracle text (reuse existing card hover pattern from CardTable)
- Double-pick cells show two stacked names

- [ ] **Step 4: Create StandingsSection**

Below the matrix:
- During `drafting`: shows pick count per seat, whose turn it is
- During `playing`/`complete`: shows match standings table (wins, losses, game win %)
- Sorted by match wins descending, game win % as tiebreaker

- [ ] **Step 5: Create MatchReporting**

Part of StandingsSection, visible only to authenticated players during `playing` phase:
- List of matchups for the player's seat
- Completed: read-only display
- Incomplete: input fields (wins/losses) with save button
- Save calls `POST /api/drafts/[id]/match`

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/draft-board/
git commit -m "Add draft board modal with pick matrix, standings, and match reporting"
```

### Task 20: Wire Draft Board into PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Add draft board modal state**

Follow the deck builder pattern (lines 111-128):
- `draftBoardOpen` state, persisted to localStorage
- Toggle button alongside deck builder button
- Escape key handler
- Body scroll lock when open

- [ ] **Step 2: Render DraftBoardModal**

Pass: draft config, picks data (from board API), live status, seat token info, standings data.

- [ ] **Step 3: Integrate useLiveDraftStatus and useSeatToken hooks**

- Call `useLiveDraftStatus` when an active draft is selected and it's in `drafting` or `playing` phase
- Call `useSeatToken` with the active draft ID
- Use `dataChanged` from the status hook to trigger board data refetch

- [ ] **Step 4: Run precommit, commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Wire draft board modal into main page with live status polling"
```

## Chunk 4: Frontend — Card Table Pick/Queue Integration

### Task 21: Pick Action in Card Table

**Files:**
- Modify: `src/app/components/CardTable.tsx`

- [ ] **Step 1: Add pick button to card rows**

When the user has a seat token and it's their turn (from live draft status):
- Show a "Pick" button (or icon) on available card rows on hover
- Clicking triggers a confirmation step (highlight the row, show "Confirm Pick" button)
- On confirm, call `POST /api/drafts/[id]/pick` with the card name
- Optimistic update: immediately mark the card as picked locally
- On error, roll back the optimistic update and show error message

New props on CardTable:
```typescript
isMyTurn?: boolean;
onPick?: (cardName: string) => Promise<void>;
```

- [ ] **Step 2: Add queue icon to card rows**

When the user has a seat token (not necessarily their turn):
- Show a queue icon on available card rows on hover
- Click to add to queue (icon changes to circled priority number)
- Click the number to remove from queue
- Queue state managed by parent via props

New props:
```typescript
queuedCards?: Map<string, number>; // cardName → priority
onQueueAdd?: (cardName: string) => void;
onQueueRemove?: (cardName: string) => void;
```

- [ ] **Step 3: Run typecheck, lint, tests**

Run: `pnpm precommit`
Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Add pick and queue actions to card table for live drafting"
```

### Task 22: Queue State Management Hook

**Files:**
- Create: `src/app/hooks/usePickQueue.ts`
- Create: `src/app/hooks/usePickQueue.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases:
- `addToQueue(cardName)` → appends to queue, calls PUT API
- `removeFromQueue(cardName)` → removes and renumbers, calls PUT API
- `queue` reflects server state after polling
- Removes cards from queue when they appear in new picks (from status polling)

- [ ] **Step 2: Write implementation**

Hook that manages queue state, syncs with the server via GET/PUT queue API, and reacts to pick updates from the live draft status hook.

```typescript
export function usePickQueue(draftId: string | null, token: string | null) {
  // Fetch queue on mount via GET /api/drafts/[id]/queue
  // Provide addToQueue / removeFromQueue functions
  // PUT to server on change
  // Re-fetch when live draft status shows new picks (cards may have been removed)
  return { queue, addToQueue, removeFromQueue, isLoading };
}
```

- [ ] **Step 3: Run tests, commit**

```bash
git add src/app/hooks/usePickQueue.ts src/app/hooks/usePickQueue.test.ts
git commit -m "Add usePickQueue hook for queue state management and server sync"
```

### Task 23: Wire Pick/Queue into PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Integrate pick and queue hooks**

- Use `usePickQueue` with the active draft and seat token
- Derive `isMyTurn` from live draft status (`nextSeat === mySeat`)
- Pass `onPick`, `queuedCards`, `onQueueAdd`, `onQueueRemove` to CardTable
- Handle optimistic updates for picks (add to local picks, remove from available)

- [ ] **Step 2: Add auto-pick toggle UI**

Small toggle in the draft header area (near the draft board and deck builder buttons):
- "Auto-pick: ON/OFF"
- Calls PUT to update `seat_tokens.auto_pick` on the server

- [ ] **Step 3: Run full precommit suite**

Run: `pnpm precommit`
Expected: All checks pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Integrate pick flow and queue management into main page"
```

## Chunk 5: Integration and Polish

### Task 24: Update CLAUDE.md Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add live draft commands to Key Commands section**

```markdown
# Live draft commands
pnpm draft:create-live --name "Name" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:<id>
pnpm draft:start <name>              # Start drafting
pnpm draft:admin <subcommand>        # Admin tools (undo-pick, edit-pick, regen-token, etc.)
```

- [ ] **Step 2: Add live draft API routes to REST API table**

Add the new routes (status, pick, queue, board, match) to the existing REST API table.

- [ ] **Step 3: Add live draft section describing the feature**

Brief section covering: how to create a live draft, how tokens work, how the pick flow works, the draft board modal.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document live draft CLI commands and API routes"
```

### Task 25: End-to-End Smoke Test

**Files:**
- Create: `e2e/live-draft.spec.ts` (if Playwright e2e tests exist)

- [ ] **Step 1: Write a basic integration test**

The test creates a draft via CLI (or direct DB setup), starts it, makes a few picks via the API, and verifies the board endpoint returns correct data. This validates the full stack: schema → processPick → API → board response.

If Playwright is available, add a browser test that:
1. Opens a draft page with a token URL
2. Verifies the draft board shows the matrix
3. Makes a pick from the card table
4. Verifies the pick appears in the matrix

- [ ] **Step 2: Run e2e tests**

Run: `pnpm test:e2e`
Expected: Pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/
git commit -m "Add live draft e2e smoke test"
```

### Task 26: Final Verification

- [ ] **Step 1: Run full precommit suite**

Run: `pnpm precommit`
Expected: Typecheck, lint, knip (no unused exports), and all tests pass.

- [ ] **Step 2: Manual smoke test**

1. Create a test draft: `pnpm draft:create-live --name "Smoke Test" --date 2026-04-01 --seats 4 --picks-per-player 6 --pool file:test-pool.txt`
2. Start it: `pnpm draft:start smoke-test`
3. Open in browser with seat 1 token
4. Make a pick from the card table
5. Open draft board modal, verify pick appears in matrix
6. Open in a second browser with seat 2 token, verify pick is visible
7. Add cards to queue, verify queue icons
8. Test admin: `pnpm draft:admin undo-pick smoke-test`
9. Verify pick is removed
10. Make all picks, verify phase transitions to `playing`
11. Report a match result, verify standings update

- [ ] **Step 3: Clean up test data**

```bash
pnpm draft:reset smoke-test
```
