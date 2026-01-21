# Active Draft Filtering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow drafters to filter out taken cards during an active rotisserie draft, with automatic data freshness via Vercel cron + client polling.

**Architecture:** Server-side cron job syncs Google Sheets and incrementally ingests new picks into Turso. Client polls for freshness, refetches card data when changes are detected, and filters/dims taken cards in the table. All new sync infrastructure lives in a shared module callable from both API routes and CLI scripts.

**Tech Stack:** Next.js (App Router), Turso/libSQL, Vercel Pro (cron jobs), Google Sheets API, Vitest, React (TanStack Table)

**Spec:** `docs/superpowers/specs/2026-03-19-active-draft-filtering-design.md`

---

## Chunk 1: Schema & Ingestion Foundation

### Task 1: Schema Migration — Add `sheet_id` and Seed `ingestion_meta` Rows

**Files:**
- Modify: `src/core/db/schema.sql:35-43`
- Modify: `src/core/db/migrate.ts`

- [ ] **Step 1: Add `sheet_id` column to schema.sql**

In `src/core/db/schema.sql`, add `sheet_id TEXT` to the `drafts` table definition (after `is_complete`):

```sql
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  draft_name TEXT NOT NULL,
  draft_date TEXT NOT NULL,
  cube_snapshot_id INTEGER NOT NULL REFERENCES cube_snapshots(cube_snapshot_id),
  import_hash TEXT NOT NULL,
  num_seats INTEGER NOT NULL DEFAULT 10,
  is_complete INTEGER NOT NULL DEFAULT 1,
  sheet_id TEXT
);
```

- [ ] **Step 2: Add migration statements to schema.sql**

`migrate.ts` reads `schema.sql`, splits on semicolons, and executes each statement (it skips "duplicate column" errors for ALTER TABLE). Add these statements to the end of `src/core/db/schema.sql`, following the existing pattern (e.g., the `ALTER TABLE drafts ADD COLUMN is_complete` on line 47):

```sql
-- Add sheet_id for serverless sync (active draft filtering)
ALTER TABLE drafts ADD COLUMN sheet_id TEXT;
INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('sync_lock', '');
INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('last_synced_at', '0');
```

- [ ] **Step 3: Run migration locally**

Run: `pnpm db:migrate`
Expected: Migration completes without errors.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/schema.sql src/core/db/migrate.ts
git commit -m "Add sheet_id column to drafts and seed sync metadata rows"
```

---

### Task 2: Update `createDraft()` to Accept and Store `sheet_id`

**Files:**
- Modify: `src/core/db/ingest.ts:451-466` (createDraft function)
- Modify: `src/core/db/ingest.ts:749-758` (call site in processDraftInner)
- Test: `src/core/db/__tests__/ingest-sheet-id.test.ts`

- [ ] **Step 1: Write test that verifies sheet_id is stored**

Create `src/core/db/__tests__/ingest-sheet-id.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

/**
 * Integration test: verify that after ingesting a draft with a metadata.json
 * containing sheetId, the drafts table row has the sheet_id column populated.
 *
 * This test calls the ingest pipeline on a test fixture and checks the DB.
 * Since ingest.ts functions are not exported, we test via the CLI entry point
 * or by directly importing if we refactor exports.
 *
 * For now, test the createDraft SQL change by verifying the function signature
 * and behavior through a lightweight integration approach.
 */

// This will be filled in after we see the exact testing patterns used in the project.
// Placeholder structure:
describe("createDraft with sheet_id", () => {
  it("stores sheet_id when provided in metadata", () => {
    // Will verify the drafts row has sheet_id after createDraft()
    expect(true).toBe(true); // placeholder
  });

  it("stores null sheet_id when metadata has no sheetId", () => {
    expect(true).toBe(true); // placeholder
  });
});
```

Note to implementer: Check `src/core/db/__tests__/` or `src/core/__tests__/` for existing test patterns against Turso. If no DB test patterns exist, write a unit test that verifies the SQL string includes `sheet_id` in the column list, or test via a mock client.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- src/core/db/__tests__/ingest-sheet-id.test.ts`
Expected: Tests pass (placeholders) — update with real assertions once test pattern is established.

- [ ] **Step 3: Modify `createDraft()` in ingest.ts**

At `src/core/db/ingest.ts:451`, update the function signature and INSERT:

```typescript
async function createDraft(
  client: Client,
  draftId: string,
  draftName: string,
  draftDate: string,
  cubeSnapshotId: number,
  importHash: string,
  numSeats: number,
  isComplete: boolean,
  sheetId: string | null
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, import_hash, num_seats, is_complete, sheet_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draftId, draftName, draftDate, cubeSnapshotId, importHash, numSeats, isComplete ? 1 : 0, sheetId],
  });
}
```

- [ ] **Step 4: Update the call site in `processDraftInner()`**

At `src/core/db/ingest.ts:749-758`, pass `metadata.sheetId ?? null` as the new parameter:

```typescript
  await createDraft(
    client,
    draftId,
    metadata.name,
    metadata.date,
    cubeSnapshotId,
    importHash,
    numSeats,
    isComplete,
    metadata.sheetId ?? null
  );
```

Note: The `DraftMetadata` type at line 38-43 already includes `sheetId?: string`. No type change needed.

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/db/ingest.ts src/core/db/__tests__/ingest-sheet-id.test.ts
git commit -m "Store sheet_id from metadata.json in drafts table"
```

---

### Task 3: Shared Sync Module — Core Functions

**Files:**
- Create: `src/core/sync.ts`
- Test: `src/core/__tests__/sync.test.ts`

This module contains the shared logic for incremental pick ingestion, callable from both API routes (in-memory CSV strings) and CLI (file-read CSV strings).

- [ ] **Step 1: Write tests for incremental pick detection**

Create `src/core/__tests__/sync.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { detectNewPicks, detectDivergence } from "../sync";
import type { CardPick } from "../types";

// Helper to create a CardPick with required fields
function pick(name: string, position: number, seat: number): CardPick {
  return {
    cardName: name,
    pickPosition: position,
    seat,
    copyNumber: 1,
    wasPicked: true,
    draftId: "test-draft",
    color: "",
  };
}

describe("detectNewPicks", () => {
  it("returns only picks with pick_n greater than currentMax", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
    ];
    const result = detectNewPicks(allPicks, 1);
    expect(result).toHaveLength(2);
    expect(result[0].cardName).toBe("Counterspell");
    expect(result[1].cardName).toBe("Swords to Plowshares");
  });

  it("returns all picks when currentMax is 0", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 0);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no new picks", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 5);
    expect(result).toHaveLength(0);
  });
});

describe("detectDivergence", () => {
  it("detects when CSV has fewer picks than database", () => {
    expect(detectDivergence(3, 5)).toBe(true);
  });

  it("no divergence when CSV has more picks", () => {
    expect(detectDivergence(5, 3)).toBe(false);
  });

  it("no divergence when counts are equal", () => {
    expect(detectDivergence(3, 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- src/core/__tests__/sync.test.ts`
Expected: FAIL — `detectNewPicks` and `detectDivergence` not found.

- [ ] **Step 3: Implement `src/core/sync.ts`**

```typescript
/**
 * Shared sync module for incremental pick ingestion.
 * Used by both API routes (serverless) and CLI scripts.
 */

import type { CardPick } from "./types";

/**
 * Given all picks parsed from CSV and the current max pick_n in the database,
 * return only the new picks that need to be inserted.
 */
export function detectNewPicks(allPicks: CardPick[], dbMaxPickN: number): CardPick[] {
  return allPicks.filter((pick) => pick.pickPosition > dbMaxPickN);
}

/**
 * Detect whether the CSV data has diverged from the database in a way
 * that requires a full reimport (only possible via CLI).
 *
 * Returns true if csvMaxPick < dbMaxPick (picks were removed/renumbered).
 */
export function detectDivergence(csvMaxPick: number, dbMaxPick: number): boolean {
  return csvMaxPick < dbMaxPick;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- src/core/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/sync.ts src/core/__tests__/sync.test.ts
git commit -m "Add shared sync module with incremental pick detection"
```

---

### Task 4: Incremental Ingestion in Sync Module — Database Operations

**Files:**
- Modify: `src/core/sync.ts`
- Test: `src/core/__tests__/sync.test.ts`

Add the database-interacting functions for the serverless incremental path: querying current pick state, inserting new picks, resolving card names via the `cards` table, and updating draft completion status.

- [ ] **Step 1: Write tests for `resolveCardNameToId`**

Add to `src/core/__tests__/sync.test.ts`:

```typescript
import { resolveCardNameToId } from "../sync";

describe("resolveCardNameToId", () => {
  it("returns card_id for a known card name", async () => {
    // This test needs a mock or real Turso client.
    // Pattern depends on existing test infrastructure — see Task 2 note.
    // At minimum, test that the SQL query is correct.
  });
});
```

Note to implementer: If the project has no DB test infrastructure, these functions can be tested via integration tests that run against a local SQLite database, or tested indirectly through the API route tests in Chunk 3.

- [ ] **Step 2: Implement database operations in sync.ts**

Add to `src/core/sync.ts`:

```typescript
import type { Client } from "@libsql/client";
import { normalizeCardName, parseDraftPicks, isDraftComplete } from "./parseCsv";

/**
 * Get the current max pick_n for a draft from the database.
 * Returns 0 if no picks exist.
 */
export async function getDbMaxPickN(client: Client, draftId: string): Promise<number> {
  const result = await client.execute({
    sql: "SELECT MAX(pick_n) as max_pick FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  return (result.rows[0]?.max_pick as number) ?? 0;
}

/**
 * Resolve a card name to its card_id in the cards table.
 * Returns null if not found (card wasn't in the initial full import).
 */
export async function resolveCardNameToId(
  client: Client,
  cardName: string
): Promise<number | null> {
  const normalized = normalizeCardName(cardName);
  const result = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) = LOWER(?)",
    args: [normalized],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].card_id as number;
}

/**
 * Insert new picks into pick_events for an active draft.
 * Resolves card names via the cards table (must already exist from initial import).
 * Returns the number of picks inserted.
 */
export async function insertNewPicks(
  client: Client,
  draftId: string,
  newPicks: CardPick[]
): Promise<number> {
  let insertedCount = 0;

  for (const pick of newPicks) {
    const cardId = await resolveCardNameToId(client, pick.cardName);
    if (cardId === null) {
      console.warn(
        `[sync] Warning: Card "${pick.cardName}" not found in cards table for draft ${draftId}, skipping pick ${pick.pickPosition}`
      );
      continue;
    }

    // pick.seat is 0-indexed from parseDraftPicks, convert to 1-indexed
    const seat = pick.seat + 1;
    await client.execute({
      sql: "INSERT OR IGNORE INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
      args: [draftId, pick.pickPosition, seat, cardId],
    });
    insertedCount++;
  }

  return insertedCount;
}

/**
 * Mark a draft as complete in the database.
 */
export async function markDraftComplete(client: Client, draftId: string): Promise<void> {
  await client.execute({
    sql: "UPDATE drafts SET is_complete = 1 WHERE draft_id = ?",
    args: [draftId],
  });
}

/**
 * Run the incremental ingestion path for a single active draft.
 * Returns a status indicating what happened.
 */
export async function incrementalIngest(
  client: Client,
  draftId: string,
  picksCsv: string
): Promise<{ status: "no_change" | "updated" | "completed" | "diverged"; picksInserted: number }> {
  const { picks } = parseDraftPicks(picksCsv, draftId);
  if (picks.length === 0) {
    return { status: "no_change", picksInserted: 0 };
  }

  const csvMaxPick = Math.max(...picks.map((p) => p.pickPosition));
  const dbMaxPick = await getDbMaxPickN(client, draftId);

  // Check for divergence (picks removed or renumbered)
  if (detectDivergence(csvMaxPick, dbMaxPick)) {
    console.warn(
      `[sync] Divergence detected for draft ${draftId}: CSV max pick ${csvMaxPick} < DB max pick ${dbMaxPick}. Skipping — run pnpm ingest to resolve.`
    );
    return { status: "diverged", picksInserted: 0 };
  }

  // Find and insert new picks
  const newPicks = detectNewPicks(picks, dbMaxPick);
  if (newPicks.length === 0) {
    return { status: "no_change", picksInserted: 0 };
  }

  const insertedCount = await insertNewPicks(client, draftId, newPicks);
  console.log(`[sync] Inserted ${insertedCount} new picks for draft ${draftId}`);

  // Check if draft just completed
  if (isDraftComplete(picksCsv)) {
    await markDraftComplete(client, draftId);
    console.log(`[sync] Draft ${draftId} marked as complete`);
    return { status: "completed", picksInserted: insertedCount };
  }

  return { status: "updated", picksInserted: insertedCount };
}
```

- [ ] **Step 3: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/core/sync.ts src/core/__tests__/sync.test.ts
git commit -m "Add incremental ingestion database operations to sync module"
```

---

### Task 5: Sync Lock & Timestamp Helpers

**Files:**
- Modify: `src/core/sync.ts`
- Test: `src/core/__tests__/sync.test.ts`

- [ ] **Step 1: Implement lock and timestamp functions**

Add to `src/core/sync.ts`:

```typescript
const LOCK_TIMEOUT_SECONDS = 120; // 2 minutes stale-lock timeout
const RATE_LIMIT_SECONDS = 30;

/**
 * Attempt to acquire the sync lock using compare-and-swap.
 * Returns true if lock was acquired, false if another sync is in progress.
 */
export async function acquireSyncLock(client: Client): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = now - LOCK_TIMEOUT_SECONDS;

  const result = await client.execute({
    sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'sync_lock' AND (value = '' OR CAST(value AS INTEGER) < ?)`,
    args: [String(now), threshold],
  });

  return result.rowsAffected > 0;
}

/**
 * Release the sync lock.
 */
export async function releaseSyncLock(client: Client): Promise<void> {
  await client.execute({
    sql: `UPDATE ingestion_meta SET value = '' WHERE key = 'sync_lock'`,
    args: [],
  });
}

/**
 * Update the last_synced_at timestamp.
 */
export async function updateLastSyncedAt(client: Client): Promise<string> {
  const now = String(Math.floor(Date.now() / 1000));
  await client.execute({
    sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'last_synced_at'`,
    args: [now],
  });
  return now;
}

/**
 * Get sync status from ingestion_meta.
 */
export async function getSyncStatus(client: Client): Promise<{
  lastSyncedAt: string;
  syncInProgress: boolean;
}> {
  const result = await client.execute({
    sql: `SELECT key, value FROM ingestion_meta WHERE key IN ('last_synced_at', 'sync_lock')`,
    args: [],
  });

  let lastSyncedAt = "0";
  let syncInProgress = false;
  const now = Math.floor(Date.now() / 1000);

  for (const row of result.rows) {
    if (row.key === "last_synced_at") {
      lastSyncedAt = row.value as string;
    }
    if (row.key === "sync_lock") {
      const lockValue = row.value as string;
      if (lockValue !== "") {
        const lockTime = parseInt(lockValue, 10);
        syncInProgress = now - lockTime < LOCK_TIMEOUT_SECONDS;
      }
    }
  }

  return { lastSyncedAt, syncInProgress };
}

/**
 * Check if a sync was performed recently (for rate limiting POST requests).
 */
export async function isRateLimited(client: Client): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT value FROM ingestion_meta WHERE key = 'last_synced_at'`,
    args: [],
  });
  if (result.rows.length === 0) return false;
  const lastSynced = parseInt(result.rows[0].value as string, 10);
  const now = Math.floor(Date.now() / 1000);
  return now - lastSynced < RATE_LIMIT_SECONDS;
}

/**
 * Get active draft IDs (is_complete = 0) with their sheet_ids.
 */
export async function getActiveDrafts(client: Client): Promise<Array<{ draftId: string; sheetId: string }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, sheet_id FROM drafts WHERE is_complete = 0 AND sheet_id IS NOT NULL`,
    args: [],
  });
  return result.rows.map((row) => ({
    draftId: row.draft_id as string,
    sheetId: row.sheet_id as string,
  }));
}

/**
 * Get all active draft IDs (including those without sheet_id).
 */
export async function getActiveDraftIds(client: Client): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT draft_id FROM drafts WHERE is_complete = 0`,
    args: [],
  });
  return result.rows.map((row) => row.draft_id as string);
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/core/sync.ts src/core/__tests__/sync.test.ts
git commit -m "Add sync lock, rate limiting, and active draft query helpers"
```

---

## Chunk 2: API Routes

### Task 6: `GET /api/sync-status` Route

**Files:**
- Create: `src/app/api/sync-status/route.ts`

This is the simplest route — read-only, no side effects. Good to build first.

- [ ] **Step 1: Create the route**

Create `src/app/api/sync-status/route.ts`:

```typescript
import { NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getSyncStatus, getActiveDraftIds } from "@/core/sync";

export async function GET() {
  try {
    const client = await getClient();
    const [syncStatus, activeDraftIds] = await Promise.all([
      getSyncStatus(client),
      getActiveDraftIds(client),
    ]);

    return NextResponse.json({
      ...syncStatus,
      activeDraftIds,
    });
  } catch (error) {
    console.error("[sync-status] Error:", error);
    return NextResponse.json(
      { error: "Failed to get sync status" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Test manually**

Run: `pnpm dev` (in background)
Then: `curl http://localhost:3000/api/sync-status`
Expected: `{"lastSyncedAt":"0","syncInProgress":false,"activeDraftIds":[...]}`

Kill the dev server when done.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/sync-status/route.ts
git commit -m "Add /api/sync-status endpoint for polling sync freshness"
```

---

### Task 7: `GET` and `POST /api/sync` Route

**Files:**
- Create: `src/app/api/sync/route.ts`

This is the main sync route — fetches sheets, runs incremental ingestion, manages the lock.

- [ ] **Step 1: Create the route**

Create `src/app/api/sync/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getActiveDrafts,
  incrementalIngest,
  isRateLimited,
} from "@/core/sync";
import { fetchDraftFromSheet } from "@/build/sheets";

async function runSync(): Promise<NextResponse> {
  const client = await getClient();

  // Check for active drafts first (cheap query)
  const activeDrafts = await getActiveDrafts(client);
  if (activeDrafts.length === 0) {
    return NextResponse.json({ status: "no_active_drafts" });
  }

  // Try to acquire lock
  const locked = await acquireSyncLock(client);
  if (!locked) {
    return NextResponse.json({ status: "in_progress" });
  }

  try {
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!apiKey) {
      console.error("[sync] GOOGLE_SHEETS_API_KEY not set");
      return NextResponse.json(
        { error: "Server misconfiguration" },
        { status: 500 }
      );
    }

    let totalPicksInserted = 0;

    for (const draft of activeDrafts) {
      try {
        // Fetch CSV data from Google Sheets
        const sheetData = await fetchDraftFromSheet(draft.sheetId, apiKey);

        if (!sheetData.picks) {
          console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
          continue;
        }

        // Run incremental ingestion
        const result = await incrementalIngest(client, draft.draftId, sheetData.picks);
        totalPicksInserted += result.picksInserted;

        if (result.status === "diverged") {
          console.warn(`[sync] Draft ${draft.draftId} has diverged data — run pnpm ingest to fix`);
        }
      } catch (error) {
        console.error(`[sync] Error syncing draft ${draft.draftId}:`, error);
        // Continue with other drafts
      }
    }

    const lastSyncedAt = await updateLastSyncedAt(client);

    return NextResponse.json({
      status: "completed",
      lastSyncedAt,
      picksInserted: totalPicksInserted,
    });
  } finally {
    await releaseSyncLock(client);
  }
}

/**
 * GET /api/sync — Called by Vercel cron job.
 * Requires CRON_SECRET authorization.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await runSync();
  } catch (error) {
    console.error("[sync] Unexpected error:", error);
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sync — Called by "Sync Now" button.
 * Rate-limited to prevent quota exhaustion.
 */
export async function POST() {
  try {
    const client = await getClient();

    // Rate limiting
    if (await isRateLimited(client)) {
      return NextResponse.json(
        { status: "rate_limited" },
        { status: 429 }
      );
    }

    return await runSync();
  } catch (error) {
    console.error("[sync] Unexpected error:", error);
    return NextResponse.json(
      { error: "Sync failed" },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Add `vercel.json` with cron config**

Create `vercel.json` at project root:

```json
{
  "crons": [{ "path": "/api/sync", "schedule": "* * * * *" }]
}
```

- [ ] **Step 3: Ensure `google-spreadsheet` is in `dependencies`**

Check `package.json` — if `google-spreadsheet` is in `devDependencies`, move it to `dependencies`. Vercel only installs `dependencies` for production builds, so the serverless function importing `fetchDraftFromSheet` would fail at runtime without this.

Run: `pnpm install`

- [ ] **Step 4: Test manually (POST path)**

Run: `pnpm dev` (in background)
Then: `curl -X POST http://localhost:3000/api/sync`
Expected: `{"status":"no_active_drafts"}` or `{"status":"completed",...}` depending on whether you have active drafts in your local DB.

Kill the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sync/route.ts vercel.json package.json
git commit -m "Add /api/sync endpoint with cron and manual trigger support"
```

---

### Task 8: Extend `/api/cards` for Active Draft Filtering

**Files:**
- Modify: `src/core/getCards.ts:21-24` (GetCardsParams type)
- Modify: `src/core/getCards.ts:26-34` (CardStatsResponse type)
- Modify: `src/core/getCards.ts:85-443` (getCards function — add takenCardNames query)
- Modify: `src/app/api/cards/route.ts:4-43` (parse activeDraft param, adjust caching)

- [ ] **Step 1: Write test for takenCardNames query**

Create or add to the appropriate test file:

```typescript
import { describe, it, expect } from "vitest";

describe("getCards with activeDraft", () => {
  it("includes takenCardNames when activeDraft is provided", () => {
    // Integration test: call getCards with activeDraft param
    // Verify response includes takenCardNames array
  });

  it("does not include takenCardNames when activeDraft is omitted", () => {
    // Verify backwards compatibility
  });
});
```

- [ ] **Step 2: Update `GetCardsParams` type**

At `src/core/getCards.ts:21-24`, add `activeDraft`:

```typescript
export type GetCardsParams = {
  draftIds?: string[];
  includeMatchData: boolean;
  activeDraft?: string;
};
```

- [ ] **Step 3: Update `CardStatsResponse` type**

At `src/core/getCards.ts:26-34`, add `takenCardNames`:

```typescript
// Add to the existing CardStatsResponse type:
  takenCardNames?: string[];
```

- [ ] **Step 4: Add takenCardNames query to `getCards()`**

Near the end of `getCards()` (before the return statement, around line 430), add:

```typescript
  // Query taken card names for active draft filtering
  let takenCardNames: string[] | undefined;
  if (params.activeDraft) {
    const takenResult = await client.execute({
      sql: `SELECT c.name FROM pick_events pe JOIN cards c ON pe.card_id = c.card_id WHERE pe.draft_id = ?`,
      args: [params.activeDraft],
    });
    takenCardNames = takenResult.rows.map((row) => row.name as string);
  }
```

Include `takenCardNames` in the return object.

- [ ] **Step 5: Update the API route to parse `activeDraft` and adjust caching**

At `src/app/api/cards/route.ts`, update the GET handler:

```typescript
  // Parse activeDraft param
  const activeDraft = searchParams.get("activeDraft") ?? undefined;

  // Pass to getCards
  const data = await getCards({
    draftIds: drafts ? drafts.split(",") : undefined,
    includeMatchData: isLocal,
    activeDraft,
  });

  // Adjust caching: no-store for active draft requests
  const cacheControl = activeDraft
    ? "no-store"
    : "public, s-maxage=31536000, stale-while-revalidate=60";

  return NextResponse.json(data, {
    headers: { "Cache-Control": cacheControl },
  });
```

- [ ] **Step 6: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/getCards.ts src/app/api/cards/route.ts
git commit -m "Extend /api/cards with activeDraft param and takenCardNames response"
```

---

## Chunk 3: Client-Side UI

### Task 9: Sync Status Polling Hook

**Files:**
- Create: `src/app/hooks/useSyncStatus.ts`

A React hook that polls `/api/sync-status` and exposes sync state to components.

- [ ] **Step 1: Create the hook**

Create `src/app/hooks/useSyncStatus.ts`:

```typescript
import { useState, useEffect, useRef, useCallback } from "react";

const POLL_INTERVAL_MS = 10_000; // 10 seconds

type SyncStatusResponse = {
  lastSyncedAt: string;
  syncInProgress: boolean;
  activeDraftIds: string[];
};

type SyncStatus = SyncStatusResponse & {
  /** Trigger a manual sync. Returns when sync completes. */
  triggerSync: () => Promise<void>;
  /** Whether a manual sync is in flight. */
  manualSyncInFlight: boolean;
  /** Whether the last sync timestamp changed since previous poll. */
  dataChanged: boolean;
};

export function useSyncStatus(enabled: boolean): SyncStatus {
  const [status, setStatus] = useState<SyncStatusResponse>({
    lastSyncedAt: "0",
    syncInProgress: false,
    activeDraftIds: [],
  });
  const [manualSyncInFlight, setManualSyncInFlight] = useState(false);
  const [dataChanged, setDataChanged] = useState(false);
  const lastSyncedAtRef = useRef("0");
  const pollPausedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (pollPausedRef.current) return;
    try {
      const res = await fetch("/api/sync-status");
      if (!res.ok) return;
      const data: SyncStatusResponse = await res.json();

      const changed = data.lastSyncedAt !== lastSyncedAtRef.current && lastSyncedAtRef.current !== "0";
      lastSyncedAtRef.current = data.lastSyncedAt;

      setStatus(data);
      setDataChanged(changed);
    } catch {
      // Silently ignore fetch errors during polling
    }
  }, []);

  // Always fetch once on mount (so settings dropdown can discover active drafts)
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll on interval only when enabled (i.e., an active draft is selected)
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, fetchStatus]);

  // Clear dataChanged flag after consumer has had a chance to act on it
  useEffect(() => {
    if (dataChanged) {
      const timeout = setTimeout(() => setDataChanged(false), 100);
      return () => clearTimeout(timeout);
    }
  }, [dataChanged]);

  const triggerSync = useCallback(async () => {
    pollPausedRef.current = true;
    setManualSyncInFlight(true);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data.lastSyncedAt) {
          lastSyncedAtRef.current = data.lastSyncedAt;
        }
      }
      // Refetch status after sync
      pollPausedRef.current = false;
      await fetchStatus();
      setDataChanged(true);
    } finally {
      setManualSyncInFlight(false);
      pollPausedRef.current = false;
    }
  }, [fetchStatus]);

  return {
    ...status,
    triggerSync,
    manualSyncInFlight,
    dataChanged,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/hooks/useSyncStatus.ts
git commit -m "Add useSyncStatus hook for polling sync freshness"
```

---

### Task 10: Active Draft Settings Controls

**Files:**
- Modify: `src/app/components/PageClient.tsx` (add active draft state, pass to settings)
- Modify: The settings panel component (wherever the gear icon opens — find the exact component)

Note to implementer: First, identify the settings panel component by searching for the gear icon. It may be in `PageClient.tsx` or a separate `Settings.tsx` component. Adjust file paths accordingly.

- [ ] **Step 1: Add active draft state to PageClient**

In `src/app/components/PageClient.tsx`, add state:

```typescript
// Active draft state (persisted to localStorage)
const [activeDraft, setActiveDraft] = useState<string | null>(() => {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("activeDraft");
});
const [hideTaken, setHideTaken] = useState<boolean>(() => {
  if (typeof window === "undefined") return true;
  return localStorage.getItem("hideTaken") !== "false";
});

// Persist to localStorage on change
useEffect(() => {
  if (activeDraft) {
    localStorage.setItem("activeDraft", activeDraft);
  } else {
    localStorage.removeItem("activeDraft");
  }
}, [activeDraft]);

useEffect(() => {
  localStorage.setItem("hideTaken", String(hideTaken));
}, [hideTaken]);
```

- [ ] **Step 2: Wire up useSyncStatus hook**

```typescript
const syncStatus = useSyncStatus(activeDraft !== null);

// Clear active draft selection if it completed
useEffect(() => {
  if (activeDraft && !syncStatus.activeDraftIds.includes(activeDraft)) {
    setActiveDraft(null);
  }
}, [activeDraft, syncStatus.activeDraftIds]);

// Refetch card data when sync detects changes
useEffect(() => {
  if (syncStatus.dataChanged && activeDraft) {
    // Trigger the same fetch as handleDraftsChange but with activeDraft param
    // Implementation depends on existing fetch pattern in PageClient
  }
}, [syncStatus.dataChanged, activeDraft]);
```

- [ ] **Step 3: Extend `SettingsProps` and pass new props**

In `src/app/components/Settings.tsx`, extend the `SettingsProps` interface (line 6-11):

```typescript
export interface SettingsProps {
  drafts: Array<{ id: string; name: string; date: string }>;
  selectedDrafts: Set<string>;
  onDraftsChange: (selected: Set<string>) => void;
  isLoading?: boolean;
  // Active draft filtering
  activeDraftIds: string[];
  activeDraft: string | null;
  onActiveDraftChange: (draftId: string | null) => void;
  hideTaken: boolean;
  onHideTakenChange: (hide: boolean) => void;
}
```

Update the function destructuring to include the new props. Then, inside the modal body (after the DraftSelector), add:

```tsx
{/* Active Draft section */}
{activeDraftIds.length > 0 && (
  <div className="mt-4 border-t border-zinc-700 pt-4">
    <label className="text-sm font-medium text-zinc-400">Active Draft</label>
    <select
      value={activeDraft ?? ""}
      onChange={(e) => onActiveDraftChange(e.target.value || null)}
      className="mt-1 block w-full rounded bg-zinc-800 text-zinc-200 border-zinc-700 text-sm p-1.5"
    >
      <option value="">None</option>
      {activeDraftIds.map((id) => (
        <option key={id} value={id}>{id}</option>
      ))}
    </select>

    {activeDraft && (
      <label className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
        <input
          type="checkbox"
          checked={hideTaken}
          onChange={(e) => onHideTakenChange(e.target.checked)}
        />
        Hide taken cards
      </label>
    )}
  </div>
)}
```

- [ ] **Step 4: Update the `<Settings>` call site in PageClient.tsx**

At `src/app/components/PageClient.tsx:236-241`, pass the new props:

```tsx
<Settings
  drafts={drafts}
  selectedDrafts={selectedDrafts}
  onDraftsChange={handleDraftsChange}
  isLoading={isLoading}
  activeDraftIds={syncStatus.activeDraftIds}
  activeDraft={activeDraft}
  onActiveDraftChange={setActiveDraft}
  hideTaken={hideTaken}
  onHideTakenChange={setHideTaken}
/>
```

- [ ] **Step 4: Run dev server and verify settings panel**

Run: `pnpm dev`
Open browser, click gear icon. Verify the active draft dropdown appears (if active drafts exist in DB).

Kill dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/PageClient.tsx
# Add any other modified settings component files
git commit -m "Add active draft selector and hide-taken toggle to settings"
```

---

### Task 11: Status Indicator Component

**Files:**
- Create: `src/app/components/ActiveDraftIndicator.tsx`
- Modify: `src/app/components/PageClient.tsx` (render the indicator)

- [ ] **Step 1: Create the component**

Create `src/app/components/ActiveDraftIndicator.tsx`:

```tsx
type ActiveDraftIndicatorProps = {
  draftName: string;
  availableCount: number;
  lastSyncedAt: string;
  syncInProgress: boolean;
  draftComplete: boolean;
  onSyncNow: () => void;
  syncDisabled: boolean;
};

export function ActiveDraftIndicator({
  draftName,
  availableCount,
  lastSyncedAt,
  syncInProgress,
  draftComplete,
  onSyncNow,
  syncDisabled,
}: ActiveDraftIndicatorProps) {
  const timeAgo = formatTimeAgo(lastSyncedAt);

  if (draftComplete) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 rounded-full bg-zinc-500" />
        <span className="font-medium text-zinc-400">{draftName}</span>
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-500">Draft complete</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`h-2 w-2 rounded-full ${
          syncInProgress ? "bg-amber-400 animate-pulse" : "bg-emerald-400"
        }`}
      />
      <span className="font-medium text-emerald-400">{draftName}</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-400">{availableCount} available</span>
      <span className="text-zinc-600">·</span>
      <span className="text-zinc-500">
        {syncInProgress ? "Syncing…" : `Synced ${timeAgo}`}
      </span>
      <button
        onClick={onSyncNow}
        disabled={syncDisabled || syncInProgress}
        className="ml-1 rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:text-zinc-600"
      >
        Sync Now
      </button>
    </div>
  );
}

function formatTimeAgo(unixSecondsStr: string): string {
  const then = parseInt(unixSecondsStr, 10) * 1000;
  if (isNaN(then) || then === 0) return "never";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
```

- [ ] **Step 2: Render in PageClient**

In `src/app/components/PageClient.tsx`, add the indicator to the search/filter bar area (right-aligned on the same line as search input and color filters):

```tsx
{activeDraft && (
  <ActiveDraftIndicator
    draftName={activeDraft}
    availableCount={availableCount}
    lastSyncedAt={syncStatus.lastSyncedAt}
    syncInProgress={syncStatus.syncInProgress || syncStatus.manualSyncInFlight}
    draftComplete={!syncStatus.activeDraftIds.includes(activeDraft)}
    onSyncNow={syncStatus.triggerSync}
    syncDisabled={syncStatus.manualSyncInFlight}
  />
)}
```

Where `availableCount` is computed from the card data:

```typescript
const availableCount = useMemo(() => {
  if (!activeDraft || !cardData.takenCardNames) return 0;
  const takenSet = new Set(cardData.takenCardNames);
  return cardData.cards.filter((c) => !takenSet.has(c.cardName)).length;
}, [activeDraft, cardData]);
```

- [ ] **Step 3: Run dev server and verify**

Run: `pnpm dev`
Open browser. If you have an active draft, verify the indicator appears on the search bar line.

Kill dev server when done.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/ActiveDraftIndicator.tsx src/app/components/PageClient.tsx
git commit -m "Add active draft status indicator with sync button"
```

---

### Task 12: Taken Card Filtering & Opacity Styling

**Files:**
- Modify: `src/app/components/CardTable.tsx:322-334` (row rendering)
- Modify: `src/app/components/PageClient.tsx` (filter taken cards, pass state to table)

- [ ] **Step 1: Pass taken card state to CardTable**

Add props to CardTable:

```typescript
// Add to CardTable props:
takenCardNames?: Set<string>;
hideTaken?: boolean;
```

- [ ] **Step 2: Filter taken cards in the data pipeline**

In `PageClient.tsx`, filter the card data before passing to CardTable:

```typescript
const displayCards = useMemo(() => {
  if (!activeDraft || !cardData.takenCardNames) return cardData.cards;
  const takenSet = new Set(cardData.takenCardNames);
  if (hideTaken) {
    return cardData.cards.filter((c) => !takenSet.has(c.cardName));
  }
  return cardData.cards;
}, [activeDraft, cardData, hideTaken]);

const takenCardNamesSet = useMemo(() => {
  if (!activeDraft || !cardData.takenCardNames) return undefined;
  return new Set(cardData.takenCardNames);
}, [activeDraft, cardData.takenCardNames]);
```

Pass `takenCardNames={takenCardNamesSet}` and `hideTaken={hideTaken}` to CardTable.

- [ ] **Step 3: Apply opacity to taken card rows**

In `src/app/components/CardTable.tsx`, at the row rendering (around line 322), add opacity styling:

```tsx
<tr
  className="bg-white transition-colors hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800"
  style={{
    opacity: takenCardNames?.has(row.original.cardName) ? 0.35 : 1,
  }}
>
```

Note: `row.original.cardName` should match the field name used in the table data. Check the actual column accessor name in the existing code.

- [ ] **Step 4: Run dev server and verify**

Run: `pnpm dev`
Open browser. Select an active draft. Verify:
1. With "Hide taken" checked: taken cards disappear from table
2. With "Hide taken" unchecked: taken cards show with reduced opacity

Kill dev server when done.

- [ ] **Step 5: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardTable.tsx src/app/components/PageClient.tsx
git commit -m "Filter and dim taken cards in card table during active draft"
```

---

## Chunk 4: Integration & Polish

### Task 13: Wire Up Data Refetching on Sync Changes

**Files:**
- Modify: `src/app/components/PageClient.tsx`

Connect the `useSyncStatus.dataChanged` signal to refetch card data with the `activeDraft` parameter.

- [ ] **Step 1: Extract a reusable fetch function and add activeDraft param**

In `PageClient.tsx`, extract the card-fetching logic from `handleDraftsChange` (lines 68-96) into a reusable function. The key change is appending `&activeDraft=<id>` to the `/api/cards` URL when an active draft is selected:

```typescript
// Add a refetch function that uses the current draft selection and active draft
const fetchCardData = useCallback(
  async (draftSelection: Set<string>, activeDraftId: string | null) => {
    if (draftSelection.size === 0) {
      setCardData((prev) => ({
        ...prev,
        cards: [],
        draftCount: 0,
        cubeCopies: {},
      }));
      return;
    }

    setIsLoading(true);
    try {
      const draftsJoined = [...draftSelection].join(",");
      const params = new URLSearchParams();
      params.set("drafts", draftsJoined);
      params.set("v", cardData.ingestionHash);
      if (isLocal) params.set("local", "1");
      if (activeDraftId) params.set("activeDraft", activeDraftId);

      const statsParams = new URLSearchParams();
      statsParams.set("drafts", draftsJoined);
      statsParams.set("v", cardData.ingestionHash);

      const [cardsRes, statsRes] = await Promise.all([
        fetch(`/api/cards?${params}`),
        fetch(`/api/draft-stats?${statsParams}`),
      ]);

      if (!cardsRes.ok) throw new Error("Cards API request failed");
      const data: CardStatsResponse = await cardsRes.json();
      setCardData(data);

      if (statsRes.ok) {
        const stats: DraftStatsResponse = await statsRes.json();
        setDraftStats(stats);
      }
    } catch (error) {
      console.error("Failed to fetch card data:", error);
    } finally {
      setIsLoading(false);
    }
  },
  [cardData.ingestionHash, isLocal]
);

// Update handleDraftsChange to use the shared function
const handleDraftsChange = useCallback(
  async (newSelection: Set<string>) => {
    setSelectedDrafts(newSelection);
    await fetchCardData(newSelection, activeDraft);
  },
  [fetchCardData, activeDraft]
);

// Refetch when sync detects changes to active draft data
useEffect(() => {
  if (syncStatus.dataChanged && activeDraft) {
    fetchCardData(selectedDrafts, activeDraft);
  }
}, [syncStatus.dataChanged, activeDraft, selectedDrafts, fetchCardData]);

// Also refetch when activeDraft selection changes
useEffect(() => {
  fetchCardData(selectedDrafts, activeDraft);
}, [activeDraft]); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 2: Test the full flow**

Run: `pnpm dev`
1. Open the site
2. Select an active draft in settings
3. Verify the status indicator appears
4. Click "Sync Now" — verify the indicator shows syncing state, then updates
5. Verify taken cards are filtered/dimmed appropriately

Kill dev server when done.

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Wire up data refetching on sync status changes"
```

---

### Task 14: Update `fetchDraftFromSheet` Import Path

**Files:**
- Modify: `src/app/api/sync/route.ts`

The `/api/sync` route imports `fetchDraftFromSheet` from `@/build/sheets`. Verify this import works in the Next.js App Router context. The `src/build/` directory may need to be included in the build or the function may need to be moved/re-exported.

- [ ] **Step 1: Verify the import resolves and `google-spreadsheet` is in `dependencies`**

Check `package.json` — if `google-spreadsheet` is in `devDependencies`, move it to `dependencies`. Vercel only installs `dependencies` for production builds, so the serverless function would fail at runtime without this.

Run: `pnpm build`
Expected: Build succeeds. If the import fails (e.g., `src/build/sheets.ts` has other build-time-only patterns), you may need to extract the `fetchDraftFromSheet` function into a shared location (e.g., `src/core/sheets.ts`).

- [ ] **Step 2: Fix any import issues and rebuild**

Run: `pnpm build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit any fixes**

```bash
git add -u
git commit -m "Fix fetchDraftFromSheet import for serverless API route"
```

---

### Task 15: End-to-End Integration Test

**Files:**
- No new files — manual testing checklist

- [ ] **Step 1: Ensure you have a test draft**

Verify you have at least one draft in `data/` with `is_complete = 0` and a `sheetId` in `metadata.json`. If not, create a test draft or modify an existing draft's metadata.

- [ ] **Step 2: Run full ingest to seed the draft**

Run: `pnpm ingest`
Expected: Draft is ingested with `sheet_id` populated in the database.

- [ ] **Step 3: Start dev server and test the full flow**

Run: `pnpm dev`

Test checklist:
1. Open `http://localhost:3000`
2. Hit `/api/sync-status` — verify `activeDraftIds` includes your test draft
3. Click gear icon — verify active draft dropdown shows the test draft
4. Select the active draft — verify status indicator appears (green dot, draft name, available count, sync time)
5. Verify taken cards are hidden from the table (default: hide taken = checked)
6. Uncheck "Hide taken cards" — verify taken cards appear dimmed (opacity 0.35)
7. Click "Sync Now" — verify amber syncing state, then green when done
8. Hit `POST /api/sync` directly — verify rate limiting returns 429 within 30 seconds
9. Verify the available count updates after a sync

Kill dev server when done.

- [ ] **Step 4: Run all tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -u
git commit -m "Integration test fixes for active draft filtering"
```
