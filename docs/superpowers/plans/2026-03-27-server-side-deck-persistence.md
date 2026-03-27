# Server-Side Deck Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move deck builder persistence from localStorage to a unified server-side `decks` table, consolidating WIP deck state and shared snapshots.

**Architecture:** A new `decks` table replaces `shared_decks`, holding both mutable WIP rows (one per seat+draft) and immutable snapshot rows. The client fetches WIP state on mount, debounces saves via PUT, and shared deck viewing becomes a pure in-memory read. localStorage is fully removed from the deck builder path.

**Tech Stack:** Next.js 16 route handlers, Turso/libsql, React hooks, Vitest

**Spec:** `docs/superpowers/specs/2026-03-27-server-side-deck-persistence-design.md`

---

## Chunk 1: Database Layer

### Task 1: Schema Migration — `decks` table

**Files:**
- Modify: `src/core/db/schema.sql:177-185`

- [ ] **Step 1: Add `decks` table and index to schema.sql**

Replace the `shared_decks` CREATE TABLE block (lines 177-185) with:

```sql
-- Unified deck storage: mutable WIP state and immutable shared snapshots.
-- Replaces shared_decks. Both kinds store DeckState JSON.
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wip', 'snapshot')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_wip ON decks(draft_id, seat) WHERE kind = 'wip';

-- Migrate shared_decks → decks (no-op on fresh install where table doesn't exist)
INSERT OR IGNORE INTO decks (id, draft_id, seat, deck_state, kind, created_at, updated_at)
  SELECT deck_id, draft_id, seat, deck_state, 'snapshot', created_at, created_at
  FROM shared_decks;

DROP TABLE IF EXISTS shared_decks;
```

- [ ] **Step 2: Verify migration runs locally**

Run: `pnpm db:migrate`
Expected: `decks` table created, `shared_decks` rows migrated, `shared_decks` dropped. No errors.

- [ ] **Step 3: Commit**

```bash
git add src/core/db/schema.sql
git commit -m "Add decks table replacing shared_decks for unified deck persistence"
```

---

### Task 2: Query Module — `decks.ts`

**Files:**
- Create: `src/core/db/queries/decks.ts`
- Test: `src/core/db/queries/decks.test.ts`
- Delete: `src/core/db/queries/sharedDecks.ts`

- [ ] **Step 1: Write failing tests for all four query functions**

Create `src/core/db/queries/decks.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { getWipDeck, upsertWipDeck, createSnapshot, getSnapshot } from "./decks";

let client: Client;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await client.execute(`
    CREATE TABLE decks (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      deck_state TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('wip', 'snapshot')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX idx_decks_wip ON decks(draft_id, seat) WHERE kind = 'wip'
  `);
});

const sampleDeckState = {
  draftId: "tarkir",
  seat: 1,
  zones: {
    deck: { "mv-0-1": ["Card A"], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
    sideboard: { "mv-0-1": [], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
  },
  basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
};

describe("getWipDeck", () => {
  it("returns null when no WIP exists", async () => {
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).toBeNull();
  });

  it("returns WIP deck state after upsert", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).not.toBeNull();
    expect(result!.draftId).toBe("tarkir");
    expect(result!.seat).toBe(1);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("does not return snapshots", async () => {
    await createSnapshot(client, sampleDeckState);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result).toBeNull();
  });
});

describe("upsertWipDeck", () => {
  it("creates a new WIP row", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE kind = 'wip'",
      args: [],
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].draft_id).toBe("tarkir");
  });

  it("updates existing WIP row on conflict", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const updated = {
      ...sampleDeckState,
      zones: {
        ...sampleDeckState.zones,
        deck: { ...sampleDeckState.zones.deck, "mv-0-1": ["Card B"] },
      },
    };
    await upsertWipDeck(client, "tarkir", 1, updated);
    const result = await getWipDeck(client, "tarkir", 1);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card B"]);
  });

  it("allows separate WIP rows for different seats", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    const seat2 = { ...sampleDeckState, seat: 2 };
    await upsertWipDeck(client, "tarkir", 2, seat2);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE kind = 'wip'",
      args: [],
    });
    expect(result.rows.length).toBe(2);
  });
});

describe("createSnapshot", () => {
  it("creates an immutable snapshot with a generated ID", async () => {
    const { deckId } = await createSnapshot(client, sampleDeckState);
    expect(deckId).toHaveLength(8);
    const result = await client.execute({
      sql: "SELECT * FROM decks WHERE id = ?",
      args: [deckId],
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].kind).toBe("snapshot");
  });

  it("allows multiple snapshots for the same seat+draft", async () => {
    const { deckId: id1 } = await createSnapshot(client, sampleDeckState);
    const { deckId: id2 } = await createSnapshot(client, sampleDeckState);
    expect(id1).not.toBe(id2);
  });
});

describe("getSnapshot", () => {
  it("returns null when snapshot does not exist", async () => {
    const result = await getSnapshot(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns snapshot by ID", async () => {
    const { deckId } = await createSnapshot(client, sampleDeckState);
    const result = await getSnapshot(client, deckId);
    expect(result).not.toBeNull();
    expect(result!.deckId).toBe(deckId);
    expect(result!.deckState.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("does not return WIP rows", async () => {
    await upsertWipDeck(client, "tarkir", 1, sampleDeckState);
    // Get the ID of the WIP row
    const row = await client.execute({
      sql: "SELECT id FROM decks WHERE kind = 'wip'",
      args: [],
    });
    const wipId = row.rows[0].id as string;
    const result = await getSnapshot(client, wipId);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/decks.test.ts`
Expected: FAIL — module `./decks` not found

- [ ] **Step 3: Implement query functions**

Create `src/core/db/queries/decks.ts`:

```typescript
/**
 * Unified deck queries: mutable WIP state and immutable shared snapshots.
 * Replaces sharedDecks.ts.
 */

import type { Client } from "@libsql/client";
import { generateDeckId, migrateDeckState } from "../../deckBuilder";
import type { DeckState } from "../../types";

export interface WipDeckResult {
  draftId: string;
  seat: number;
  deckState: DeckState;
  updatedAt: string;
}

export interface SnapshotResult {
  deckId: string;
  draftId: string;
  seat: number;
  deckState: DeckState;
  createdAt: string;
}

/**
 * Get the WIP deck state for a seat in a draft.
 * Returns null if no WIP exists.
 */
export async function getWipDeck(
  client: Client,
  draftId: string,
  seat: number,
): Promise<WipDeckResult | null> {
  const result = await client.execute({
    sql: `SELECT draft_id, seat, deck_state, updated_at
          FROM decks
          WHERE draft_id = ? AND seat = ? AND kind = 'wip'`,
    args: [draftId, seat],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: migrateDeckState(JSON.parse(row.deck_state as string) as DeckState),
    updatedAt: row.updated_at as string,
  };
}

/**
 * Upsert the WIP deck state for a seat in a draft.
 * Creates if new, updates if exists.
 */
export async function upsertWipDeck(
  client: Client,
  draftId: string,
  seat: number,
  deckState: DeckState,
): Promise<void> {
  const id = generateDeckId();
  await client.execute({
    sql: `INSERT INTO decks (id, draft_id, seat, deck_state, kind, updated_at)
          VALUES (?, ?, ?, ?, 'wip', datetime('now'))
          ON CONFLICT (draft_id, seat) WHERE kind = 'wip'
          DO UPDATE SET deck_state = excluded.deck_state, updated_at = datetime('now')`,
    args: [id, draftId, seat, JSON.stringify(deckState)],
  });
}

/**
 * Create an immutable shared deck snapshot.
 * Returns the generated deck ID.
 */
export async function createSnapshot(
  client: Client,
  deckState: DeckState,
): Promise<{ deckId: string }> {
  const deckId = generateDeckId();
  await client.execute({
    sql: `INSERT INTO decks (id, draft_id, seat, deck_state, kind)
          VALUES (?, ?, ?, ?, 'snapshot')`,
    args: [deckId, deckState.draftId, deckState.seat, JSON.stringify(deckState)],
  });
  return { deckId };
}

/**
 * Retrieve a shared deck snapshot by ID.
 * Returns null if not found.
 */
export async function getSnapshot(
  client: Client,
  deckId: string,
): Promise<SnapshotResult | null> {
  const result = await client.execute({
    sql: `SELECT id, draft_id, seat, deck_state, created_at
          FROM decks
          WHERE id = ? AND kind = 'snapshot'`,
    args: [deckId],
  });

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    deckId: row.id as string,
    draftId: row.draft_id as string,
    seat: row.seat as number,
    deckState: migrateDeckState(JSON.parse(row.deck_state as string) as DeckState),
    createdAt: row.created_at as string,
  };
}
```

Note: The existing `sharedDecks.ts` uses `getClient()` internally. The new module takes `client` as a parameter for testability (matches the pattern in `pickQueue.ts`, `floatedCards.ts`). The route handlers call `getClient()` and pass it in.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/decks.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/decks.ts src/core/db/queries/decks.test.ts
git commit -m "Add unified decks query module for WIP and snapshot decks"
```

Note: `sharedDecks.ts` is NOT deleted yet — the snapshot routes still import it. It will be deleted in Task 5 after those routes are updated.

---

### Task 3: Extend `validateDeckState` for `speculativeCards`

**Files:**
- Modify: `src/core/validateDeckState.ts:59-75`

- [ ] **Step 1: Add `speculativeCards` validation after `basicLands` check**

After the `basicLands` block (after line 73), add:

```typescript
  if (deck.speculativeCards !== undefined) {
    if (!Array.isArray(deck.speculativeCards) || !deck.speculativeCards.every((v: unknown) => typeof v === "string")) {
      return { valid: false, reason: "speculativeCards must be a string array" };
    }
  }
```

- [ ] **Step 2: Run existing tests**

Run: `pnpm test src/core/validateDeckState`
Expected: PASS (no existing tests break)

- [ ] **Step 3: Commit**

```bash
git add src/core/validateDeckState.ts
git commit -m "Validate speculativeCards field in deck state"
```

---

## Chunk 2: API Routes

### Task 4: WIP Deck State Endpoint — `GET` and `PUT`

**Files:**
- Create: `src/app/api/drafts/[id]/deck-state/route.ts`

- [ ] **Step 1: Create the route handler**

Create `src/app/api/drafts/[id]/deck-state/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getWipDeck, upsertWipDeck } from "@/core/db/queries/decks";
import { validateDeckState } from "@/core/validateDeckState";
import { AppError } from "@/core/errors";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const result = await getWipDeck(client, draftId, seat);

    if (!result) {
      return NextResponse.json({ error: "No deck state found" }, { status: 404 });
    }

    return NextResponse.json(result.deckState);
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/deck-state] GET Error:", error);
    return NextResponse.json({ error: "Failed to load deck state" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    let deckState;
    try {
      deckState = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateDeckState(deckState);
    if (!validation.valid) {
      return NextResponse.json({ error: "Invalid deck state" }, { status: 400 });
    }

    await upsertWipDeck(client, draftId, seat, deckState);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/deck-state] PUT Error:", error);
    return NextResponse.json({ error: "Failed to save deck state" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify the route builds**

Run: `pnpm typecheck`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add src/app/api/drafts/[id]/deck-state/route.ts
git commit -m "Add GET/PUT endpoints for WIP deck state with seat token auth"
```

---

### Task 5: Update Snapshot Routes to Use `decks` Table

**Files:**
- Modify: `src/app/api/deck/route.ts`
- Modify: `src/app/api/deck/[id]/route.ts`

- [ ] **Step 1: Update `POST /api/deck` to use `createSnapshot`**

In `src/app/api/deck/route.ts`, replace the import and function call:

```typescript
// Old:
import { createSharedDeck } from "@/core/db/queries/sharedDecks";
// ...
const { deckId } = await createSharedDeck(deckState);

// New:
import { getClient } from "@/core/db/client";
import { createSnapshot } from "@/core/db/queries/decks";
// ...
const client = await getClient();
const { deckId } = await createSnapshot(client, deckState);
```

- [ ] **Step 2: Update `GET /api/deck/[id]` to use `getSnapshot`**

In `src/app/api/deck/[id]/route.ts`, replace the import and function call:

```typescript
// Old:
import { getSharedDeck } from "@/core/db/queries/sharedDecks";
// ...
const result = await getSharedDeck(id);

// New:
import { getClient } from "@/core/db/client";
import { getSnapshot } from "@/core/db/queries/decks";
// ...
const client = await getClient();
const result = await getSnapshot(client, id);
```

- [ ] **Step 3: Delete `sharedDecks.ts`**

Now that no files import from it, delete `src/core/db/queries/sharedDecks.ts`.

- [ ] **Step 4: Verify no remaining imports of `sharedDecks`**

Run: `pnpm typecheck`
Expected: No type errors. If any file still imports from `sharedDecks`, the build will fail — fix any remaining references.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: PASS (some existing tests may need the import path updated — fix any that fail)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/deck/route.ts src/app/api/deck/\[id\]/route.ts
git rm src/core/db/queries/sharedDecks.ts
git commit -m "Update snapshot routes to use unified decks query module, delete sharedDecks"
```

---

## Chunk 3: Client-Side Hooks

### Task 6: Rewrite `useDeckBuilder` — Replace localStorage with API

**Files:**
- Modify: `src/app/hooks/useDeckBuilder.ts`
- Rewrite: `src/app/hooks/useDeckBuilder.test.ts`

- [ ] **Step 1: Write failing tests for the new API-based hook**

Rewrite `src/app/hooks/useDeckBuilder.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDeckBuilder } from "./useDeckBuilder";
import type { DeckState, ScryCard } from "@/core/types";

// Mock global fetch
const mockFetch = vi.fn() as Mock;
global.fetch = mockFetch;

const scryfallData = new Map<string, ScryCard>([
  ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
  ["Card B", { manaValue: 3, typeLine: "Instant" } as ScryCard],
]);

const savedState: DeckState = {
  draftId: "tarkir",
  seat: 1,
  zones: {
    deck: { "mv-0-1": ["Card A"], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
    sideboard: { "mv-0-1": [], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
  },
  basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
};

describe("useDeckBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("initializes with empty state before API fetch resolves", () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    expect(result.current.state.draftId).toBe("tarkir");
    expect(result.current.ready).toBe(false);
  });

  it("hydrates from API on mount and sets ready", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.state.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("sets ready=true on 404 (no saved WIP)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    // State remains empty
    expect(Object.values(result.current.state.zones.deck).flat()).toHaveLength(0);
  });

  it("does not fetch when token is null", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: null }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it("debounces saves to PUT endpoint", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 }) // initial GET
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); // PUTs

    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // Dispatch an action
    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        picks: ["Card A"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
    });

    // No PUT yet (debounce not elapsed)
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the GET

    // Advance past debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    // Now the PUT should have fired
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const putCall = mockFetch.mock.calls[1];
    expect(putCall[0]).toContain("/deck-state");
    expect(putCall[1].method).toBe("PUT");

    vi.useRealTimers();
  });

  it("does not save when state has not changed", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });

    renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // No actions dispatched, advance past debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // Only the initial GET, no PUT
    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not touch localStorage", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });
    renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => {});
    expect(localStorage.getItem("deckState:tarkir:1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useDeckBuilder.test.ts`
Expected: FAIL — tests reference new `token` prop and `ready` flag that don't exist yet

- [ ] **Step 3: Rewrite `useDeckBuilder` hook**

Replace `src/app/hooks/useDeckBuilder.ts` with:

```typescript
import { useReducer, useEffect, useRef, useCallback, useState } from "react";
import {
  deckReducer,
  createEmptyDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

interface UseDeckBuilderProps {
  draftId: string;
  seat: number;
  token: string | null;
}

const DEBOUNCE_MS = 1000;

export function useDeckBuilder({ draftId, seat, token }: UseDeckBuilderProps) {
  const [state, dispatch] = useReducer(
    deckReducer,
    { draftId, seat },
    ({ draftId, seat }) => createEmptyDeckState(draftId, seat),
  );

  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  // Track whether state has been modified since last save
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const prevKeyRef = useRef(`${draftId}:${seat}`);

  // Fetch WIP deck state from server on mount
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    async function fetchDeckState() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/deck-state`, {
          headers: { "X-Seat-Token": token! },
        });
        if (cancelled) return;
        if (res.ok) {
          const deckState = await res.json();
          dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });
        }
        // 404 = no saved WIP, start fresh (empty state is already set)
      } catch (err) {
        if (!cancelled) console.error("Failed to fetch deck state:", err);
      } finally {
        if (!cancelled) {
          setReady(true);
          dirtyRef.current = false;
        }
      }
    }

    setReady(false);
    fetchDeckState();
    return () => { cancelled = true; };
  }, [draftId, seat, token]);

  // Reset when draft/seat changes
  useEffect(() => {
    const newKey = `${draftId}:${seat}`;
    if (newKey !== prevKeyRef.current) {
      prevKeyRef.current = newKey;
      // The fetch effect above will re-run due to dependency change
    }
  }, [draftId, seat]);

  // Debounced save to server
  const flushSave = useCallback(async () => {
    if (!token || !dirtyRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setSaveStatus("saving");
    try {
      const res = await fetch(`/api/drafts/${state.draftId}/deck-state`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": token,
        },
        body: JSON.stringify(state),
      });
      if (res.ok) {
        dirtyRef.current = false;
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus((s) => s === "saved" ? "idle" : s), 2000);
      }
      // On failure, keep dirty — next debounce cycle will retry
    } catch {
      // Network error — keep dirty for retry
    } finally {
      inFlightRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        flushSave();
      }
    }
  }, [state, token]);

  // Mark dirty and schedule save on state changes (skip initial hydration)
  useEffect(() => {
    if (!ready) return;
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (inFlightRef.current) {
      pendingSaveRef.current = true;
    } else {
      saveTimerRef.current = setTimeout(flushSave, DEBOUNCE_MS);
    }
  }, [state, ready, flushSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && token) {
        // Best-effort synchronous save via sendBeacon (uses query param for auth
        // because sendBeacon doesn't support custom headers)
        const url = `/api/drafts/${draftId}/deck-state?token=${token}`;
        navigator.sendBeacon(url, new Blob(
          [JSON.stringify(state)],
          { type: "application/json" },
        ));
      }
    };
  }, [draftId, token, state]);

  return { state, dispatch, ready, saveStatus } as const;
}

export type { DeckAction };
```

**Important notes for the implementer:**
- The `token` prop is new — `PageClient.tsx` will need to pass `seatToken.token` (Task 8).
- `ready` is exposed for `useDeckBuilderSync` to gate on (Task 7).
- `saveStatus` is exposed for the toolbar indicator (Task 9).
- `loadSnapshot` is removed — shared deck viewing dispatches `INIT_FROM_SNAPSHOT` directly via `dispatch`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/hooks/useDeckBuilder.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useDeckBuilder.ts src/app/hooks/useDeckBuilder.test.ts
git commit -m "Replace localStorage with API persistence in useDeckBuilder"
```

---

### Task 7: Update `useDeckBuilderSync` — Gate on `ready` Flag

**Files:**
- Modify: `src/app/hooks/useDeckBuilderSync.ts`
- Create: `src/app/hooks/useDeckBuilderSync.test.ts` (no existing test file)

- [ ] **Step 1: Add `ready` prop and gate initialization**

In `src/app/hooks/useDeckBuilderSync.ts`, add `ready: boolean` to the props interface and update the initialization effect:

```typescript
interface UseDeckBuilderSyncProps {
  deckBuilderActive: boolean;
  seatCardList: string[] | undefined;
  deckBuilderState: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallDataMap: Map<string, ScryCard>;
  activeDraft: string | null;
  selectedSeat: number | null;
  ready: boolean;  // NEW: from useDeckBuilder, true after API fetch resolves
}
```

Update the initialization effect's guard (line 36):

```typescript
// Old:
if (deckBuilderActive && seatCardList && seatCardList.length > 0 && !deckBuilderInitialized.current) {

// New:
if (deckBuilderActive && ready && seatCardList && seatCardList.length > 0 && !deckBuilderInitialized.current) {
```

Add `ready` to the effect's dependency array (line 53):

```typescript
// Old:
}, [deckBuilderActive, seatCardList]);

// New:
}, [deckBuilderActive, seatCardList, ready]);
```

- [ ] **Step 2: Create test file for `useDeckBuilderSync`**

Create `src/app/hooks/useDeckBuilderSync.test.ts` (no existing test file):

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDeckBuilderSync } from "./useDeckBuilderSync";
import { createEmptyDeckState } from "@/core/deckBuilder";
import type { ScryCard } from "@/core/types";

const scryfallDataMap = new Map<string, ScryCard>([
  ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
]);

const emptyState = createEmptyDeckState("tarkir", 1);

it("does not initialize from picks when ready is false", () => {
  const dispatch = vi.fn();
  renderHook(() =>
    useDeckBuilderSync({
      deckBuilderActive: true,
      seatCardList: ["Card A"],
      deckBuilderState: emptyState,
      dispatch,
      scryfallDataMap,
      activeDraft: "tarkir",
      selectedSeat: 1,
      ready: false,
    }),
  );
  expect(dispatch).not.toHaveBeenCalled();
});

it("initializes from picks when ready is true and zones are empty", () => {
  const dispatch = vi.fn();
  renderHook(() =>
    useDeckBuilderSync({
      deckBuilderActive: true,
      seatCardList: ["Card A"],
      deckBuilderState: emptyState,
      dispatch,
      scryfallDataMap,
      activeDraft: "tarkir",
      selectedSeat: 1,
      ready: true,
    }),
  );
  // First call: INIT_FROM_PICKS, second call: SYNC_PICKS
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "INIT_FROM_PICKS" }),
  );
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm test src/app/hooks/useDeckBuilderSync.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/hooks/useDeckBuilderSync.ts src/app/hooks/useDeckBuilderSync.test.ts
git commit -m "Gate deck builder sync initialization on API fetch readiness"
```

---

### Task 8: Update `useSharedDeckLoader` — Remove `loadSnapshot`

**Files:**
- Modify: `src/app/hooks/useSharedDeckLoader.ts`

- [ ] **Step 1: Replace `loadSnapshot` with `dispatch`**

Update the props interface and implementation:

```typescript
import type { DeckAction } from "@/core/deckBuilder";

interface UseSharedDeckLoaderProps {
  setActiveDraft: (draftId: string) => void;
  setSelectedSeat: (seat: number) => void;
  dispatch: (action: DeckAction) => void;  // replaces loadSnapshot
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}
```

In the effect body, replace `loadSnapshot(deckState)` with:

```typescript
dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });
```

- [ ] **Step 2: Verify types pass**

Run: `pnpm typecheck`
Expected: Type error in `PageClient.tsx` where `loadSnapshot` is still passed — that's expected, will be fixed in Task 9.

- [ ] **Step 3: Commit**

```bash
git add src/app/hooks/useSharedDeckLoader.ts
git commit -m "Replace loadSnapshot with direct dispatch in shared deck loader"
```

---

## Chunk 4: Integration and UI

### Task 9: Wire Up `PageClient.tsx`

**Files:**
- Modify: `src/app/components/PageClient.tsx`

This task connects all the hook changes.

- [ ] **Step 1: Update `useDeckBuilder` call to pass `token`**

```typescript
// Old (line ~152):
const deckBuilder = useDeckBuilder({
  draftId: draftSelection.activeDraft ?? "",
  seat: draftSelection.selectedSeat ?? 0,
});

// New:
const deckBuilder = useDeckBuilder({
  draftId: draftSelection.activeDraft ?? "",
  seat: draftSelection.selectedSeat ?? 0,
  token: seatToken.token,
});
```

- [ ] **Step 2: Update `useSharedDeckLoader` call — replace `loadSnapshot` with `dispatch`**

```typescript
// Old (lines ~259-265):
useSharedDeckLoader({
  setActiveDraft: draftSelection.setActiveDraft,
  setSelectedSeat: draftSelection.setSelectedSeat,
  loadSnapshot: deckBuilder.loadSnapshot,
  setDeckBuilderActive,
  setDeckBuilderModalOpen,
});

// New:
useSharedDeckLoader({
  setActiveDraft: draftSelection.setActiveDraft,
  setSelectedSeat: draftSelection.setSelectedSeat,
  dispatch: deckBuilder.dispatch,
  setDeckBuilderActive,
  setDeckBuilderModalOpen,
});
```

- [ ] **Step 3: Update `useDeckBuilderSync` call — pass `ready`**

```typescript
// Old (lines ~267-275):
useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  deckBuilderState: deckBuilder.state,
  dispatch: deckBuilder.dispatch,
  scryfallDataMap,
  activeDraft: draftSelection.activeDraft,
  selectedSeat: draftSelection.selectedSeat,
});

// New:
useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  deckBuilderState: deckBuilder.state,
  dispatch: deckBuilder.dispatch,
  scryfallDataMap,
  activeDraft: draftSelection.activeDraft,
  selectedSeat: draftSelection.selectedSeat,
  ready: deckBuilder.ready,
});
```

- [ ] **Step 4: Remove `localStorage.removeItem` for deck state**

In `PageClient.tsx` around line 248, there's a `localStorage.removeItem` call for clearing stale deck state on draft reset. Remove the entire effect block (lines ~240-250) — with server-side persistence, localStorage is no longer used for deck state, so this cleanup is a no-op.

- [ ] **Step 5: Pass `saveStatus` to `DeckBuilderPanel`**

Find where `DeckBuilderPanel` is rendered in `PageClient.tsx` and add `saveStatus={deckBuilder.saveStatus}` to the props.

- [ ] **Step 6: Verify types pass**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Wire up API-based deck persistence in PageClient"
```

---

### Task 10: Save Indicator in `DeckBuilderPanel`

**Files:**
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx`

- [ ] **Step 1: Add `saveStatus` to props**

```typescript
interface DeckBuilderPanelProps {
  state: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallData: Map<string, ScryCard>;
  cardStats: Map<string, CardStats>;
  draftName: string;
  onClose: () => void;
  floatedCards?: string[];
  onRemoveFloat?: (cardName: string) => void;
  saveStatus: "idle" | "saving" | "saved";  // NEW
}
```

- [ ] **Step 2: Add indicator to toolbar**

In the toolbar `<div>` (line ~223, the right-side button group), add before the "Add Basic Lands" button:

```tsx
{saveStatus === "saving" && (
  <span className="flex items-center gap-1.5 text-xs text-zinc-500">
    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-400" />
    Saving
  </span>
)}
{saveStatus === "saved" && (
  <span className="flex items-center gap-1.5 text-xs text-emerald-400/80">
    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
    Saved
  </span>
)}
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "Add save status indicator to deck builder toolbar"
```

---

### Task 11: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run linter**

Run: `pnpm lint`
Expected: No errors

- [ ] **Step 4: Run dead code detection**

Run: `pnpm knip`
Expected: No unexpected unused exports. `sharedDecks.ts` should be gone. `loadSnapshot` should not appear anywhere.

- [ ] **Step 5: Verify no localStorage references remain in deck builder path**

Search for `localStorage` in the deck builder hooks and PageClient — should return zero results:

```bash
grep -r "localStorage" src/app/hooks/useDeckBuilder.ts src/app/hooks/useSharedDeckLoader.ts src/app/components/PageClient.tsx
```
Expected: No matches

- [ ] **Step 6: Run precommit checks**

Run: `pnpm precommit`
Expected: All checks pass (typecheck → lint → knip → tests → e2e)

- [ ] **Step 7: Commit any final fixes if needed**

Stage only the specific files that were changed, then commit:

```bash
git commit -m "Final cleanup for server-side deck persistence"
```
