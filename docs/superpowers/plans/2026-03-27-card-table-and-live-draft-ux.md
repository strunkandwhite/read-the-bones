# Card Table and Live Draft UX Rework — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the card table into a lean scanning surface, add a card stats modal for detailed analytics and pick/queue/float actions, introduce hold-to-pick confirmation, server-side float state, color pair breakdown stats, and queue management with auto-pick invalidation modes.

**Architecture:** The table slims to card identity + pick score. A new CardStatsModal fetches detailed stats on demand from an expanded `/api/cards/stats` endpoint. Float state moves server-side via a new `floated_cards` table. The auto-pick cascade gains cautious mode (pause on queue invalidation). A queue panel in the draft board modal provides reordering and settings.

**Tech Stack:** Next.js 15, React 19, TanStack Table, Turso/libSQL, Tailwind CSS, Vitest

**Spec:** `docs/superpowers/specs/2026-03-27-card-table-and-live-draft-ux-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/core/db/schema.sql` (append) | Schema: `floated_cards` table + `auto_pick_mode` column on `seat_tokens` |
| `src/core/db/queries/floatedCards.ts` | DB queries for float CRUD |
| `src/core/db/queries/floatedCards.test.ts` | Tests for float queries |
| `src/core/db/queries/stats/colorPairBreakdown.ts` | Color pair breakdown query |
| `src/core/db/queries/stats/colorPairBreakdown.test.ts` | Tests for color pair breakdown |
| `src/core/db/queries/stats/pickHistory.ts` | Per-draft pick history + distribution query |
| `src/core/db/queries/stats/pickHistory.test.ts` | Tests for pick history |
| `src/app/api/drafts/[id]/float/route.ts` | Float API endpoints (GET/PUT/DELETE) |
| `src/app/api/drafts/[id]/float/route.test.ts` | Tests for float API |
| `src/app/components/CardStatsModal.tsx` | Stats modal component |
| `src/app/components/CardStatsModal.test.tsx` | Tests for stats modal |
| `src/app/components/HoldToPickButton.tsx` | Hold-to-pick confirmation button |
| `src/app/components/HoldToPickButton.test.tsx` | Tests for hold-to-pick |
| `src/app/components/CardStatusIcon.tsx` | Single status icon (picked/queued/floated) |
| `src/app/components/draft-board/QueuePanel.tsx` | Queue management panel for pod view |
| `src/app/components/draft-board/QueuePanel.test.tsx` | Tests for queue panel |
| `src/app/hooks/useCardStats.ts` | Hook to fetch card stats on demand |
| `src/app/hooks/useFloatedCards.ts` | Hook to manage float state via API |
| `src/app/hooks/useFloatedCards.test.ts` | Tests for float hook |
| `src/app/hooks/useHoldToConfirm.ts` | Pointer/keyboard hold gesture hook |
| `src/app/hooks/useHoldToConfirm.test.ts` | Tests for hold gesture |

### Modified Files
| File | Changes |
|------|---------|
| `src/core/getCards.ts` | Remove `pickDistribution`, `scoreHistory`, `decklistWinRate`, `totalPicks`, `timesUnpicked` from pipeline |
| `src/core/calculateStats.ts` | Remove distribution/history computation from `CardStats` type |
| `src/core/processPick.ts` | Add cautious mode: check queues for sniped cards, pause auto-pick if cautious |
| `src/core/db/queries/stats/cardStats.ts` | Add `pickHistory`, `pickDistribution`, `colorPairBreakdown` to `CardStatsResult` |
| `src/app/api/cards/stats/route.ts` | Pass new fields through |
| `src/app/api/drafts/[id]/seat-settings/route.ts` | Accept `autoPickMode` parameter |
| `src/app/api/drafts/[id]/me/route.ts` | Return `autoPickMode` in response |
| `src/app/api/drafts/[id]/queue/route.ts` | Auto-create float row on unqueue |
| `src/core/db/queries/seatTokens.ts` | Add `updateAutoPickMode`, return `auto_pick_mode` from settings queries |
| `src/core/db/queries/pickQueue.ts` | Add `getQueuesContainingCard()` for cascade invalidation |
| `src/app/components/CardTable.tsx` | Remove stat columns, add row click → modal, remove action icon props |
| `src/app/components/CardNameCell.tsx` | Strip action icons, add single CardStatusIcon |
| `src/app/components/DraftBoardModal.tsx` | Add QueuePanel tab/section |
| `src/app/hooks/useMySeat.ts` | Add `autoPickMode`, `updateAutoPickMode` |
| `src/app/hooks/useDeckBuilder.ts` | Read floated cards from API instead of localStorage speculative state |
| `src/app/hooks/useLiveDraftPicking.ts` | Remove auto-pick from client (now server-only via cascade) |
| `src/app/components/PageClient.tsx` | Wire modal state, pass float/queue state to table |

---

## Chunk 1: Backend Foundation (Schema, Float API, Stats Expansion)

### Task 1: Database Schema — `floated_cards` Table and `auto_pick_mode` Column

**Files:**
- Modify: `src/core/db/schema.sql` (append new statements)

**Context:** This project uses a single `schema.sql` file + `migrate.ts` that runs all statements idempotently (catches "already exists" and "duplicate column" errors). No numbered migration files — just append to the schema.

- [ ] **Step 1: Append schema statements to `src/core/db/schema.sql`**

Add at the end of the file:

```sql
-- floated_cards: server-side storage for speculatively added cards
CREATE TABLE IF NOT EXISTS floated_cards (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  card_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (draft_id, seat, card_name),
  FOREIGN KEY (draft_id) REFERENCES drafts(draft_id)
);

-- auto_pick_mode on seat_tokens: 'resilient' (default) or 'cautious'
ALTER TABLE seat_tokens ADD COLUMN auto_pick_mode TEXT NOT NULL DEFAULT 'resilient';
```

Note: FK references `drafts(draft_id)` — the drafts table PK is `draft_id`, not `id`.

- [ ] **Step 2: Run the migration**

Run: `pnpm db:migrate`
Expected: Migration applies successfully. The `ALTER TABLE` may show a caught "duplicate column" warning on subsequent runs — that's expected behavior.

- [ ] **Step 3: Verify the schema**

Run: `turso db shell read-the-bones ".schema floated_cards"` and `turso db shell read-the-bones ".schema seat_tokens"`
Expected: `floated_cards` table exists with correct columns; `seat_tokens` has `auto_pick_mode` column.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/schema.sql
git commit -m "feat: add floated_cards table and auto_pick_mode column to schema"
```

---

### Task 2: Float Card DB Queries

**Files:**
- Create: `src/core/db/queries/floatedCards.ts`
- Create: `src/core/db/queries/floatedCards.test.ts`

- [ ] **Step 1: Write failing tests for float queries**

Create `src/core/db/queries/floatedCards.test.ts`. Follow the pattern in `pickQueue.test.ts` — query functions take a `Client` as the first parameter:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFloatedCards, addFloatedCard, removeFloatedCard } from "./floatedCards";

describe("floatedCards queries", () => {
  let mockClient: { execute: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn() };
  });

  describe("getFloatedCards", () => {
    it("returns floated card names for a draft and seat", async () => {
      mockClient.execute.mockResolvedValue({
        rows: [
          { card_name: "Lightning Bolt" },
          { card_name: "Counterspell" },
        ],
      });
      const result = await getFloatedCards(mockClient as any, "draft-1", 1);
      expect(result).toEqual(["Lightning Bolt", "Counterspell"]);
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("floated_cards"),
        })
      );
    });

    it("returns empty array when no floated cards", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      const result = await getFloatedCards(mockClient as any, "draft-1", 1);
      expect(result).toEqual([]);
    });
  });

  describe("addFloatedCard", () => {
    it("inserts a floated card row", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await addFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("INSERT"),
          args: expect.arrayContaining(["draft-1", 1, "Lightning Bolt"]),
        })
      );
    });

    it("uses INSERT OR IGNORE to handle duplicates", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await addFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("OR IGNORE"),
        })
      );
    });
  });

  describe("removeFloatedCard", () => {
    it("deletes a floated card row", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await removeFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("DELETE"),
          args: expect.arrayContaining(["draft-1", 1, "Lightning Bolt"]),
        })
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/floatedCards.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the float queries implementation**

Create `src/core/db/queries/floatedCards.ts`. All query functions take `Client` as the first parameter, following the pattern in `pickQueue.ts` and `seatTokens.ts`:

```typescript
import type { Client } from "@libsql/client";

export async function getFloatedCards(
  client: Client,
  draftId: string,
  seat: number
): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT card_name FROM floated_cards
          WHERE draft_id = ? AND seat = ?
          ORDER BY created_at ASC`,
    args: [draftId, seat],
  });
  return result.rows.map((row) => row.card_name as string);
}

export async function addFloatedCard(
  client: Client,
  draftId: string,
  seat: number,
  cardName: string
): Promise<void> {
  await client.execute({
    sql: `INSERT OR IGNORE INTO floated_cards (draft_id, seat, card_name)
          VALUES (?, ?, ?)`,
    args: [draftId, seat, cardName],
  });
}

export async function removeFloatedCard(
  client: Client,
  draftId: string,
  seat: number,
  cardName: string
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM floated_cards
          WHERE draft_id = ? AND seat = ? AND card_name = ?`,
    args: [draftId, seat, cardName],
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/floatedCards.test.ts`
Expected: PASS — all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/floatedCards.ts src/core/db/queries/floatedCards.test.ts
git commit -m "feat: add floated cards DB queries"
```

---

### Task 3: Float API Route

**Files:**
- Create: `src/app/api/drafts/[id]/float/route.ts`
- Create: `src/app/api/drafts/[id]/float/route.test.ts`

- [ ] **Step 1: Write failing tests for the float API route**

Create `src/app/api/drafts/[id]/float/route.test.ts`. Follow the pattern in `src/app/api/drafts/[id]/queue/route.test.ts` for token authentication testing:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PUT, DELETE } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: vi.fn(),
}));

vi.mock("@/core/db/queries/floatedCards", () => ({
  getFloatedCards: vi.fn(),
  addFloatedCard: vi.fn(),
  removeFloatedCard: vi.fn(),
}));

function makeRequest(method: string, body?: object): NextRequest {
  const url = "http://localhost/api/drafts/draft-1/float";
  const init: RequestInit = {
    method,
    headers: { Authorization: "Bearer test-token" },
  };
  if (body) init.body = JSON.stringify(body);
  return new NextRequest(url, init);
}

const params = Promise.resolve({ id: "draft-1" });

describe("GET /api/drafts/[id]/float", () => {
  it("returns 401 without token", async () => {
    const { authenticateSeat } = await import("@/core/tokenAuth");
    (authenticateSeat as any).mockRejectedValue(new Error("Unauthorized"));
    const req = new NextRequest("http://localhost/api/drafts/draft-1/float");
    const res = await GET(req, { params });
    expect(res.status).toBe(401);
  });

  it("returns floated cards for authenticated seat", async () => {
    const { authenticateSeat } = await import("@/core/tokenAuth");
    (authenticateSeat as any).mockResolvedValue({ seat: 1 });
    const { getFloatedCards } = await import("@/core/db/queries/floatedCards");
    (getFloatedCards as any).mockResolvedValue(["Lightning Bolt", "Counterspell"]);

    const req = makeRequest("GET");
    const res = await GET(req, { params });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cards).toEqual(["Lightning Bolt", "Counterspell"]);
  });
});

describe("PUT /api/drafts/[id]/float", () => {
  it("adds a floated card", async () => {
    const { authenticateSeat } = await import("@/core/tokenAuth");
    (authenticateSeat as any).mockResolvedValue({ seat: 1 });
    const { addFloatedCard } = await import("@/core/db/queries/floatedCards");

    const req = makeRequest("PUT", { card_name: "Lightning Bolt" });
    const res = await PUT(req, { params });
    expect(res.status).toBe(200);
    expect(addFloatedCard).toHaveBeenCalledWith("draft-1", 1, "Lightning Bolt");
  });

  it("returns 400 without card_name", async () => {
    const { authenticateSeat } = await import("@/core/tokenAuth");
    (authenticateSeat as any).mockResolvedValue({ seat: 1 });

    const req = makeRequest("PUT", {});
    const res = await PUT(req, { params });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/drafts/[id]/float", () => {
  it("removes a floated card", async () => {
    const { authenticateSeat } = await import("@/core/tokenAuth");
    (authenticateSeat as any).mockResolvedValue({ seat: 1 });
    const { removeFloatedCard } = await import("@/core/db/queries/floatedCards");

    const req = makeRequest("DELETE", { card_name: "Lightning Bolt" });
    const res = await DELETE(req, { params });
    expect(res.status).toBe(200);
    expect(removeFloatedCard).toHaveBeenCalledWith("draft-1", 1, "Lightning Bolt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/api/drafts/[id]/float/route.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the float API route**

Create `src/app/api/drafts/[id]/float/route.ts`. Follow the auth pattern from the existing queue route — use `getClient()` then `authenticateSeat(client, request, draftId)`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import {
  getFloatedCards,
  addFloatedCard,
  removeFloatedCard,
} from "@/core/db/queries/floatedCards";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id: draftId } = await params;
  const client = await getClient();
  const { seat } = await authenticateSeat(client, req, draftId);

  const cards = await getFloatedCards(client, draftId, seat);
  return NextResponse.json({ cards });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id: draftId } = await params;
  const client = await getClient();
  const { seat } = await authenticateSeat(client, req, draftId);

  const body = await req.json();
  if (!body.card_name || typeof body.card_name !== "string") {
    return NextResponse.json({ error: "card_name required" }, { status: 400 });
  }

  await addFloatedCard(client, draftId, seat, body.card_name);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const { id: draftId } = await params;
  const client = await getClient();
  const { seat } = await authenticateSeat(client, req, draftId);

  const body = await req.json();
  if (!body.card_name || typeof body.card_name !== "string") {
    return NextResponse.json({ error: "card_name required" }, { status: 400 });
  }

  await removeFloatedCard(client, draftId, seat, body.card_name);
  return NextResponse.json({ ok: true });
}
```

Note: `authenticateSeat` throws on invalid tokens (returns 401 via error handling). Follow the same try/catch pattern as the queue route if needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/api/drafts/[id]/float/route.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/drafts/[id]/float/route.ts src/app/api/drafts/[id]/float/route.test.ts
git commit -m "feat: add float API endpoints (GET/PUT/DELETE)"
```

---

### Task 4: Color Pair Breakdown Query

**Files:**
- Create: `src/core/db/queries/stats/colorPairBreakdown.ts`
- Create: `src/core/db/queries/stats/colorPairBreakdown.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/db/queries/stats/colorPairBreakdown.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getColorPairBreakdown } from "./colorPairBreakdown";

vi.mock("../../client", () => ({
  getDb: vi.fn(),
}));

// Mock inferDeckColor — it's a pure function but we mock it for isolation
vi.mock("../../../inferDeckColor", () => ({
  inferDeckColor: vi.fn(),
}));

describe("getColorPairBreakdown", () => {
  let mockDb: { execute: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockDb = { execute: vi.fn() };
    const { getDb } = await import("../../client");
    (getDb as any).mockReturnValue(mockDb);
  });

  it("returns top 3 color pairs above 10% threshold", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");
    // Simulate 10 decks that maindecked a card
    // Return color counts for each deck
    mockDb.execute.mockResolvedValue({
      rows: [
        { draft_id: "d1", seat: 1, color_identity: "R" },
        { draft_id: "d1", seat: 1, color_identity: "W" },
        { draft_id: "d1", seat: 2, color_identity: "R" },
        { draft_id: "d1", seat: 2, color_identity: "W" },
        { draft_id: "d2", seat: 1, color_identity: "R" },
        { draft_id: "d2", seat: 1, color_identity: "B" },
        { draft_id: "d2", seat: 3, color_identity: "U" },
        { draft_id: "d2", seat: 3, color_identity: "R" },
      ],
    });

    // Mock inferDeckColor for each unique deck
    (inferDeckColor as any)
      .mockReturnValueOnce("RW")  // d1-seat1
      .mockReturnValueOnce("RW")  // d1-seat2
      .mockReturnValueOnce("RB")  // d2-seat1
      .mockReturnValueOnce("UR"); // d2-seat3

    const result = await getColorPairBreakdown("Lightning Bolt");
    expect(result).toEqual([
      { colorPair: "RW", percentage: 50, deckCount: 2 },
      { colorPair: "RB", percentage: 25, deckCount: 1 },
      { colorPair: "UR", percentage: 25, deckCount: 1 },
    ]);
  });

  it("filters out color pairs below 10%", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");
    mockDb.execute.mockResolvedValue({
      rows: Array.from({ length: 20 }, (_, i) => ({
        draft_id: `d${Math.floor(i / 2)}`,
        seat: (i % 2) + 1,
        color_identity: i < 18 ? "R" : "G",
      })),
    });

    // 10 decks total, 9 are RW, 1 is RG (10% exactly — should be included)
    (inferDeckColor as any)
      .mockReturnValue("RW");
    // Override last call
    (inferDeckColor as any)
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RG");

    const result = await getColorPairBreakdown("Some Card");
    // RW at 90%, RG at 10% — both meet threshold
    expect(result).toHaveLength(2);
    expect(result[0].colorPair).toBe("RW");
    expect(result[1].colorPair).toBe("RG");
  });

  it("returns empty array when card has never been maindecked", async () => {
    mockDb.execute.mockResolvedValue({ rows: [] });
    const result = await getColorPairBreakdown("Unplayed Card");
    expect(result).toEqual([]);
  });

  it("caps at 3 results", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");
    mockDb.execute.mockResolvedValue({
      rows: Array.from({ length: 10 }, (_, i) => ({
        draft_id: `d${i}`,
        seat: 1,
        color_identity: "R",
      })),
    });

    // 5 different color pairs, each at 20%
    (inferDeckColor as any)
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RB")
      .mockReturnValueOnce("RB")
      .mockReturnValueOnce("UR")
      .mockReturnValueOnce("UR")
      .mockReturnValueOnce("RG")
      .mockReturnValueOnce("RG")
      .mockReturnValueOnce("BR")
      .mockReturnValueOnce("BR");

    const result = await getColorPairBreakdown("Popular Card");
    expect(result.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/stats/colorPairBreakdown.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the color pair breakdown query**

Create `src/core/db/queries/stats/colorPairBreakdown.ts`. Takes `Client` param. Uses `cards` table (not `scryfall_cards` — that doesn't exist). Card Scryfall data is in `cards.scryfall_json`. The `deck_cards` table uses `card_id` (FK to `cards`), not `card_name`:

```typescript
import type { Client } from "@libsql/client";
import { inferDeckColor } from "@/core/inferDeckColor";

export type ColorPairEntry = {
  colorPair: string;
  percentage: number;
  deckCount: number;
};

/**
 * For a given card, find all decks that maindecked it,
 * infer each deck's color pair, and return the top 3
 * color pairs that represent ≥10% of total decks.
 */
export async function getColorPairBreakdown(
  client: Client,
  cardName: string,
  draftId?: string
): Promise<ColorPairEntry[]> {
  // Step 1: Find all decks (draft_id + seat) that maindecked this card.
  // Step 2: For each deck, get color_identity of all maindecked cards.
  // deck_cards uses card_id, so join through cards table for name matching.
  // Scryfall color_identity is in cards.scryfall_json.
  const draftFilter = draftId ? "AND dc.draft_id = ?" : "";
  const args: (string | number)[] = [cardName];
  if (draftId) args.push(draftId);

  // Get all maindecked cards' color identities for decks containing our target card
  const result = await client.execute({
    sql: `SELECT dc2.draft_id, dc2.seat,
                 json_extract(c2.scryfall_json, '$.color_identity') AS color_identity
          FROM deck_cards dc
          JOIN cards c ON c.card_id = dc.card_id
          JOIN deck_cards dc2 ON dc2.draft_id = dc.draft_id AND dc2.seat = dc.seat
            AND dc2.zone = 'main'
          JOIN cards c2 ON c2.card_id = dc2.card_id
          WHERE c.name = ? AND dc.zone = 'main' ${draftFilter}`,
    args,
  });

  if (result.rows.length === 0) return [];

  // Group by deck (draft_id + seat), aggregate color counts
  const deckColors = new Map<string, Map<string, number>>();
  for (const row of result.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    if (!deckColors.has(key)) deckColors.set(key, new Map());
    const colors = deckColors.get(key)!;
    // color_identity from Scryfall JSON is an array like ["R","W"]
    const colorId = row.color_identity as string;
    if (colorId) {
      const parsed = JSON.parse(colorId) as string[];
      for (const c of parsed) {
        colors.set(c, (colors.get(c) || 0) + 1);
      }
    }
  }

  // Infer color pair for each deck
  const pairCounts = new Map<string, number>();
  for (const colors of deckColors.values()) {
    const pair = inferDeckColor(colors);
    pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
  }

  const totalDecks = deckColors.size;
  const threshold = totalDecks * 0.1;

  // Sort by count descending, filter to ≥10%, cap at 3
  return Array.from(pairCounts.entries())
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([colorPair, deckCount]) => ({
      colorPair,
      percentage: Math.round((deckCount / totalDecks) * 100),
      deckCount,
    }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/stats/colorPairBreakdown.test.ts`
Expected: PASS — all tests. Fix any mock alignment issues.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/stats/colorPairBreakdown.ts src/core/db/queries/stats/colorPairBreakdown.test.ts
git commit -m "feat: add color pair breakdown query"
```

---

### Task 5: Pick History and Distribution Query

**Files:**
- Create: `src/core/db/queries/stats/pickHistory.ts`
- Create: `src/core/db/queries/stats/pickHistory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/core/db/queries/stats/pickHistory.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPickHistory } from "./pickHistory";

vi.mock("../../client", () => ({
  getDb: vi.fn(),
}));

describe("getPickHistory", () => {
  let mockDb: { execute: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockDb = { execute: vi.fn() };
    const { getDb } = await import("../../client");
    (getDb as any).mockReturnValue(mockDb);
  });

  it("returns per-draft pick positions ordered by date", async () => {
    mockDb.execute.mockResolvedValue({
      rows: [
        { draft_id: "d1", draft_name: "Tarkir", draft_date: "2026-01-15", pick_n: 12, pool_size: 540 },
        { draft_id: "d2", draft_name: "Innistrad", draft_date: "2026-02-01", pick_n: 5, pool_size: 540 },
      ],
    });

    const result = await getPickHistory("Lightning Bolt");
    expect(result.pickHistory).toEqual([
      { draftId: "d1", draftName: "Tarkir", draftDate: "2026-01-15", pickPosition: 12, picked: true },
      { draftId: "d2", draftName: "Innistrad", draftDate: "2026-02-01", pickPosition: 5, picked: true },
    ]);
  });

  it("marks unpicked cards with poolSize as position", async () => {
    mockDb.execute.mockResolvedValue({
      rows: [
        { draft_id: "d1", draft_name: "Tarkir", draft_date: "2026-01-15", pick_n: null, pool_size: 540 },
      ],
    });

    const result = await getPickHistory("Unplayed Card");
    expect(result.pickHistory[0].picked).toBe(false);
    expect(result.pickHistory[0].pickPosition).toBe(540);
  });

  it("computes 15-bucket pick distribution", async () => {
    mockDb.execute.mockResolvedValue({
      rows: [
        { draft_id: "d1", draft_name: "A", draft_date: "2026-01-01", pick_n: 5, pool_size: 540 },
        { draft_id: "d2", draft_name: "B", draft_date: "2026-01-02", pick_n: 35, pool_size: 540 },
        { draft_id: "d3", draft_name: "C", draft_date: "2026-01-03", pick_n: 8, pool_size: 540 },
      ],
    });

    const result = await getPickHistory("Some Card");
    expect(result.pickDistribution).toHaveLength(15);
    // Bucket 0 (picks 1-30): 2 entries (pick 5, pick 8)
    expect(result.pickDistribution[0]).toBe(2);
    // Bucket 1 (picks 31-60): 1 entry (pick 35)
    expect(result.pickDistribution[1]).toBe(1);
  });

  it("returns empty results for card with no history", async () => {
    mockDb.execute.mockResolvedValue({ rows: [] });
    const result = await getPickHistory("Unknown Card");
    expect(result.pickHistory).toEqual([]);
    expect(result.pickDistribution).toEqual(Array(15).fill(0));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/stats/pickHistory.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the pick history query**

Create `src/core/db/queries/stats/pickHistory.ts`. Takes `Client` param. Uses correct column names: `drafts.draft_id`, `drafts.draft_name`, `drafts.draft_date`, `drafts.cube_snapshot_id`. Pool cards are in `cube_snapshot_cards` (not `cube_cards`). Pick events join on `card_id` (integer FK):

```typescript
import type { Client } from "@libsql/client";

const DISTRIBUTION_BUCKET_COUNT = 15;
const DISTRIBUTION_BUCKET_SIZE = 30;

export type PickHistoryEntry = {
  draftId: string;
  draftName: string;
  draftDate: string;
  pickPosition: number;
  picked: boolean;
};

export type PickHistoryResult = {
  pickHistory: PickHistoryEntry[];
  pickDistribution: number[];
};

function getDistributionBucket(pickPosition: number): number {
  return Math.min(
    Math.floor((pickPosition - 1) / DISTRIBUTION_BUCKET_SIZE),
    DISTRIBUTION_BUCKET_COUNT - 1
  );
}

/**
 * Get per-draft pick positions and distribution for a card.
 * Includes drafts where the card was in the pool but not picked.
 */
export async function getPickHistory(
  client: Client,
  cardName: string,
  draftId?: string
): Promise<PickHistoryResult> {
  const draftFilter = draftId ? "AND d.draft_id = ?" : "";
  const args: string[] = [cardName];
  if (draftId) args.push(draftId);

  // Left join pick_events to include drafts where card was in pool but not picked.
  // cube_snapshot_cards stores the card pool for each draft's cube snapshot.
  // pick_events uses card_id (FK to cards table), so we join through cards for name matching.
  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date,
                 pe.pick_n,
                 (SELECT COUNT(*) FROM cube_snapshot_cards cs2
                  WHERE cs2.cube_id = d.cube_snapshot_id) AS pool_size
          FROM drafts d
          JOIN cube_snapshot_cards cs ON cs.cube_id = d.cube_snapshot_id
            AND cs.card_name = ?
          LEFT JOIN cards c ON c.name = cs.card_name
          LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = c.card_id
          WHERE d.phase IS NOT NULL ${draftFilter}
          ORDER BY d.draft_date ASC`,
    args,
  });

  if (result.rows.length === 0) {
    return { pickHistory: [], pickDistribution: Array(DISTRIBUTION_BUCKET_COUNT).fill(0) };
  }

  const pickHistory: PickHistoryEntry[] = [];
  const distribution = Array(DISTRIBUTION_BUCKET_COUNT).fill(0);

  for (const row of result.rows) {
    const picked = row.pick_n !== null;
    const poolSize = row.pool_size as number;
    const pickPosition = picked ? (row.pick_n as number) : poolSize;

    pickHistory.push({
      draftId: row.draft_id as string,
      draftName: row.draft_name as string,
      draftDate: row.draft_date as string,
      pickPosition,
      picked,
    });

    const bucket = getDistributionBucket(pickPosition);
    distribution[bucket]++;
  }

  return { pickHistory, pickDistribution: distribution };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/stats/pickHistory.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/stats/pickHistory.ts src/core/db/queries/stats/pickHistory.test.ts
git commit -m "feat: add pick history and distribution query for stats modal"
```

---

### Task 6: Expand `/api/cards/stats` Response

**Files:**
- Modify: `src/core/db/queries/stats/cardStats.ts` — add new fields to `CardStatsResult` and query
- Modify: `src/app/api/cards/stats/route.ts` — pass through new fields

- [ ] **Step 1: Update `CardStatsResult` type in `cardStats.ts`**

Add new fields to the type at line ~57 in `src/core/db/queries/stats/cardStats.ts`:

```typescript
// Add after the existing wins field:
pick_history: PickHistoryEntry[];
pick_distribution: number[];
color_pair_breakdown: ColorPairEntry[];
```

Add imports at top:
```typescript
import { getPickHistory, type PickHistoryEntry } from "./pickHistory";
import { getColorPairBreakdown, type ColorPairEntry } from "./colorPairBreakdown";
```

- [ ] **Step 2: Update `getCardStats()` to fetch new data**

In the `getCardStats()` function, after the parallel fetch of pick stats and win stats (~line 82-96), add the new queries. Note: `getCardStats` already receives a `client` parameter — pass it through:

```typescript
// Run in parallel with existing queries
const [pickStats, winStats, historyResult, colorPairs] = await Promise.all([
  getCardPickStats(client, { card_name: resolved.name, ...filters }),
  getCardWinStats(client, { card_name: resolved.name, card_id: resolved.id, ...filters }),
  getPickHistory(client, resolved.name, params.draft_id),
  getColorPairBreakdown(client, resolved.name, params.draft_id),
]);
```

Add to the return object:
```typescript
pick_history: historyResult.pickHistory,
pick_distribution: historyResult.pickDistribution,
color_pair_breakdown: colorPairs,
```

- [ ] **Step 3: Update existing card stats tests**

Modify `src/app/api/cards/stats/route.test.ts` to expect the new fields in successful responses. The mock for `getCardStats` should include the new fields.

- [ ] **Step 4: Run all stats-related tests**

Run: `pnpm test src/core/db/queries/stats/ src/app/api/cards/stats/`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/stats/cardStats.ts src/app/api/cards/stats/route.ts src/app/api/cards/stats/route.test.ts
git commit -m "feat: expand card stats API with pick history, distribution, and color pairs"
```

---

### Task 7: Auto-Pick Mode — Schema, Queries, and API

**Files:**
- Modify: `src/core/db/queries/seatTokens.ts` — add `updateAutoPickMode`, return mode from settings
- Modify: `src/core/db/queries/seatTokens.test.ts` — test new function
- Modify: `src/app/api/drafts/[id]/seat-settings/route.ts` — accept `autoPickMode`
- Modify: `src/app/api/drafts/[id]/seat-settings/route.test.ts` — test new param
- Modify: `src/app/api/drafts/[id]/me/route.ts` — return `autoPickMode`
- Modify: `src/app/api/drafts/[id]/me/route.test.ts` — test new field

- [ ] **Step 1: Add `updateAutoPickMode` to seatTokens queries**

In `src/core/db/queries/seatTokens.ts`, add a new function:

```typescript
export async function updateAutoPickMode(
  draftId: string,
  seat: number,
  mode: "resilient" | "cautious"
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE seat_tokens SET auto_pick_mode = ? WHERE draft_id = ? AND seat = ?`,
    args: [mode, draftId, seat],
  });
}
```

Update `getSeatSettings()` to include `auto_pick_mode` in its SELECT and return value.

- [ ] **Step 2: Write tests for the new query**

Add test cases in `src/core/db/queries/seatTokens.test.ts` for `updateAutoPickMode`.

- [ ] **Step 3: Update seat-settings route to accept `autoPickMode`**

In `src/app/api/drafts/[id]/seat-settings/route.ts`, add handling after the existing `auto_pick` check (~line 22):

```typescript
if (body.auto_pick_mode !== undefined) {
  if (!["resilient", "cautious"].includes(body.auto_pick_mode)) {
    return NextResponse.json({ error: "auto_pick_mode must be 'resilient' or 'cautious'" }, { status: 400 });
  }
  await updateAutoPickMode(auth.draftId, auth.seat, body.auto_pick_mode);
}
```

Update the response to include `autoPickMode`.

- [ ] **Step 4: Update /me route to return `autoPickMode`**

In `src/app/api/drafts/[id]/me/route.ts`, add `autoPickMode` to the response object (from the settings query).

- [ ] **Step 5: Update tests for both routes**

Update `src/app/api/drafts/[id]/seat-settings/route.test.ts` and `src/app/api/drafts/[id]/me/route.test.ts`.

- [ ] **Step 6: Run all affected tests**

Run: `pnpm test src/core/db/queries/seatTokens.test.ts src/app/api/drafts/[id]/seat-settings/ src/app/api/drafts/[id]/me/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/db/queries/seatTokens.ts src/core/db/queries/seatTokens.test.ts \
  src/app/api/drafts/[id]/seat-settings/route.ts src/app/api/drafts/[id]/seat-settings/route.test.ts \
  src/app/api/drafts/[id]/me/route.ts src/app/api/drafts/[id]/me/route.test.ts
git commit -m "feat: add auto-pick mode (resilient/cautious) to seat settings and /me"
```

---

### Task 8: Auto-Pick Cascade — Cautious Mode

**Files:**
- Modify: `src/core/processPick.ts` — add queue invalidation check and cautious pause
- Modify: `src/core/processPick.test.ts` — test cautious behavior
- Modify: `src/core/db/queries/pickQueue.ts` — add `getQueuesContainingCard()`

- [ ] **Step 1: Add `getQueuesContainingCard()` to pickQueue.ts**

In `src/core/db/queries/pickQueue.ts`, add. Note: follows existing pattern — takes `Client` as first param:

```typescript
/**
 * Find all seats that have a specific card in their queue.
 * Used to detect queue invalidation when a card is picked.
 * MUST be called BEFORE removeCardFromAllQueues for the same card.
 */
export async function getQueuesContainingCard(
  client: Client,
  draftId: string,
  cardId: number
): Promise<Array<{ seat: number }>> {
  const result = await client.execute({
    sql: `SELECT DISTINCT st.seat
          FROM pick_queue pq
          JOIN seat_tokens st ON st.draft_id = pq.draft_id AND st.seat = pq.seat
          WHERE pq.draft_id = ? AND pq.card_id = ?`,
    args: [draftId, cardId],
  });
  return result.rows.map((row) => ({ seat: row.seat as number }));
}
```

- [ ] **Step 2: Write tests for cautious mode in processPick**

Add test cases in `src/core/processPick.test.ts`:

```typescript
describe("cautious auto-pick mode", () => {
  it("pauses auto-pick when a queued card is taken and mode is cautious", async () => {
    // Setup: seat 2 has Lightning Bolt queued, mode is 'cautious'
    // Action: seat 1 picks Lightning Bolt
    // Expected: seat 2's auto_pick set to 0
  });

  it("does not pause auto-pick when mode is resilient", async () => {
    // Setup: seat 2 has Lightning Bolt queued, mode is 'resilient'
    // Action: seat 1 picks Lightning Bolt
    // Expected: seat 2's auto_pick remains 1
  });
});
```

- [ ] **Step 3: Update processPick cascade logic**

In `src/core/processPick.ts`, add the queue invalidation check BEFORE the existing `removeCardFromAllQueues()` call (~line 98-99). This order matters — `removeCardFromAllQueues` deletes the card from all queues, so we must detect affected seats first. The `processPick` function already has a `client` parameter available:

```typescript
// BEFORE removeCardFromAllQueues — detect affected seats for cautious mode
const affectedSeats = await getQueuesContainingCard(client, input.draftId, currentCardId);
for (const { seat: affectedSeat } of affectedSeats) {
  if (affectedSeat === input.seat) continue; // skip the picker
  const settings = await getSeatSettings(client, input.draftId, affectedSeat);
  if (settings?.auto_pick_mode === "cautious") {
    await updateAutoPick(client, input.draftId, affectedSeat, false);
  }
}

// THEN remove from all queues (existing line)
await removeCardFromAllQueues(client, input.draftId, currentCardId);
```

Note: `getSeatSettings` must be updated in Task 7 to return `auto_pick_mode` before this code will work. Task ordering handles this dependency.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/processPick.test.ts src/core/db/queries/pickQueue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/processPick.ts src/core/processPick.test.ts src/core/db/queries/pickQueue.ts
git commit -m "feat: add cautious auto-pick mode — pause on queue invalidation"
```

---

### Task 9: Queue Unqueue → Float Promotion

**Files:**
- Modify: `src/app/api/drafts/[id]/queue/route.ts` — auto-create float rows when cards removed from queue

- [ ] **Step 1: Update queue PUT to auto-float removed cards**

In `src/app/api/drafts/[id]/queue/route.ts`, in the PUT handler, after setting the queue:

1. Compare old queue to new queue to find removed cards
2. For each removed card, call `addFloatedCard()` to auto-promote to float

```typescript
// Before setting new queue, get the old queue
const oldQueue = await getQueue(auth.draftId, auth.seat);
const oldCardNames = oldQueue.map((q) => q.cardName);

// Set the new queue
await setQueue(auth.draftId, auth.seat, resolvedIds);

// Auto-float any cards that were removed from the queue
const newCardNames = new Set(body.queue);
for (const oldName of oldCardNames) {
  if (!newCardNames.has(oldName)) {
    await addFloatedCard(auth.draftId, auth.seat, oldName);
  }
}
```

- [ ] **Step 2: Add test for auto-float on unqueue**

Add test in `src/app/api/drafts/[id]/queue/route.test.ts`.

- [ ] **Step 3: Run tests**

Run: `pnpm test src/app/api/drafts/[id]/queue/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/drafts/[id]/queue/route.ts src/app/api/drafts/[id]/queue/route.test.ts
git commit -m "feat: auto-float cards when removed from queue"
```

---

## Chunk 2: `getCards()` Refactor and Card Table Slimming

### Task 10: Slim `calculateStats` and `getCards()`

**Files:**
- Modify: `src/core/calculateStats.ts` — remove `pickDistribution`, `scoreHistory` from `CardStats`
- Modify: `src/core/calculateStats.test.ts` — update assertions
- Modify: `src/core/getCards.ts` — remove `decklistWinRate`, `totalPicks`, `timesUnpicked` from pipeline

- [ ] **Step 1: Update `CardStats` type in `calculateStats.ts`**

Remove the following fields from the `CardStats` type (referenced in `calculateSingleCardStats` return):
- `pickDistribution: number[]`
- `scoreHistory: DraftScore[]`
- `totalPicks: number`
- `timesUnpicked: number`

Keep: `cardName`, `weightedGeomean`, `colors`, `maxCopiesInDraft`, `timesAvailable`, `draftsPickedIn`.

Remove the computation code for `scoreHistory` (~lines 86-144) and `pickDistribution` (~lines 146-151) from `calculateSingleCardStats()`.

- [ ] **Step 2: Update calculateStats tests**

In `src/core/calculateStats.test.ts`, remove assertions for `pickDistribution`, `scoreHistory`, `totalPicks`, `timesUnpicked`. The tests should still verify `weightedGeomean`, `colors`, `maxCopiesInDraft`, `timesAvailable`, `draftsPickedIn`.

- [ ] **Step 3: Run calculateStats tests**

Run: `pnpm test src/core/calculateStats.test.ts`
Expected: PASS.

- [ ] **Step 4: Update `getCards()` pipeline**

In `src/core/getCards.ts`:
- Remove the call to `loadDecklistWinRates()` (~line 558 area) and the function itself
- Remove `decklistWinRate` from the `EnrichedCardStats` assembly
- Remove the related types/interfaces if they become unused

The `EnrichedCardStats` type should now only contain: `cardName`, `weightedGeomean`, `colors`, `maxCopiesInDraft`, `timesAvailable`, `draftsPickedIn`, `scryfall`.

- [ ] **Step 5: Fix type errors across the codebase**

Run: `pnpm typecheck`

Likely breakages:
- `CardTable.tsx` — references to removed columns (will be fixed in Task 11)
- `Sparkline.tsx` — used by card table (no longer needed in table context)
- `DistributionHistogram.tsx` — used by card table (no longer needed in table context)
- `PageClient.tsx` — may reference win rate data

Fix TypeScript errors by removing references to deleted fields. Components that only existed for table stats display can have their imports removed.

- [ ] **Step 6: Run full test suite**

Run: `pnpm test`
Expected: PASS (some tests may need updates for removed fields).

- [ ] **Step 7: Commit**

```bash
git add src/core/calculateStats.ts src/core/calculateStats.test.ts src/core/getCards.ts \
  src/app/components/CardTable.tsx src/app/components/PageClient.tsx
git commit -m "refactor: slim getCards pipeline — remove stats now served by modal API"
```

Note: exact files may vary — add all files with changes from this task. Prefer specific file adds over `git add -A`.

---

### Task 11: Card Table Column Removal and Row Click

**Files:**
- Modify: `src/app/components/CardTable.tsx` — remove stat columns, add row click handler, update breakpoints

- [ ] **Step 1: Remove stat column definitions**

In `src/app/components/CardTable.tsx`, remove column definitions for:
- Distribution histogram (~lines 244-249)
- Decklist win rate / GPWR (~lines 250-291)
- History sparkline (~lines 292-299)
- Times picked (~lines 300-314)

Keep: card name, mana cost, type, colors, pick score.

- [ ] **Step 2: Update column visibility for breakpoints**

Update the `columnVisibility` useMemo (~lines 129-141):

```typescript
const columnVisibility: VisibilityState = useMemo(() => {
  const showSm = breakpoint !== "mobile";
  const isDesktopOrWider = breakpoint === "desktop" || breakpoint === "wide";
  return {
    manaCost: showSm,
    type: isDesktopOrWider,
    colors: showSm,
  };
}, [breakpoint]);
```

Desktop and wide now show the same columns.

- [ ] **Step 3: Add row click handler**

Add an `onCardClick` prop to `CardTableProps`:

```typescript
onCardClick?: (cardName: string) => void;
```

In the row rendering (~line 400 area), add an onClick handler:

```typescript
<tr
  key={row.id}
  onClick={() => props.onCardClick?.(row.original.cardName)}
  style={{ cursor: props.onCardClick ? "pointer" : undefined }}
  // ... existing props
>
```

- [ ] **Step 4: Remove unused imports**

Remove imports for `DistributionHistogram`, `Sparkline`, and any win-rate formatting utilities that are no longer used by the table.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "refactor: slim card table — remove stat columns, add row click"
```

---

### Task 12: CardNameCell — Replace Action Icons with Status Icon

**Files:**
- Create: `src/app/components/CardStatusIcon.tsx`
- Modify: `src/app/components/CardNameCell.tsx` — strip action icons, add status icon

- [ ] **Step 1: Create CardStatusIcon component**

Create `src/app/components/CardStatusIcon.tsx`:

```typescript
type CardStatus = "picked" | "queued" | "floated" | "none";

type CardStatusIconProps = {
  status: CardStatus;
  queuePosition?: number;
};

export function CardStatusIcon({ status, queuePosition }: CardStatusIconProps) {
  switch (status) {
    case "picked":
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 text-green-500" title="Picked">
          <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        </span>
      );
    case "queued":
      return (
        <span
          className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[9px] font-bold"
          title={`Queue position ${queuePosition}`}
        >
          {queuePosition}
        </span>
      );
    case "floated":
      return (
        <span className="inline-flex items-center justify-center w-4 h-4 text-gray-400" title="Floated">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-3 h-3">
            <path d="M3 2.5h10l-1.5 5H4.5L3 2.5zM4.5 7.5v5.5M11.5 7.5v5.5" />
          </svg>
        </span>
      );
    case "none":
      return null;
  }
}
```

- [ ] **Step 2: Update CardNameCell to use CardStatusIcon**

In `src/app/components/CardNameCell.tsx`:
1. Remove the `PickButton`, `DeckIcon`, `RemoveIcon` components and all pick/queue/deck-builder icon logic (~lines 135-224)
2. Add a `cardStatus` and `queuePosition` prop
3. Render `<CardStatusIcon>` next to the card name

The component becomes much simpler — just: card name + status icon + image preview on hover.

- [ ] **Step 3: Update CardNameCell props**

Strip props that are no longer needed: `onPick`, `onQueue`, `queuedCards`, `isMyTurn`, `speculativeCards`, `onAddSpeculative`, `onRemoveSpeculative`, `isInDeckBuilder`, `isSeatCard`, `activeDraft`, `token`, `mySeat`.

Add: `cardStatus: "picked" | "queued" | "floated" | "none"`, `queuePosition?: number`.

- [ ] **Step 4: Run typecheck to find and fix all breakages**

Run: `pnpm typecheck`
Fix all callers of `CardNameCell` (primarily `CardTable.tsx`) to pass the new props.

- [ ] **Step 5: Run lint and knip**

Run: `pnpm lint && pnpm knip`
Remove any now-unused exports or imports detected by knip.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardStatusIcon.tsx src/app/components/CardNameCell.tsx src/app/components/CardTable.tsx
git commit -m "refactor: replace card table action icons with single status icon"
```

---

## Chunk 3: Card Stats Modal and Hold-to-Pick

### Task 13: `useHoldToConfirm` Hook

**Files:**
- Create: `src/app/hooks/useHoldToConfirm.ts`
- Create: `src/app/hooks/useHoldToConfirm.test.ts`

- [ ] **Step 1: Write failing tests for the hold gesture hook**

Create `src/app/hooks/useHoldToConfirm.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoldToConfirm } from "./useHoldToConfirm";

describe("useHoldToConfirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onConfirm after holding for the full duration", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    act(() => result.current.handlers.onPointerDown({} as PointerEvent));
    expect(result.current.progress).toBe(0);

    act(() => vi.advanceTimersByTime(1500));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resets on early release", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    act(() => result.current.handlers.onPointerDown({} as PointerEvent));
    act(() => vi.advanceTimersByTime(500));
    act(() => result.current.handlers.onPointerUp());

    expect(onConfirm).not.toHaveBeenCalled();
    expect(result.current.isHolding).toBe(false);
  });

  it("exposes progress as 0-1 value", () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    act(() => result.current.handlers.onPointerDown({} as PointerEvent));
    // Progress is animated via requestAnimationFrame, tested via integration
    expect(result.current.isHolding).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useHoldToConfirm.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the hold gesture hook**

Create `src/app/hooks/useHoldToConfirm.ts`:

```typescript
import { useCallback, useRef, useState } from "react";

type UseHoldToConfirmOptions = {
  onConfirm: () => void;
  duration?: number; // ms, default 1500
};

export function useHoldToConfirm({ onConfirm, duration = 1500 }: UseHoldToConfirmOptions) {
  const [isHolding, setIsHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const confirmedRef = useRef(false);

  const animate = useCallback(() => {
    if (!startTimeRef.current) return;
    const elapsed = Date.now() - startTimeRef.current;
    const pct = Math.min(elapsed / duration, 1);
    setProgress(pct);

    if (pct >= 1 && !confirmedRef.current) {
      confirmedRef.current = true;
      // Haptic feedback (progressive enhancement)
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        navigator.vibrate(50);
      }
      onConfirm();
      return;
    }

    rafRef.current = requestAnimationFrame(animate);
  }, [duration, onConfirm]);

  const start = useCallback(() => {
    confirmedRef.current = false;
    startTimeRef.current = Date.now();
    setIsHolding(true);
    setProgress(0);
    rafRef.current = requestAnimationFrame(animate);
  }, [animate]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    startTimeRef.current = null;
    setIsHolding(false);
    setProgress(0);
  }, []);

  const handlers = {
    onPointerDown: (e: React.PointerEvent | PointerEvent) => {
      // Prevent text selection during hold
      if ("preventDefault" in e) e.preventDefault();
      start();
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    // Keyboard accessibility
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === "Enter" || e.key === " ") && !isHolding) {
        e.preventDefault();
        start();
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        stop();
      }
    },
  };

  return { isHolding, progress, handlers };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/hooks/useHoldToConfirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useHoldToConfirm.ts src/app/hooks/useHoldToConfirm.test.ts
git commit -m "feat: add useHoldToConfirm hook with pointer and keyboard support"
```

---

### Task 14: HoldToPickButton Component

**Files:**
- Create: `src/app/components/HoldToPickButton.tsx`
- Create: `src/app/components/HoldToPickButton.test.tsx`

- [ ] **Step 1: Write failing tests**

Create `src/app/components/HoldToPickButton.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { HoldToPickButton } from "./HoldToPickButton";

describe("HoldToPickButton", () => {
  it("renders with 'Hold to Pick' label", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
  });

  it("has green background styling", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-green");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/components/HoldToPickButton.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/app/components/HoldToPickButton.tsx`:

```typescript
import { useHoldToConfirm } from "@/app/hooks/useHoldToConfirm";

type HoldToPickButtonProps = {
  onPick: () => void;
  disabled?: boolean;
};

export function HoldToPickButton({ onPick, disabled }: HoldToPickButtonProps) {
  const { isHolding, progress, handlers } = useHoldToConfirm({
    onConfirm: onPick,
    duration: 1500,
  });

  return (
    <button
      className={`relative overflow-hidden w-full rounded-lg py-3.5 text-center font-bold text-base text-white
        ${disabled ? "bg-gray-600 cursor-not-allowed" : "bg-green-700 hover:bg-green-600 cursor-pointer"}
        transition-colors select-none touch-none`}
      disabled={disabled}
      {...(disabled ? {} : handlers)}
      role="button"
      aria-label="Hold to pick this card"
    >
      {/* Progress bar fill */}
      <div
        className="absolute inset-0 bg-green-500 transition-none"
        style={{
          width: `${progress * 100}%`,
          opacity: isHolding ? 0.4 : 0,
        }}
      />
      <span className="relative z-10">
        {isHolding ? "Picking..." : "Hold to Pick"}
      </span>
    </button>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/components/HoldToPickButton.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/HoldToPickButton.tsx src/app/components/HoldToPickButton.test.tsx
git commit -m "feat: add HoldToPickButton component with progress bar"
```

---

### Task 15: `useCardStats` Hook

**Files:**
- Create: `src/app/hooks/useCardStats.ts`

- [ ] **Step 1: Implement the hook**

Create `src/app/hooks/useCardStats.ts`:

```typescript
import { useState, useEffect } from "react";

type CardStatsData = {
  pick: { drafts_in_pool: number; times_picked: number; avg_pick: number; median_pick: number; geomean_pick: number };
  play?: { times_drafted: number; times_maindecked: number; play_rate: number };
  wins?: { game_wins: number; game_losses: number; win_rate: number; win_rate_ci: { lower: number; center: number; upper: number }; low_sample: boolean; drafts_with_data: number };
  pick_history: Array<{ draftId: string; draftName: string; draftDate: string; pickPosition: number; picked: boolean }>;
  pick_distribution: number[];
  color_pair_breakdown: Array<{ colorPair: string; percentage: number; deckCount: number }>;
};

export function useCardStats(cardName: string | null, draftId?: string) {
  const [data, setData] = useState<CardStatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cardName) {
      setData(null);
      return;
    }

    setLoading(true);
    setError(null);

    const params = new URLSearchParams({ card_name: cardName });
    if (draftId) params.set("draft_id", draftId);

    fetch(`/api/cards/stats?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [cardName, draftId]);

  return { data, loading, error };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/hooks/useCardStats.ts
git commit -m "feat: add useCardStats hook for on-demand stats fetching"
```

---

### Task 16: `useFloatedCards` Hook

**Files:**
- Create: `src/app/hooks/useFloatedCards.ts`
- Create: `src/app/hooks/useFloatedCards.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/hooks/useFloatedCards.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFloatedCards } from "./useFloatedCards";

global.fetch = vi.fn();

describe("useFloatedCards", () => {
  it("fetches floated cards on mount", async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ cards: ["Lightning Bolt"] }),
    });

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token")
    );

    await waitFor(() => {
      expect(result.current.floatedCards).toEqual(["Lightning Bolt"]);
    });
  });

  it("provides addFloat that calls PUT and updates local state", async () => {
    (fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: [] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token")
    );

    await waitFor(() => expect(result.current.floatedCards).toEqual([]));

    await act(async () => {
      await result.current.addFloat("Counterspell");
    });

    expect(result.current.floatedCards).toContain("Counterspell");
  });

  it("provides removeFloat that calls DELETE and updates local state", async () => {
    (fetch as any)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ cards: ["Bolt"] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token")
    );

    await waitFor(() => expect(result.current.floatedCards).toEqual(["Bolt"]));

    await act(async () => {
      await result.current.removeFloat("Bolt");
    });

    expect(result.current.floatedCards).not.toContain("Bolt");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useFloatedCards.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the hook**

Create `src/app/hooks/useFloatedCards.ts`:

```typescript
import { useState, useEffect, useCallback } from "react";

export function useFloatedCards(draftId: string | null, token: string | null) {
  const [floatedCards, setFloatedCards] = useState<string[]>([]);

  useEffect(() => {
    if (!draftId || !token) return;

    fetch(`/api/drafts/${draftId}/float`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.cards) setFloatedCards(data.cards);
      });
  }, [draftId, token]);

  const addFloat = useCallback(async (cardName: string) => {
    if (!draftId || !token) return;
    await fetch(`/api/drafts/${draftId}/float`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ card_name: cardName }),
    });
    setFloatedCards((prev) => [...prev, cardName]);
  }, [draftId, token]);

  const removeFloat = useCallback(async (cardName: string) => {
    if (!draftId || !token) return;
    await fetch(`/api/drafts/${draftId}/float`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ card_name: cardName }),
    });
    setFloatedCards((prev) => prev.filter((c) => c !== cardName));
  }, [draftId, token]);

  return { floatedCards, addFloat, removeFloat };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/hooks/useFloatedCards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useFloatedCards.ts src/app/hooks/useFloatedCards.test.ts
git commit -m "feat: add useFloatedCards hook for server-side float state"
```

---

### Task 17: CardStatsModal Component

**Files:**
- Create: `src/app/components/CardStatsModal.tsx`
- Create: `src/app/components/CardStatsModal.test.tsx`

This is the largest component. It combines: card image, stats display, and action buttons (hold-to-pick, queue, float).

- [ ] **Step 1: Write failing tests**

Create `src/app/components/CardStatsModal.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CardStatsModal } from "./CardStatsModal";

// Mock the hooks
vi.mock("@/app/hooks/useCardStats", () => ({
  useCardStats: vi.fn(() => ({
    data: {
      pick: { drafts_in_pool: 5, times_picked: 4, geomean_pick: 12.4 },
      pick_history: [],
      pick_distribution: Array(15).fill(0),
      color_pair_breakdown: [{ colorPair: "RW", percentage: 55, deckCount: 3 }],
    },
    loading: false,
    error: null,
  })),
}));

describe("CardStatsModal", () => {
  const defaultProps = {
    cardName: "Lightning Bolt",
    scryfallImageUrl: "https://cards.scryfall.io/normal/front/bolt.jpg",
    isOpen: true,
    onClose: vi.fn(),
  };

  it("renders card image when open", () => {
    render(<CardStatsModal {...defaultProps} />);
    const img = screen.getByRole("img");
    expect(img).toBeTruthy();
  });

  it("shows pick score", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.getByText(/12\.4/)).toBeTruthy();
  });

  it("shows color pair breakdown pills", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.getByText(/55%/)).toBeTruthy();
  });

  it("does not render when isOpen is false", () => {
    render(<CardStatsModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows action buttons during live draft when it is user's turn", () => {
    render(
      <CardStatsModal
        {...defaultProps}
        isLiveDraft
        isMyTurn
        onPick={vi.fn()}
        onQueue={vi.fn()}
        onFloat={vi.fn()}
        cardStatus="none"
      />
    );
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.getByText("Float")).toBeTruthy();
  });

  it("shows no action buttons for historical drafts", () => {
    render(<CardStatsModal {...defaultProps} />);
    expect(screen.queryByText("Hold to Pick")).toBeNull();
    expect(screen.queryByText("Queue")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/components/CardStatsModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement CardStatsModal**

Create `src/app/components/CardStatsModal.tsx`. The component structure:

```typescript
import { useEffect } from "react";
import Image from "next/image";
import { useCardStats } from "@/app/hooks/useCardStats";
import { HoldToPickButton } from "./HoldToPickButton";
import { DistributionHistogram } from "./DistributionHistogram";
import { Sparkline } from "./Sparkline";

type CardStatus = "picked" | "queued" | "floated" | "none" | "taken";

type CardStatsModalProps = {
  cardName: string | null;
  scryfallImageUrl?: string;
  isOpen: boolean;
  onClose: () => void;
  draftId?: string;
  // Live draft action props (all optional — absent means stats-only)
  isLiveDraft?: boolean;
  isMyTurn?: boolean;
  cardStatus?: CardStatus;
  queuePosition?: number;
  onPick?: () => void;
  onQueue?: () => void;
  onUnqueue?: () => void;
  onFloat?: () => void;
  onUnfloat?: () => void;
  isLocal?: boolean; // for GPWR display
};

export function CardStatsModal(props: CardStatsModalProps) {
  const { cardName, isOpen, onClose, draftId, isLocal } = props;
  const { data, loading } = useCardStats(isOpen ? cardName : null, draftId);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  if (!isOpen || !cardName) return null;

  // Determine which action buttons to show
  const showActions = props.isLiveDraft && props.cardStatus !== "taken" && props.cardStatus !== "picked";

  return (
    // Backdrop
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      {/* Modal container — prevent close on inner click */}
      <div
        className="bg-gray-900 rounded-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Responsive layout: side-by-side ≥640px, stacked <640px */}
        <div className="flex flex-col sm:flex-row gap-5 p-5">
          {/* Left / Top: Card image + actions */}
          <div className="flex-shrink-0 sm:w-[220px]">
            {props.scryfallImageUrl && (
              <Image
                src={props.scryfallImageUrl}
                alt={cardName}
                width={220}
                height={308}
                className="rounded-lg w-[180px] sm:w-[220px] mx-auto"
              />
            )}
            {showActions && (
              <div className="mt-3 flex flex-col gap-2">
                {renderActionButtons(props)}
              </div>
            )}
          </div>

          {/* Right / Bottom: Stats */}
          <div className="flex-1 min-w-0">
            {loading ? (
              <div className="text-gray-500 text-sm">Loading stats...</div>
            ) : data ? (
              <StatsContent data={data} isLocal={isLocal} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
```

`renderActionButtons()` checks `props.cardStatus` and renders the contextual buttons per spec Section 2. `StatsContent` renders the stat rows, color pair pills, histogram, and sparkline.

The full implementation should handle all card states (none, floated, queued, picked, taken) and show appropriate buttons. Use `DistributionHistogram` and `Sparkline` components (already exist) for the charts.

**Important: Sparkline interface change.** The existing `Sparkline` component takes `history: DraftScore[]` and an optional `draftTimeline?: string[]` prop (shared x-axis across all cards in the table). In the modal, we render one card at a time with `pickHistory` data from the stats API. Either:
- (a) Adapt `Sparkline` to accept the new `PickHistoryEntry[]` format, computing its own x-axis from `draftDate` fields, or
- (b) Create a `ModalSparkline` wrapper that transforms `PickHistoryEntry[]` into the existing `DraftScore[]` format.
Option (a) is cleaner. The Sparkline should accept either format or be refactored to a common interface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/components/CardStatsModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardStatsModal.tsx src/app/components/CardStatsModal.test.tsx
git commit -m "feat: add CardStatsModal with responsive layout and live draft actions"
```

---

## Chunk 4: Queue Panel, Integration, and Wiring

### Task 18: Queue Panel in Draft Board Modal

**Files:**
- Create: `src/app/components/draft-board/QueuePanel.tsx`
- Create: `src/app/components/draft-board/QueuePanel.test.tsx`
- Modify: `src/app/components/DraftBoardModal.tsx` — add queue panel

- [ ] **Step 1: Write failing tests for QueuePanel**

Create `src/app/components/draft-board/QueuePanel.test.tsx`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueuePanel } from "./QueuePanel";

describe("QueuePanel", () => {
  const defaultProps = {
    queue: [
      { cardName: "Lightning Bolt", position: 1 },
      { cardName: "Counterspell", position: 2 },
    ],
    autoPick: true,
    autoPickMode: "resilient" as const,
    onReorder: vi.fn(),
    onRemove: vi.fn(),
    onToggleAutoPick: vi.fn(),
    onChangeAutoPickMode: vi.fn(),
  };

  it("renders queued cards in order", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText("Lightning Bolt")).toBeTruthy();
    expect(screen.getByText("Counterspell")).toBeTruthy();
  });

  it("shows auto-pick toggle", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText(/Auto-pick/i)).toBeTruthy();
  });

  it("shows mode selector when auto-pick is on", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText(/Resilient/i)).toBeTruthy();
    expect(screen.getByText(/Cautious/i)).toBeTruthy();
  });

  it("hides mode selector when auto-pick is off", () => {
    render(<QueuePanel {...defaultProps} autoPick={false} />);
    expect(screen.queryByText(/Resilient/i)).toBeNull();
  });

  it("shows empty state when queue is empty", () => {
    render(<QueuePanel {...defaultProps} queue={[]} />);
    expect(screen.getByText(/empty/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/components/draft-board/QueuePanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement QueuePanel**

Create `src/app/components/draft-board/QueuePanel.tsx`:

```typescript
type QueueItem = {
  cardName: string;
  position: number;
  taken?: boolean; // for strike-through on sniped cards
};

type QueuePanelProps = {
  queue: QueueItem[];
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  onReorder: (queue: string[]) => void;
  onRemove: (cardName: string) => void;
  onToggleAutoPick: () => void;
  onChangeAutoPickMode: (mode: "resilient" | "cautious") => void;
};

export function QueuePanel(props: QueuePanelProps) {
  // Renders:
  // 1. Auto-pick toggle + mode selector (resilient/cautious)
  // 2. Ordered list of queued cards with:
  //    - Up/down reorder buttons
  //    - Remove button (×)
  //    - Strike-through if taken
  // 3. Empty state message if queue is empty

  // Reorder uses up/down buttons. Drag-to-reorder is a nice-to-have
  // but up/down buttons work on all devices and are simpler.
  // If drag is desired later, can add @dnd-kit.
}
```

Implement the full component with Tailwind styling matching the dark theme of the draft board modal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/components/draft-board/QueuePanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire QueuePanel into DraftBoardModal**

In `src/app/components/DraftBoardModal.tsx`, add the QueuePanel alongside the existing matrix and standings sections. It should be visible when the user has a seat token (is a participant).

- [ ] **Step 6: Commit**

```bash
git add src/app/components/draft-board/QueuePanel.tsx src/app/components/draft-board/QueuePanel.test.tsx \
  src/app/components/DraftBoardModal.tsx
git commit -m "feat: add queue panel with reordering and auto-pick settings to pod view"
```

---

### Task 19: Update `useMySeat` Hook

**Files:**
- Modify: `src/app/hooks/useMySeat.ts` — add `autoPickMode`, `updateAutoPickMode`
- Modify: `src/app/hooks/useMySeat.test.ts` — test new fields

- [ ] **Step 1: Add `autoPickMode` to the hook**

In `src/app/hooks/useMySeat.ts`:
1. Add `autoPickMode` state: `const [autoPickMode, setAutoPickMode] = useState<"resilient" | "cautious">("resilient");`
2. Set from /me response: `setAutoPickMode(data.autoPickMode || "resilient")`
3. Add `updateAutoPickMode` callback that PUTs to `/api/drafts/${draftId}/seat-settings` with `{ auto_pick_mode: mode }`
4. Include in return value

- [ ] **Step 2: Update tests**

Add test cases in `src/app/hooks/useMySeat.test.ts` for `autoPickMode` and `updateAutoPickMode`.

- [ ] **Step 3: Run tests**

Run: `pnpm test src/app/hooks/useMySeat.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/hooks/useMySeat.ts src/app/hooks/useMySeat.test.ts
git commit -m "feat: add autoPickMode to useMySeat hook"
```

---

### Task 20: Wire Everything Together in PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx` — integrate modal, float state, card status

This is the main integration task. `PageClient` is the top-level component that orchestrates the card table, deck builder, draft board, and now the card stats modal.

- [ ] **Step 1: Add modal state**

```typescript
const [selectedCard, setSelectedCard] = useState<string | null>(null);
```

- [ ] **Step 2: Add float hook**

```typescript
const { floatedCards, addFloat, removeFloat } = useFloatedCards(
  activeDraft?.id ?? null,
  token
);
```

- [ ] **Step 3: Compute card status for each card**

Create a helper function that determines each card's status:

```typescript
function getCardStatus(cardName: string): { status: CardStatus; queuePosition?: number } {
  // Check if picked by user (from picks data + mySeat)
  // Check if in queue (from queuedCards with position)
  // Check if floated (from floatedCards)
  // Check if taken by someone else
  // Return appropriate status
}
```

- [ ] **Step 4: Pass onCardClick to CardTable**

```typescript
<CardTable
  // ... existing props
  onCardClick={setSelectedCard}
/>
```

- [ ] **Step 5: Add CardStatsModal**

```typescript
<CardStatsModal
  cardName={selectedCard}
  scryfallImageUrl={getImageUrl(selectedCard)}
  isOpen={!!selectedCard}
  onClose={() => setSelectedCard(null)}
  draftId={activeDraft?.id}
  isLiveDraft={!!activeDraft?.isLiveDraft}
  isMyTurn={isMyTurn}
  cardStatus={selectedCard ? getCardStatus(selectedCard).status : "none"}
  queuePosition={selectedCard ? getCardStatus(selectedCard).queuePosition : undefined}
  onPick={() => { handlePick(selectedCard!); setSelectedCard(null); }}
  onQueue={() => handleQueue(selectedCard!)}
  onUnqueue={() => handleUnqueue(selectedCard!)}
  onFloat={() => addFloat(selectedCard!)}
  onUnfloat={() => removeFloat(selectedCard!)}
  isLocal={isLocal}
/>
```

- [ ] **Step 6: Update deck builder to use floated cards**

In `src/app/hooks/useDeckBuilder.ts`, the current `DeckState` type includes `speculativeCards` stored in localStorage (key format: `deckState:${draftId}:${seat}`). Replace this with the server-side float state:

1. Remove `speculativeCards` from the `DeckState` type and from localStorage persistence
2. In `PageClient.tsx`, merge `floatedCards` (from `useFloatedCards` hook) into the deck builder's card list alongside picked and queued cards
3. The deck builder dispatch actions that previously toggled speculative cards (`ADD_SPECULATIVE`, `REMOVE_SPECULATIVE`) should be removed — float/unfloat is now handled by the `useFloatedCards` hook's `addFloat`/`removeFloat` callbacks
4. Any component that checked `state.speculativeCards.includes(cardName)` should check the `floatedCards` array from the hook instead

- [ ] **Step 7: Run typecheck, lint, and knip**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Remove unused imports and dead code.

- [ ] **Step 8: Run full test suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/components/PageClient.tsx src/app/components/PageClient.test.tsx \
  src/app/hooks/useDeckBuilder.ts
git commit -m "feat: wire card stats modal, float state, and card status into page"
```

Note: exact files may vary — add all files modified in this task. Prefer specific file adds over `git add -A`.

---

### Task 21: Final Cleanup and Verification

**Files:** Various — remove dead code detected by knip

- [ ] **Step 1: Run knip to detect dead code**

Run: `pnpm knip`
Expected: May flag old speculative card types, removed column components, or unused exports.

- [ ] **Step 2: Remove dead code**

Remove any unused exports, types, or components flagged by knip. Likely candidates:
- Old `PickButton` component in `CardNameCell.tsx` (if not already removed)
- Old `DeckIcon` and `RemoveIcon` if only used by CardNameCell
- `speculativeCards` types/logic in deck builder (replaced by float API)
- Unused imports of removed stat types

- [ ] **Step 3: Run all quality checks**

Run: `pnpm precommit`
Expected: PASS — typecheck, lint, knip, tests, e2e all pass.

- [ ] **Step 4: Commit**

```bash
# Add all files cleaned up by knip — list specific files
git commit -m "chore: remove dead code from card table rework"
```

---

### Task 22: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` — add spec and plan references

- [ ] **Step 1: Add references to Superpowers Specs and Plans sections**

Add under Superpowers Specs:
```markdown
- `docs/superpowers/specs/2026-03-27-card-table-and-live-draft-ux-design.md` - Card table rework, stats modal, hold-to-pick, float state, queue management
```

Add under Superpowers Plans:
```markdown
- `docs/superpowers/plans/2026-03-27-card-table-and-live-draft-ux.md` - Card table and live draft UX implementation
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add card table UX spec and plan references to CLAUDE.md"
```
