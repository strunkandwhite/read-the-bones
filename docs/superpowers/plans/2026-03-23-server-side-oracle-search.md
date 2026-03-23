# Server-Side Oracle Search API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GET /api/cards/search` endpoint that accepts Scryfall-style queries and returns matching cards, with optional draft scoping and availability filtering.

**Architecture:** Extract `transformScryfallJson` to shared helpers. Add a new `search.ts` query module with three SQL paths (global, draft-scoped, available-only). The API route parses parameters, fetches cards from the DB, converts to `ScryCard[]`, runs `searchLocalCards()`, and maps results to snake_case JSON.

**Tech Stack:** Next.js API routes, Turso/libsql, existing `localSearch.ts` parser

**Spec:** `docs/superpowers/specs/2026-03-23-server-side-oracle-search-design.md`

---

## Chunk 1: Extract shared helper + query module

### Task 1: Extract `transformScryfallJson` to helpers

**Files:**
- Modify: `src/core/db/queries/helpers.ts`
- Modify: `src/core/getCards.ts:48-75`

- [ ] **Step 1: Add `transformScryfallJson` to helpers.ts**

Add this export at the end of `src/core/db/queries/helpers.ts`:

```typescript
import type { ScryCard } from "../../types";

/**
 * Transform Scryfall JSON from database to the full ScryCard type (camelCase)
 * with image URI and DFC handling. Companion to parseScryfallJson which returns
 * the minimal snake_case ScryfallCardData shape for DB-level filtering.
 */
export function transformScryfallJson(json: string | null, cardName: string): ScryCard | undefined {
  if (!json) return undefined;

  try {
    const data = JSON.parse(json);

    // Handle double-faced cards - use front face image
    let imageUri = "";
    if (data.card_faces && data.card_faces[0]?.image_uris?.normal) {
      imageUri = data.card_faces[0].image_uris.normal;
    } else if (data.image_uris?.normal) {
      imageUri = data.image_uris.normal;
    }

    return {
      name: data.name || cardName,
      imageUri,
      manaCost: data.mana_cost || "",
      manaValue: data.cmc || 0,
      typeLine: data.type_line || "",
      colors: data.colors || [],
      colorIdentity: data.color_identity || [],
      oracleText: data.oracle_text || "",
    };
  } catch {
    return undefined;
  }
}
```

Note: `helpers.ts` currently imports from `"../schema"` (not `"../../types"`), so `ScryCard` needs a new import line from `"../../types"`.

- [ ] **Step 2: Update `getCards.ts` to import from helpers**

In `src/core/getCards.ts`, replace the local `transformScryfallJson` function (lines 45-75) with an import:

```typescript
import { transformScryfallJson } from "./db/queries/helpers";
```

Remove the entire local function definition (the `function transformScryfallJson(...)` block and its JSDoc comment above it). The three call sites at lines 216, 310, and 396 remain unchanged since the signature is identical.

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test`
Expected: All pass — no behavior change, pure refactor.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/queries/helpers.ts src/core/getCards.ts
git commit -m "Extract transformScryfallJson to shared helpers"
```

---

### Task 2: Create `search.ts` query module

**Files:**
- Create: `src/core/db/queries/search.ts`
- Modify: `src/core/db/queries/index.ts`
- Create: `src/core/db/queries/search.test.ts`

- [ ] **Step 1: Write failing tests for `getSearchableCards`**

Create `src/core/db/queries/search.test.ts`. Mock the DB client the same way `queries.test.ts` does. The tests cover all three query paths.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSearchableCards } from "./search";

// Mock the database client
const mockExecute = vi.fn();
vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

describe("getSearchableCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all cards with scryfall_json for global search", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        { name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt","colors":["R"],"type_line":"Instant","oracle_text":"Deal 3 damage.","mana_cost":"{R}","cmc":1,"color_identity":["R"]}' },
        { name: "Counterspell", scryfall_json: '{"name":"Counterspell","colors":["U"],"type_line":"Instant","oracle_text":"Counter target spell.","mana_cost":"{U}{U}","cmc":2,"color_identity":["U"]}' },
      ],
    });

    const result = await getSearchableCards({});
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Lightning Bolt");
    expect(result[0].scryfall_json).toContain("Lightning Bolt");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0].sql).toContain("FROM cards");
    expect(mockExecute.mock.calls[0][0].sql).not.toContain("cube_snapshot_cards");
  });

  it("scopes to draft cube when draftId provided", async () => {
    // First call: get cube_snapshot_id + banned_cards
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    // Second call: get cube cards
    mockExecute.mockResolvedValueOnce({
      rows: [
        { name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 },
      ],
    });

    const result = await getSearchableCards({ draftId: "tarkir" });
    expect(result).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    // Verify draft lookup
    expect(mockExecute.mock.calls[0][0].args).toEqual(["tarkir"]);
    // Verify cube join
    expect(mockExecute.mock.calls[1][0].sql).toContain("cube_snapshot_cards");
  });

  it("returns null when draft not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await getSearchableCards({ draftId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("subtracts picked cards when availableOnly is set", async () => {
    // Draft lookup
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    // Cube cards
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 2 },
        { card_id: 2, name: "Counterspell", scryfall_json: '{"name":"Counterspell"}', qty: 1 },
      ],
    });
    // Pick counts
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 2, pick_count: 1 }, // Counterspell fully picked
      ],
    });

    const result = await getSearchableCards({
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Lightning Bolt");
    expect(result![0].remaining_qty).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("excludes banned cards when availableOnly is set", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: '["Lightning Bolt"]' }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 },
        { card_id: 2, name: "Counterspell", scryfall_json: '{"name":"Counterspell"}', qty: 1 },
      ],
    });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await getSearchableCards({
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Counterspell");
  });

  it("excludes cards with zero remaining qty", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, pick_count: 1 }, // Fully picked
      ],
    });

    const result = await getSearchableCards({
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/search.test.ts`
Expected: FAIL — module `./search` not found.

- [ ] **Step 3: Implement `getSearchableCards`**

Create `src/core/db/queries/search.ts`:

```typescript
/**
 * Query module for server-side card search.
 * Provides card data for the search API with three query paths:
 * global, draft-scoped, and available-only.
 */

import { getClient } from "../client";

export type SearchableCard = {
  name: string;
  scryfall_json: string;
  remaining_qty?: number;
};

type GetSearchableCardsParams = {
  draftId?: string;
  availableOnly?: boolean;
  beforePickN?: number;
};

/**
 * Fetch cards from the database for search filtering.
 *
 * Three query paths:
 * 1. Global (no draftId): all cards with scryfall_json
 * 2. Draft-scoped: cards in the draft's cube snapshot
 * 3. Available-only: draft-scoped minus picked cards
 *
 * Returns null if draftId is provided but not found.
 */
export async function getSearchableCards(
  params: GetSearchableCardsParams
): Promise<SearchableCard[] | null> {
  const client = await getClient();

  // Path 1: Global search — all cards
  if (!params.draftId) {
    const result = await client.execute({
      sql: `SELECT name, scryfall_json FROM cards WHERE scryfall_json IS NOT NULL`,
      args: [],
    });
    return result.rows.map((row) => ({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
    }));
  }

  // Paths 2 & 3 need the cube snapshot (and banned cards for available-only)
  const draftResult = await client.execute({
    sql: `SELECT cube_snapshot_id, banned_cards FROM drafts WHERE draft_id = ?`,
    args: [params.draftId],
  });

  if (draftResult.rows.length === 0) {
    return null;
  }

  const cubeSnapshotId = draftResult.rows[0].cube_snapshot_id as number;

  // Parse banned cards for available-only filtering
  let bannedCards = new Set<string>();
  if (params.availableOnly) {
    const bannedCardsRaw = draftResult.rows[0].banned_cards as string | null;
    if (bannedCardsRaw) {
      try {
        bannedCards = new Set(
          (JSON.parse(bannedCardsRaw) as string[]).map((name) => name.toLowerCase())
        );
      } catch {
        // Ignore malformed JSON
      }
    }
  }

  // Get all cards in the cube
  const cubeCardsResult = await client.execute({
    sql: `SELECT c.card_id, c.name, c.scryfall_json, csc.qty
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id = ? AND c.scryfall_json IS NOT NULL`,
    args: [cubeSnapshotId],
  });

  // Path 2: Draft-scoped (no availability filter)
  if (!params.availableOnly) {
    return cubeCardsResult.rows.map((row) => ({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
    }));
  }

  // Path 3: Available only — subtract picked cards
  const picksResult = await client.execute({
    sql: `SELECT card_id, COUNT(*) as pick_count
          FROM pick_events
          WHERE draft_id = ? AND pick_n < ?
          GROUP BY card_id`,
    args: [params.draftId, params.beforePickN!],
  });

  const pickedCounts = new Map<number, number>();
  for (const row of picksResult.rows) {
    pickedCounts.set(row.card_id as number, row.pick_count as number);
  }

  const available: SearchableCard[] = [];
  for (const row of cubeCardsResult.rows) {
    const cardId = row.card_id as number;
    const qty = row.qty as number;
    const picked = pickedCounts.get(cardId) || 0;
    const remaining = qty - picked;

    if (remaining <= 0) continue;
    if (bannedCards.has((row.name as string).toLowerCase())) continue;

    available.push({
      name: row.name as string,
      scryfall_json: row.scryfall_json as string,
      remaining_qty: remaining,
    });
  }

  return available;
}
```

- [ ] **Step 4: Add re-export to index.ts**

Add to `src/core/db/queries/index.ts`:

```typescript
export * from "./search";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/search.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 6: Run full checks**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, and all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/db/queries/search.ts src/core/db/queries/search.test.ts src/core/db/queries/index.ts
git commit -m "Add getSearchableCards query module for server-side search"
```

---

## Chunk 2: API route + tests

### Task 3: Create the API route with tests

**Files:**
- Create: `src/app/api/cards/search/route.ts`
- Create: `src/app/api/cards/search/route.test.ts`

- [ ] **Step 1: Write failing tests for the route**

Create `src/app/api/cards/search/route.test.ts`. Follow the same mock pattern as `src/app/api/cards/stats/route.test.ts`.

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";
import * as localSearch from "@/core/localSearch";

vi.mock("@/core/db/queries");
vi.mock("@/core/localSearch");

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/cards/search");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

const BOLT_JSON = JSON.stringify({
  name: "Lightning Bolt",
  colors: ["R"],
  color_identity: ["R"],
  type_line: "Instant",
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  mana_cost: "{R}",
  cmc: 1,
  image_uris: { normal: "https://img/bolt.jpg" },
});

const BOLT_SCRYCARD = {
  name: "Lightning Bolt",
  imageUri: "https://img/bolt.jpg",
  manaCost: "{R}",
  manaValue: 1,
  typeLine: "Instant",
  colors: ["R"],
  colorIdentity: ["R"],
  oracleText: "Lightning Bolt deals 3 damage to any target.",
};

describe("GET /api/cards/search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires q parameter", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("q parameter is required");
  });

  it("returns 400 when available_only set without draft_id", async () => {
    const res = await GET(makeRequest({ q: "t:creature", available_only: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("available_only requires draft_id");
  });

  it("returns 400 when before_pick_n set without available_only", async () => {
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "tarkir", before_pick_n: "50" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("before_pick_n requires available_only");
  });

  it("returns 400 when available_only set without before_pick_n", async () => {
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "tarkir", available_only: "true" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("before_pick_n is required");
  });

  it("returns 404 when draft not found", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce(null);
    const res = await GET(makeRequest({ q: "t:creature", draft_id: "nonexistent" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("Draft not found");
  });

  it("performs global search", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({ q: "t:instant" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.query).toBe("t:instant");
    expect(body.total).toBe(1);
    expect(body.draft_id).toBeNull();
    expect(body.before_pick_n).toBeNull();
    expect(body.cards[0]).toEqual({
      name: "Lightning Bolt",
      image_uri: "https://img/bolt.jpg",
      mana_cost: "{R}",
      mana_value: 1,
      type_line: "Instant",
      colors: ["R"],
      color_identity: ["R"],
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
    });

    expect(queries.getSearchableCards).toHaveBeenCalledWith({});
  });

  it("performs draft-scoped search", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({ q: "t:instant", draft_id: "tarkir" }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.draft_id).toBe("tarkir");
    expect(queries.getSearchableCards).toHaveBeenCalledWith({ draftId: "tarkir" });
  });

  it("performs available-only search with remaining_qty", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([
      { name: "Lightning Bolt", scryfall_json: BOLT_JSON, remaining_qty: 2 },
    ]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([BOLT_SCRYCARD]);

    const res = await GET(makeRequest({
      q: "t:instant",
      draft_id: "tarkir",
      available_only: "true",
      before_pick_n: "50",
    }));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.before_pick_n).toBe(50);
    expect(body.cards[0].remaining_qty).toBe(2);
    expect(queries.getSearchableCards).toHaveBeenCalledWith({
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });
  });

  it("sets 5-minute cache for global queries", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([]);

    const res = await GET(makeRequest({ q: "bolt" }));
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
  });

  it("sets no-store cache for draft-scoped queries", async () => {
    vi.mocked(queries.getSearchableCards).mockResolvedValueOnce([]);
    vi.mocked(localSearch.searchLocalCards).mockReturnValueOnce([]);

    const res = await GET(makeRequest({ q: "bolt", draft_id: "tarkir" }));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(queries.getSearchableCards).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(makeRequest({ q: "bolt" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/api/cards/search/route.test.ts`
Expected: FAIL — module `./route` not found.

- [ ] **Step 3: Implement the API route**

Create `src/app/api/cards/search/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { searchLocalCards } from "@/core/localSearch";
import { transformScryfallJson } from "@/core/db/queries/helpers";
import type { ScryCard } from "@/core/types";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const q = searchParams.get("q");
    const draftId = searchParams.get("draft_id");
    const availableOnly = searchParams.get("available_only") === "true";
    const beforePickNRaw = searchParams.get("before_pick_n");
    const beforePickN = beforePickNRaw ? parseInt(beforePickNRaw, 10) : undefined;

    // Parameter validation
    if (!q) {
      return NextResponse.json({ error: "q parameter is required" }, { status: 400 });
    }
    if (availableOnly && !draftId) {
      return NextResponse.json(
        { error: "available_only requires draft_id" },
        { status: 400 },
      );
    }
    if (beforePickN !== undefined && !availableOnly) {
      return NextResponse.json(
        { error: "before_pick_n requires available_only" },
        { status: 400 },
      );
    }
    if (availableOnly && beforePickN === undefined) {
      return NextResponse.json(
        { error: "before_pick_n is required when available_only is set" },
        { status: 400 },
      );
    }

    // Fetch cards from DB
    const dbCards = await queries.getSearchableCards({
      ...(draftId ? { draftId } : {}),
      ...(availableOnly ? { availableOnly, beforePickN } : {}),
    });

    if (dbCards === null) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    // Convert to ScryCard for search, tracking remaining_qty by name
    const scryfallCards: ScryCard[] = [];
    const remainingQtyMap = new Map<string, number>();

    for (const card of dbCards) {
      const scryCard = transformScryfallJson(card.scryfall_json, card.name);
      if (scryCard) {
        scryfallCards.push(scryCard);
        if (card.remaining_qty !== undefined) {
          remainingQtyMap.set(scryCard.name, card.remaining_qty);
        }
      }
    }

    // Run search
    const matches = searchLocalCards(q, scryfallCards);

    // Map to snake_case response
    const cards = matches.map((card) => {
      const result: Record<string, unknown> = {
        name: card.name,
        image_uri: card.imageUri,
        mana_cost: card.manaCost,
        mana_value: card.manaValue,
        type_line: card.typeLine,
        colors: card.colors,
        color_identity: card.colorIdentity,
        oracle_text: card.oracleText,
      };
      if (remainingQtyMap.has(card.name)) {
        result.remaining_qty = remainingQtyMap.get(card.name);
      }
      return result;
    });

    const cacheControl = draftId ? "no-store" : "public, s-maxage=300";

    return NextResponse.json(
      {
        query: q,
        total: cards.length,
        draft_id: draftId ?? null,
        before_pick_n: beforePickN ?? null,
        cards,
      },
      { headers: { "Cache-Control": cacheControl } },
    );
  } catch (error) {
    console.error("[/api/cards/search] Error:", error);
    return NextResponse.json(
      { error: "Failed to search cards" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 4: Run route tests**

Run: `pnpm test src/app/api/cards/search/route.test.ts`
Expected: All 10 tests pass.

- [ ] **Step 5: Run full checks**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, and all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/cards/search/route.ts src/app/api/cards/search/route.test.ts
git commit -m "Add GET /api/cards/search route for server-side Oracle search"
```

---

## Chunk 3: Documentation

### Task 4: Update CLAUDE.md REST API table

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the new route to the REST API table**

In `CLAUDE.md`, add a row to the REST API table after the `/api/stats` row:

```markdown
| `/api/cards/search` | Scryfall-style card search | `q` (required), `draft_id`, `available_only`, `before_pick_n` |
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document /api/cards/search in REST API table"
```
