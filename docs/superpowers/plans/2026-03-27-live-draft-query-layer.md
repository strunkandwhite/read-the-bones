# Live Draft Query Layer Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate 11 inline SQL queries in live-draft routes to the shared query layer for consistency and testability.

**Architecture:** Add query functions to existing modules (seatTokens.ts, picks.ts, drafts.ts, cards.ts) and create a new matches.ts module. Then update routes one-by-one.

**Tech Stack:** TypeScript, Turso/libsql, Vitest

---

## Chunk 1: Query Functions

These tasks add new functions to existing query modules. No dependencies between them — all can run in parallel.

### Task 1: Add `getSeatDisplayNames` and `getSeatSettings` to seatTokens.ts

**Inline queries replaced:**
- `status/route.ts` line 46-53: `SELECT seat, display_name FROM seat_tokens WHERE draft_id = ? ORDER BY seat`
- `board/route.ts` line 42-49: identical query
- `seat-settings/route.ts` line 29-33: `SELECT auto_pick, display_name FROM seat_tokens WHERE draft_id = ? AND seat = ?`

**Files:**
- Modify: `src/core/db/queries/seatTokens.ts`
- Modify: `src/core/db/queries/seatTokens.test.ts`

- [ ] **Step 1: Add `getSeatDisplayNames` to seatTokens.ts**

Add after the existing `getSeatTokens` function:

```ts
/**
 * Get seat-to-display-name mapping for a draft.
 * Only includes seats that have a non-null display name.
 */
export async function getSeatDisplayNames(
  client: Client,
  draftId: string,
): Promise<Record<string, string>> {
  const result = await client.execute({
    sql: "SELECT seat, display_name FROM seat_tokens WHERE draft_id = ? ORDER BY seat",
    args: [draftId],
  });
  const names: Record<string, string> = {};
  for (const r of result.rows) {
    if (r.display_name) names[String(r.seat)] = r.display_name as string;
  }
  return names;
}
```

- [ ] **Step 2: Add `getSeatSettings` to seatTokens.ts**

Add after `getSeatDisplayNames`:

```ts
/**
 * Get settings for a specific seat in a draft.
 * Returns null if the seat doesn't exist.
 */
export async function getSeatSettings(
  client: Client,
  draftId: string,
  seat: number,
): Promise<{ autoPick: boolean; displayName: string | null } | null> {
  const result = await client.execute({
    sql: "SELECT auto_pick, display_name FROM seat_tokens WHERE draft_id = ? AND seat = ?",
    args: [draftId, seat],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    autoPick: row.auto_pick === 1,
    displayName: row.display_name as string | null,
  };
}
```

- [ ] **Step 3: Add tests for both functions**

Add to `src/core/db/queries/seatTokens.test.ts`:

```ts
describe("getSeatDisplayNames", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns mapping of seat to display name, skipping nulls", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [
        { seat: 1, display_name: "Alice" },
        { seat: 2, display_name: null },
        { seat: 3, display_name: "Charlie" },
      ],
    });

    const result = await getSeatDisplayNames(mockClient as never, "draft-1");

    expect(result).toEqual({ "1": "Alice", "3": "Charlie" });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT seat, display_name FROM seat_tokens"),
        args: ["draft-1"],
      })
    );
  });

  it("returns empty object when no display names set", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [
        { seat: 1, display_name: null },
        { seat: 2, display_name: null },
      ],
    });

    const result = await getSeatDisplayNames(mockClient as never, "draft-1");

    expect(result).toEqual({});
  });
});

describe("getSeatSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns settings for an existing seat", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [{ auto_pick: 1, display_name: "Bob" }],
    });

    const result = await getSeatSettings(mockClient as never, "draft-1", 2);

    expect(result).toEqual({ autoPick: true, displayName: "Bob" });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT auto_pick, display_name"),
        args: ["draft-1", 2],
      })
    );
  });

  it("returns null when seat not found", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await getSeatSettings(mockClient as never, "draft-1", 99);

    expect(result).toBeNull();
  });

  it("returns autoPick false when auto_pick is 0", async () => {
    const mockClient = createMockClient();
    mockClient.execute.mockResolvedValue({
      rows: [{ auto_pick: 0, display_name: null }],
    });

    const result = await getSeatSettings(mockClient as never, "draft-1", 1);

    expect(result).toEqual({ autoPick: false, displayName: null });
  });
});
```

Update the import at the top of the test file to include the new functions:

```ts
import {
  generateSeatTokens,
  resolveToken,
  getSeatTokens,
  regenerateToken,
  updateDisplayName,
  updateAutoPick,
  getSeatDisplayNames,
  getSeatSettings,
} from "./seatTokens";
```

- [ ] **Step 4: Verify** — Run `pnpm typecheck && pnpm vitest run src/core/db/queries/seatTokens.test.ts`

---

### Task 2: Add `getLatestPickNumber`, `getRecentPicks`, and `getPicksWithCardDetails` to picks.ts

**Inline queries replaced:**
- `status/route.ts` line 22-26: `SELECT COALESCE(MAX(pick_n), 0) as latest FROM pick_events WHERE draft_id = ?`
- `status/route.ts` line 32-38: `SELECT pe.pick_n, pe.seat, c.name as card_name FROM pick_events pe JOIN cards c ... ORDER BY pe.pick_n DESC LIMIT 10`
- `board/route.ts` line 22-29: `SELECT pe.pick_n, pe.seat, c.name, c.oracle_id, c.scryfall_json FROM pick_events pe JOIN cards c ... ORDER BY pe.pick_n`

**Files:**
- Modify: `src/core/db/queries/picks.ts`
- Create: `src/core/db/queries/picks.liveDraft.test.ts` (separate test file to avoid bloating the existing test file)

Note: The existing functions in picks.ts (`getPicks`, `getAvailableCards`, `getStandings`) use `getClient()` internally (no client parameter). The new functions follow the live-draft convention of accepting an explicit `client` parameter, matching the pattern in `pickQueue.ts` and `seatTokens.ts`. This is intentional — the live-draft routes already have a client instance from `getClient()` and pass it through to auth and query functions.

- [ ] **Step 1: Add `getLatestPickNumber` to picks.ts**

Add at the bottom of `src/core/db/queries/picks.ts`, after the `getStandings` function:

```ts
// ============================================================================
// Live Draft Pick Queries
// ============================================================================

/**
 * Get the latest pick number for a draft.
 * Returns 0 if no picks have been made.
 */
export async function getLatestPickNumber(
  client: Client,
  draftId: string,
): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COALESCE(MAX(pick_n), 0) as latest FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  return result.rows[0].latest as number;
}
```

Add the `Client` import at the top of the file:

```ts
import type { Client } from "@libsql/client";
```

- [ ] **Step 2: Add `getRecentPicks` to picks.ts**

Add after `getLatestPickNumber`:

```ts
/**
 * Get the N most recent picks for a draft, newest first.
 */
export async function getRecentPicks(
  client: Client,
  draftId: string,
  limit: number,
): Promise<Array<{ pickN: number; seat: number; cardName: string }>> {
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, c.name as card_name
          FROM pick_events pe
          JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?
          ORDER BY pe.pick_n DESC LIMIT ?`,
    args: [draftId, limit],
  });
  return result.rows.map((r) => ({
    pickN: r.pick_n as number,
    seat: r.seat as number,
    cardName: r.card_name as string,
  }));
}
```

- [ ] **Step 3: Add `getPicksWithCardDetails` to picks.ts**

Add after `getRecentPicks`:

```ts
export interface PickWithCardDetails {
  pickN: number;
  seat: number;
  cardName: string;
  oracleId: string;
  colorIdentity: string[];
  manaCost: string;
}

/**
 * Get all picks for a draft with Scryfall card details (color identity, mana cost).
 * Used by the draft board to render the pick matrix.
 */
export async function getPicksWithCardDetails(
  client: Client,
  draftId: string,
): Promise<PickWithCardDetails[]> {
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, c.name, c.oracle_id, c.scryfall_json
          FROM pick_events pe
          JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?
          ORDER BY pe.pick_n`,
    args: [draftId],
  });
  return result.rows.map((r) => {
    const sf = transformScryfallJson(r.scryfall_json as string | null, r.name as string);
    return {
      pickN: r.pick_n as number,
      seat: r.seat as number,
      cardName: r.name as string,
      oracleId: r.oracle_id as string,
      colorIdentity: sf?.colorIdentity ?? [],
      manaCost: sf?.manaCost ?? "",
    };
  });
}
```

Add the `transformScryfallJson` import at the top (it is already exported from `./helpers`):

```ts
import { getOptedOutSeats, parseScryfallJson, matchesColorFilter, parseBannedCards, transformScryfallJson } from "./helpers";
```

- [ ] **Step 4: Add tests**

Create `src/core/db/queries/picks.liveDraft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getLatestPickNumber,
  getRecentPicks,
  getPicksWithCardDetails,
} from "./picks";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

// Mock getClient so existing functions don't fail if accidentally called
vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("getLatestPickNumber", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the latest pick number", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 15 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(15);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("MAX(pick_n)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no picks exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 0 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("getRecentPicks", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns recent picks in descending order", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { pick_n: 3, seat: 3, card_name: "Dark Ritual" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
      ],
    });

    const result = await getRecentPicks(client, "draft-1", 10);

    expect(result).toEqual([
      { pickN: 3, seat: 3, cardName: "Dark Ritual" },
      { pickN: 2, seat: 2, cardName: "Counterspell" },
      { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    ]);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("ORDER BY pe.pick_n DESC LIMIT ?"),
        args: ["draft-1", 10],
      })
    );
  });

  it("returns empty array when no picks", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getRecentPicks(client, "draft-1", 5);

    expect(result).toEqual([]);
  });
});

describe("getPicksWithCardDetails", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns picks with parsed scryfall data", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Lightning Bolt",
        oracle_id: "abc-123",
        scryfall_json: JSON.stringify({ color_identity: ["R"], mana_cost: "{R}" }),
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result).toEqual([{
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    }]);
  });

  it("handles null scryfall_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        scryfall_json: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });

  it("handles invalid scryfall_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        scryfall_json: "not valid json",
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });
});
```

- [ ] **Step 5: Verify** — Run `pnpm typecheck && pnpm vitest run src/core/db/queries/picks.liveDraft.test.ts`

---

### Task 3: Add `getDraftPhase` to drafts.ts

**Inline queries replaced:**
- `match/route.ts` line 34-37: `SELECT phase FROM drafts WHERE draft_id = ?`

**Files:**
- Modify: `src/core/db/queries/drafts.ts`
- Create: `src/core/db/queries/drafts.liveDraft.test.ts`

- [ ] **Step 1: Add `getDraftPhase` to drafts.ts**

Add the `Client` import and the function at the bottom of `src/core/db/queries/drafts.ts`:

```ts
import type { Client } from "@libsql/client";
```

(Add to the existing imports section at the top of the file.)

```ts
// ============================================================================
// Live Draft Queries
// ============================================================================

/**
 * Get the current phase of a draft.
 * Returns null if the draft doesn't exist.
 */
export async function getDraftPhase(
  client: Client,
  draftId: string,
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT phase FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].phase as string;
}
```

- [ ] **Step 2: Add tests**

Create `src/core/db/queries/drafts.liveDraft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getDraftPhase } from "./drafts";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("getDraftPhase", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the phase for an existing draft", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ phase: "drafting" }] });

    const result = await getDraftPhase(client, "draft-1");

    expect(result).toBe("drafting");
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT phase FROM drafts"),
        args: ["draft-1"],
      })
    );
  });

  it("returns null for a missing draft", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getDraftPhase(client, "nonexistent");

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/core/db/queries/drafts.liveDraft.test.ts`

---

### Task 4: Create matches.ts query module

**Inline queries replaced:**
- `status/route.ts` line 55-58: `SELECT COUNT(*) as cnt FROM match_events WHERE draft_id = ?`
- `match/route.ts` line 51-55: `INSERT OR REPLACE INTO match_events ...`

**Files:**
- Create: `src/core/db/queries/matches.ts`
- Create: `src/core/db/queries/matches.test.ts`
- Modify: `src/core/db/queries/index.ts` — add re-export

- [ ] **Step 1: Create matches.ts**

Create `src/core/db/queries/matches.ts`:

```ts
/**
 * Match result queries for live drafts.
 */

import type { Client } from "@libsql/client";

/**
 * Get the number of reported matches for a draft.
 */
export async function getMatchCount(
  client: Client,
  draftId: string,
): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COUNT(*) as cnt FROM match_events WHERE draft_id = ?",
    args: [draftId],
  });
  return result.rows[0].cnt as number;
}

/**
 * Report (or update) a match result between two seats.
 * Uses INSERT OR REPLACE to allow corrections.
 * seat1 must be less than seat2 (caller normalizes).
 */
export async function reportMatchResult(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number,
  reportedBySeat: number,
): Promise<void> {
  await client.execute({
    sql: `INSERT OR REPLACE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins, reported_by_seat)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins, reportedBySeat],
  });
}
```

- [ ] **Step 2: Add re-export to index.ts**

Add to `src/core/db/queries/index.ts`:

```ts
export * from "./matches";
```

- [ ] **Step 3: Add tests**

Create `src/core/db/queries/matches.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getMatchCount, reportMatchResult } from "./matches";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

describe("getMatchCount", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the count of matches", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 7 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(7);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("COUNT(*)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no matches exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("reportMatchResult", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("executes INSERT OR REPLACE with correct args", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    await reportMatchResult(client, "draft-1", 1, 3, 2, 1, 3);

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT OR REPLACE INTO match_events"),
        args: ["draft-1", 1, 3, 2, 1, 3],
      })
    );
  });
});
```

- [ ] **Step 4: Verify** — Run `pnpm typecheck && pnpm vitest run src/core/db/queries/matches.test.ts`

---

### Task 5: Add `resolveCardId` to cards.ts

**Inline query replaced:**
- `pick/route.ts` line 22-25: `SELECT card_id FROM cards WHERE name = ?`

**Files:**
- Modify: `src/core/db/queries/cards.ts`
- Create: `src/core/db/queries/cards.liveDraft.test.ts`

- [ ] **Step 1: Add `resolveCardId` to cards.ts**

Add the `Client` import and the function at the bottom of `src/core/db/queries/cards.ts`:

```ts
import type { Client } from "@libsql/client";
```

(Add to the existing imports section at the top of the file.)

```ts
// ============================================================================
// Live Draft Card Queries
// ============================================================================

/**
 * Resolve a card name to its card_id.
 * Uses exact name match (case-sensitive, matching the pick route behavior).
 * Returns null if the card doesn't exist.
 */
export async function resolveCardId(
  client: Client,
  cardName: string,
): Promise<number | null> {
  const result = await client.execute({
    sql: "SELECT card_id FROM cards WHERE name = ?",
    args: [cardName],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].card_id as number;
}
```

- [ ] **Step 2: Add tests**

Create `src/core/db/queries/cards.liveDraft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { resolveCardId } from "./cards";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("resolveCardId", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns card_id for an existing card", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });

    const result = await resolveCardId(client, "Lightning Bolt");

    expect(result).toBe(42);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT card_id FROM cards WHERE name = ?"),
        args: ["Lightning Bolt"],
      })
    );
  });

  it("returns null for a nonexistent card", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveCardId(client, "Not A Real Card");

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/core/db/queries/cards.liveDraft.test.ts`

---

## Chunk 2: Route Migration

These tasks update routes to use the query layer. Each depends on the corresponding query functions from Chunk 1 being complete. No dependencies between routes — all can run in parallel once Chunk 1 is done.

### Task 6: Migrate status/route.ts (5 inline queries)

**Files:**
- Modify: `src/app/api/drafts/[id]/status/route.ts`
- Modify: `src/app/api/drafts/[id]/status/route.test.ts`

- [ ] **Step 1: Replace route handler**

Replace the entire contents of `src/app/api/drafts/[id]/status/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";
import { getLatestPickNumber, getRecentPicks } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    // Draft metadata still fetched inline — it returns multiple columns
    // specific to this route's response shape
    const draft = await client.execute({
      sql: "SELECT phase, num_seats, picks_per_player FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, num_seats: numSeats, picks_per_player: picksPerPlayer } = draft.rows[0];

    const latestPickN = await getLatestPickNumber(client, draftId);

    const next = picksPerPlayer
      ? getNextPick(latestPickN, numSeats as number, picksPerPlayer as number)
      : null;

    const recentPicks = await getRecentPicks(client, draftId, 10);
    const seatNames = await getSeatDisplayNames(client, draftId);
    const matchCount = await getMatchCount(client, draftId);

    const ns = numSeats as number;
    const totalMatches = (ns * (ns - 1)) / 2;

    return NextResponse.json({
      phase,
      latestPickN,
      nextSeat: next?.seat ?? null,
      numSeats,
      picksPerPlayer,
      recentPicks,
      seatNames,
      matchCount,
      totalMatches,
    }, {
      headers: { "Cache-Control": "no-cache" },
    });
  } catch (error) {
    console.error("[/api/drafts/[id]/status] Error:", error);
    return NextResponse.json({ error: "Failed to load status" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update route test to mock query functions instead of raw execute calls**

Replace the entire contents of `src/app/api/drafts/[id]/status/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockGetLatestPickNumber = vi.fn();
const mockGetRecentPicks = vi.fn();
vi.mock("@/core/db/queries/picks", () => ({
  getLatestPickNumber: (...args: unknown[]) => mockGetLatestPickNumber(...args),
  getRecentPicks: (...args: unknown[]) => mockGetRecentPicks(...args),
}));

const mockGetSeatDisplayNames = vi.fn();
vi.mock("@/core/db/queries/seatTokens", () => ({
  getSeatDisplayNames: (...args: unknown[]) => mockGetSeatDisplayNames(...args),
}));

const mockGetMatchCount = vi.fn();
vi.mock("@/core/db/queries/matches", () => ({
  getMatchCount: (...args: unknown[]) => mockGetMatchCount(...args),
}));

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/drafts/[id]/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns draft status with next seat", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 10, picks_per_player: 5 }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(3);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.phase).toBe("drafting");
    expect(body.latestPickN).toBe(3);
    expect(body.nextSeat).toBe(4);
    expect(body.numSeats).toBe(10);
    expect(body.picksPerPlayer).toBe(5);
    expect(body.recentPicks).toEqual([]);
    expect(body.seatNames).toEqual({});
    expect(body.matchCount).toBe(0);
    expect(body.totalMatches).toBe(45);
  });

  it("returns 404 for missing draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/status"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });

  it("includes recent picks and seat names", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 4, picks_per_player: 10 }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(2);
    mockGetRecentPicks.mockResolvedValueOnce([
      { pickN: 2, seat: 2, cardName: "Counterspell" },
      { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    ]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({ "1": "Alice" });
    mockGetMatchCount.mockResolvedValueOnce(1);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.recentPicks).toHaveLength(2);
    expect(body.recentPicks[0].cardName).toBe("Counterspell");
    expect(body.seatNames).toEqual({ "1": "Alice" });
    expect(body.matchCount).toBe(1);
  });

  it("returns null nextSeat when picksPerPlayer is null", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ phase: "setup", num_seats: 4, picks_per_player: null }],
    });
    mockGetLatestPickNumber.mockResolvedValueOnce(0);
    mockGetRecentPicks.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});
    mockGetMatchCount.mockResolvedValueOnce(0);

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/status"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.nextSeat).toBeNull();
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/app/api/drafts/[id]/status/route.test.ts`

---

### Task 7: Migrate board/route.ts (3 inline queries)

**Files:**
- Modify: `src/app/api/drafts/[id]/board/route.ts`
- Modify: `src/app/api/drafts/[id]/board/route.test.ts`

- [ ] **Step 1: Replace route handler**

Replace the entire contents of `src/app/api/drafts/[id]/board/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { parseBannedCardNames } from "@/core/db/queries/helpers";
import { getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    const draft = await client.execute({
      sql: "SELECT draft_id, num_seats, picks_per_player, phase, banned_cards FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const d = draft.rows[0];

    const picks = await getPicksWithCardDetails(client, draftId);
    const seatNames = await getSeatDisplayNames(client, draftId);
    const bannedCards = parseBannedCardNames(d.banned_cards as string | null);

    return NextResponse.json({
      draftId,
      numSeats: d.num_seats,
      picksPerPlayer: d.picks_per_player,
      phase: d.phase,
      seatNames,
      picks,
      bannedCards,
    }, {
      headers: { "Cache-Control": "public, s-maxage=5" },
    });
  } catch (error) {
    console.error("[/api/drafts/[id]/board] Error:", error);
    return NextResponse.json({ error: "Failed to load board" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update route test to mock query functions**

Replace the entire contents of `src/app/api/drafts/[id]/board/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockGetPicksWithCardDetails = vi.fn();
vi.mock("@/core/db/queries/picks", () => ({
  getPicksWithCardDetails: (...args: unknown[]) => mockGetPicksWithCardDetails(...args),
}));

const mockGetSeatDisplayNames = vi.fn();
vi.mock("@/core/db/queries/seatTokens", () => ({
  getSeatDisplayNames: (...args: unknown[]) => mockGetSeatDisplayNames(...args),
}));

function makeRequest(url: string) {
  return new NextRequest(new URL(url, "http://localhost:3000"));
}

describe("GET /api/drafts/[id]/board", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns board data with picks", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        draft_id: "test",
        num_seats: 4,
        picks_per_player: 10,
        phase: "drafting",
        banned_cards: null,
      }],
    });
    mockGetPicksWithCardDetails.mockResolvedValueOnce([{
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    }]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({ "1": "Alice" });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/board"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.draftId).toBe("test");
    expect(body.numSeats).toBe(4);
    expect(body.phase).toBe("drafting");
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].cardName).toBe("Lightning Bolt");
    expect(body.picks[0].colorIdentity).toEqual(["R"]);
    expect(body.picks[0].manaCost).toBe("{R}");
    expect(body.seatNames).toEqual({ "1": "Alice" });
    expect(body.bannedCards).toEqual([]);
  });

  it("returns 404 for missing draft", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/nope/board"),
      { params: Promise.resolve({ id: "nope" }) },
    );

    expect(res.status).toBe(404);
  });

  it("parses banned cards", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{
        draft_id: "test",
        num_seats: 2,
        picks_per_player: 5,
        phase: "drafting",
        banned_cards: JSON.stringify(["Sol Ring", "Black Lotus"]),
      }],
    });
    mockGetPicksWithCardDetails.mockResolvedValueOnce([]);
    mockGetSeatDisplayNames.mockResolvedValueOnce({});

    const res = await GET(
      makeRequest("http://localhost:3000/api/drafts/test/board"),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.bannedCards).toEqual(["Sol Ring", "Black Lotus"]);
  });
});
```

Note: The "handles invalid scryfall_json gracefully" test is removed from the route test because that behavior is now tested in `picks.liveDraft.test.ts` (the `getPicksWithCardDetails` tests). The route test focuses on the route's own logic (404, banned cards, response shape).

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/app/api/drafts/[id]/board/route.test.ts`

---

### Task 8: Migrate match/route.ts (2 inline queries)

**Files:**
- Modify: `src/app/api/drafts/[id]/match/route.ts`
- Modify: `src/app/api/drafts/[id]/match/route.test.ts`

- [ ] **Step 1: Replace route handler**

Replace the entire contents of `src/app/api/drafts/[id]/match/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { AppError } from "@/core/errors";
import { getDraftPhase } from "@/core/db/queries/drafts";
import { reportMatchResult } from "@/core/db/queries/matches";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat, wins, losses } = body;
    if (opponent_seat == null || wins == null || losses == null) {
      return NextResponse.json({ error: "opponent_seat, wins, and losses required" }, { status: 400 });
    }
    if (!Number.isInteger(opponent_seat) || !Number.isInteger(wins) || !Number.isInteger(losses)) {
      return NextResponse.json({ error: "opponent_seat, wins, and losses must be integers" }, { status: 400 });
    }
    if (wins < 0 || losses < 0) {
      return NextResponse.json({ error: "wins and losses must be non-negative" }, { status: 400 });
    }
    if (opponent_seat < 1) {
      return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
    }
    if (opponent_seat === mySeat) {
      return NextResponse.json({ error: "Cannot report a match against yourself" }, { status: 400 });
    }

    const phase = await getDraftPhase(client, draftId);
    if (phase === null) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    if (phase !== "playing" && phase !== "complete") {
      return NextResponse.json({ error: `Cannot report matches in '${phase}' phase` }, { status: 400 });
    }

    const seat1 = Math.min(mySeat, opponent_seat);
    const seat2 = Math.max(mySeat, opponent_seat);
    const seat1Wins = mySeat === seat1 ? wins : losses;
    const seat2Wins = mySeat === seat2 ? wins : losses;

    await reportMatchResult(client, draftId, seat1, seat2, seat1Wins, seat2Wins, mySeat);

    return NextResponse.json({ success: true, seat1, seat2, seat1Wins, seat2Wins });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/match] Error:", error);
    return NextResponse.json({ error: "Failed to report match" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update route test to mock query functions**

Replace the entire contents of `src/app/api/drafts/[id]/match/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockGetDraftPhase = vi.fn();
vi.mock("@/core/db/queries/drafts", () => ({
  getDraftPhase: (...args: unknown[]) => mockGetDraftPhase(...args),
}));

const mockReportMatchResult = vi.fn();
vi.mock("@/core/db/queries/matches", () => ({
  reportMatchResult: (...args: unknown[]) => mockReportMatchResult(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(
    new URL("http://localhost:3000/api/drafts/test/match"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Seat-Token": token } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

describe("POST /api/drafts/[id]/match", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves match result and returns normalized seats", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockGetDraftPhase.mockResolvedValueOnce("playing");
    mockReportMatchResult.mockResolvedValueOnce(undefined);

    const res = await POST(
      makeRequest({ opponent_seat: 1, wins: 2, losses: 1 }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.seat1).toBe(1);
    expect(body.seat2).toBe(3);
    expect(body.seat1Wins).toBe(1);
    expect(body.seat2Wins).toBe(2);
    expect(mockReportMatchResult).toHaveBeenCalledWith(
      expect.anything(), "test", 1, 3, 1, 2, 3
    );
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await POST(
      makeRequest({ opponent_seat: 1, wins: 2, losses: 0 }, ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("returns 400 for missing fields", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(
      makeRequest({ opponent_seat: 2 }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 when reporting match against yourself", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(
      makeRequest({ opponent_seat: 1, wins: 2, losses: 0 }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("yourself");
  });

  it("returns 400 when draft is in wrong phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockGetDraftPhase.mockResolvedValueOnce("drafting");

    const res = await POST(
      makeRequest({ opponent_seat: 2, wins: 2, losses: 1 }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("drafting");
  });

  it("returns 404 when draft not found", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockGetDraftPhase.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({ opponent_seat: 2, wins: 2, losses: 1 }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(404);
  });

  it("allows match reporting in complete phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockGetDraftPhase.mockResolvedValueOnce("complete");
    mockReportMatchResult.mockResolvedValueOnce(undefined);

    const res = await POST(
      makeRequest({ opponent_seat: 2, wins: 2, losses: 0 }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/app/api/drafts/[id]/match/route.test.ts`

---

### Task 9: Migrate pick/route.ts (1 inline query)

**Files:**
- Modify: `src/app/api/drafts/[id]/pick/route.ts`
- Modify: `src/app/api/drafts/[id]/pick/route.test.ts`

- [ ] **Step 1: Replace route handler**

Replace the entire contents of `src/app/api/drafts/[id]/pick/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { processPick } from "@/core/processPick";
import { AppError } from "@/core/errors";
import { resolveCardId } from "@/core/db/queries/cards";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: draftId } = await params;
  const client = await getClient();

  try {
    const { seat } = await authenticateSeat(client, request, draftId);
    const body = await request.json();
    const { card_name } = body;
    if (!card_name) {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    const cardId = await resolveCardId(client, card_name);
    if (cardId === null) {
      return NextResponse.json({ error: `Card not found: ${card_name}` }, { status: 400 });
    }

    const result = await processPick(client, {
      draftId,
      seat,
      cardId,
      cardName: card_name,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/pick] Error:", error);
    return NextResponse.json({ error: "Pick failed" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update route test to mock `resolveCardId`**

Replace the entire contents of `src/app/api/drafts/[id]/pick/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { AuthError, ConflictError, ValidationError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockProcessPick = vi.fn();
vi.mock("@/core/processPick", () => ({
  processPick: (...args: unknown[]) => mockProcessPick(...args),
}));

const mockResolveCardId = vi.fn();
vi.mock("@/core/db/queries/cards", () => ({
  resolveCardId: (...args: unknown[]) => mockResolveCardId(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/pick"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Seat-Token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/drafts/[id]/pick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns picks on success", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockResolveCardId.mockResolvedValueOnce(42);
    mockProcessPick.mockResolvedValueOnce({
      picks: [{ pickN: 1, seat: 1, cardName: "Lightning Bolt" }],
    });

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].cardName).toBe("Lightning Bolt");
  });

  it("returns 400 for missing card_name", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(
      makeRequest({}),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockResolveCardId.mockResolvedValueOnce(null);

    const res = await POST(
      makeRequest({ card_name: "Not A Real Card" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 401 when authentication fails", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }, ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("returns 409 on conflict", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockResolveCardId.mockResolvedValueOnce(42);
    mockProcessPick.mockRejectedValueOnce(new ConflictError("Conflict: pick already made"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 when not your turn", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockResolveCardId.mockResolvedValueOnce(42);
    mockProcessPick.mockRejectedValueOnce(new ValidationError("Not your turn"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/app/api/drafts/[id]/pick/route.test.ts`

---

### Task 10: Migrate seat-settings/route.ts (1 inline query)

**Files:**
- Modify: `src/app/api/drafts/[id]/seat-settings/route.ts`
- Modify: `src/app/api/drafts/[id]/seat-settings/route.test.ts`

- [ ] **Step 1: Replace route handler**

Replace the entire contents of `src/app/api/drafts/[id]/seat-settings/route.ts` with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { updateAutoPick, updateDisplayName, getSeatSettings } from "@/core/db/queries/seatTokens";
import { AppError } from "@/core/errors";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();

    if (body.display_name !== undefined && typeof body.display_name === "string" && body.display_name.length > 50) {
      return NextResponse.json({ error: "display_name must be 50 characters or fewer" }, { status: 400 });
    }

    if (body.auto_pick !== undefined) {
      await updateAutoPick(client, draftId, seat, body.auto_pick);
    }
    if (body.display_name !== undefined) {
      await updateDisplayName(client, draftId, seat, body.display_name || null);
    }

    const settings = await getSeatSettings(client, draftId, seat);

    return NextResponse.json({
      seat,
      autoPick: settings!.autoPick,
      displayName: settings!.displayName,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/seat-settings] Error:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
```

- [ ] **Step 2: Update route test to mock `getSeatSettings`**

Replace the entire contents of `src/app/api/drafts/[id]/seat-settings/route.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PUT } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockUpdateAutoPick = vi.fn();
const mockUpdateDisplayName = vi.fn();
const mockGetSeatSettings = vi.fn();
vi.mock("@/core/db/queries/seatTokens", () => ({
  updateAutoPick: (...args: unknown[]) => mockUpdateAutoPick(...args),
  updateDisplayName: (...args: unknown[]) => mockUpdateDisplayName(...args),
  getSeatSettings: (...args: unknown[]) => mockGetSeatSettings(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(
    new URL("http://localhost:3000/api/drafts/test/seat-settings"),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Seat-Token": token } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

describe("PUT /api/drafts/[id]/seat-settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates auto_pick and returns settings", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 2, autoPick: false });
    mockUpdateAutoPick.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: true, displayName: "Bob" });

    const res = await PUT(
      makeRequest({ auto_pick: true }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.seat).toBe(2);
    expect(body.autoPick).toBe(true);
    expect(body.displayName).toBe("Bob");
    expect(mockUpdateAutoPick).toHaveBeenCalledOnce();
  });

  it("updates display_name and returns settings", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: false, displayName: "Alice" });

    const res = await PUT(
      makeRequest({ display_name: "Alice" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.displayName).toBe("Alice");
    expect(mockUpdateDisplayName).toHaveBeenCalledOnce();
    expect(mockUpdateAutoPick).not.toHaveBeenCalled();
  });

  it("clears display_name when empty string is sent", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: false, displayName: null });

    const res = await PUT(
      makeRequest({ display_name: "" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.displayName).toBeNull();
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(
      makeRequest({ auto_pick: true }, ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("updates both auto_pick and display_name together", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockUpdateAutoPick.mockResolvedValueOnce(undefined);
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: true, displayName: "Charlie" });

    const res = await PUT(
      makeRequest({ auto_pick: true, display_name: "Charlie" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.autoPick).toBe(true);
    expect(body.displayName).toBe("Charlie");
    expect(mockUpdateAutoPick).toHaveBeenCalledOnce();
    expect(mockUpdateDisplayName).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Verify** — Run `pnpm typecheck && pnpm vitest run src/app/api/drafts/[id]/seat-settings/route.test.ts`

---

## Chunk 3: Final Verification

### Task 11: Full suite verification

- [ ] **Step 1:** Run `pnpm typecheck` — must pass with zero errors
- [ ] **Step 2:** Run `pnpm test` — all tests must pass
- [ ] **Step 3:** Run `pnpm lint` — zero warnings
- [ ] **Step 4:** Run `pnpm knip` — verify no new unused exports (the new query functions should all be imported by routes)
- [ ] **Step 5:** Commit all changes

---

## Summary

| Route | Inline queries removed | Query functions used |
|-------|----------------------|---------------------|
| `status/route.ts` | 4 (of 5 total; draft metadata query kept inline) | `getLatestPickNumber`, `getRecentPicks`, `getSeatDisplayNames`, `getMatchCount` |
| `board/route.ts` | 2 (of 3 total; draft metadata query kept inline) | `getPicksWithCardDetails`, `getSeatDisplayNames` |
| `match/route.ts` | 2 | `getDraftPhase`, `reportMatchResult` |
| `pick/route.ts` | 1 | `resolveCardId` |
| `seat-settings/route.ts` | 1 | `getSeatSettings` |
| **Total** | **10** | **8 new functions** |

Note: The draft metadata queries in `status/route.ts` and `board/route.ts` are kept inline because they select route-specific column combinations (`phase, num_seats, picks_per_player` vs `draft_id, num_seats, picks_per_player, phase, banned_cards`). Extracting these into a generic "get draft" function would either over-fetch or require multiple variants, adding complexity without reducing duplication. The 10 extracted queries cover all the reusable patterns.

**New files created:**
- `src/core/db/queries/matches.ts`
- `src/core/db/queries/matches.test.ts`
- `src/core/db/queries/picks.liveDraft.test.ts`
- `src/core/db/queries/drafts.liveDraft.test.ts`
- `src/core/db/queries/cards.liveDraft.test.ts`
