# Server-Side Card Stats API Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace client-side draft recomputation with a server-side API route, remove win equity/raw win rate, and simplify the client to a thin display layer.

**Architecture:** A single `getCards()` function queries Turso and computes card stats server-side. It's called directly by the SSR page component and exposed via `/api/cards` for client requests when draft selection changes. Edge + browser caching with ingestion-hash-based invalidation.

**Tech Stack:** Next.js API routes (serverless), Turso (libSQL), existing `calculateCardStats()` algorithm.

**Spec:** `docs/superpowers/specs/2026-03-19-server-side-card-stats-design.md`

---

## Chunk 1: Server-Side Core + API Route

This chunk creates the `getCards()` function and API route, adds the ingestion hash to Turso, and sets up caching. By the end, the API is functional and testable independently of the client refactor.

### Task 1: Add Ingestion Hash to Turso

The ingest script must write a hash to Turso so the API can use it for cache busting.

**Files:**
- Modify: `src/core/db/schema.sql` (add `ingestion_meta` table)
- Modify: `src/core/db/ingest.ts` (add hash write at end of ingestion)

- [ ] **Step 1: Add ingestion_meta table to schema.sql**

In `src/core/db/schema.sql`, add at the end:

```sql
-- Ingestion metadata (cache busting hash, etc.)
CREATE TABLE IF NOT EXISTS ingestion_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The migration script (`migrate.ts`) reads from `schema.sql` and executes each statement — no changes needed to `migrate.ts` itself.

- [ ] **Step 2: Run the migration**

Run: `pnpm db:migrate`
Expected: Table created successfully, no errors.

- [ ] **Step 3: Write ingestion hash at end of ingest**

In `src/core/db/ingest.ts`, after the existing ingestion logic completes, compute a hash from the current set of draft IDs and a timestamp, then upsert it into `ingestion_meta`:

```typescript
import { createHash } from "crypto";

// After all drafts are ingested:
const allDraftIds = /* query all draft_ids from drafts table, sorted */;
// Hash based on draft content, not timestamp — deterministic unless data changes
const draftHashes = /* query import_hash from drafts table for all drafts, sorted by draft_id */;
const hashInput = draftHashes.join(",");
const ingestionHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);

await client.execute({
  sql: `INSERT OR REPLACE INTO ingestion_meta (key, value) VALUES ('last_hash', ?)`,
  args: [ingestionHash],
});
console.log(`[Ingest] Wrote ingestion hash: ${ingestionHash}`);
```

- [ ] **Step 4: Test by running ingest**

Run: `pnpm ingest`
Expected: Ingestion completes with "Wrote ingestion hash: <8-char-hex>" in output. Verify with:
```bash
# Check the value was written (use your Turso CLI or a quick script)
```

- [ ] **Step 5: Commit**

```bash
git add src/core/db/schema.sql src/core/db/ingest.ts
git commit -m "Add ingestion hash to Turso for API cache busting"
```

---

### Task 2: Remove Win Equity and Raw Win Rate Types

Clean up the type system before building the new function. This prevents the new code from depending on types that are about to be deleted.

**Files:**
- Modify: `src/core/types.ts`
- Delete: `src/core/winEquity.ts`
- Delete: `src/core/winEquity.test.ts`

- [ ] **Step 1: Remove winEquity and rawWinRate from CardStats type**

In `src/core/types.ts`, remove these fields from the `CardStats` type (approximately lines 99-128):

```typescript
// DELETE these fields:
winEquity?: {
  wins: number;
  losses: number;
  winRate: number;
};
rawWinRate?: {
  wins: number;
  losses: number;
  winRate: number;
};
```

Keep the `decklistWinRate` field — it stays.

- [ ] **Step 2: Delete DraftDataFile type**

In `src/core/types.ts`, delete the `DraftDataFile` type (approximately lines 187-196). This type represented the client-side JSON blob that no longer exists.

- [ ] **Step 3: Delete winEquity.ts and its test**

```bash
rm src/core/winEquity.ts src/core/winEquity.test.ts
```

- [ ] **Step 4: Verify no remaining imports of deleted code**

Run: `grep -r "winEquity\|rawWinRate\|DraftDataFile" src/core/ --include="*.ts" -l`
Expected: Only `types.ts` (for `decklistWinRate`) and possibly test files. Fix any remaining imports.

Note: `src/build/tursoDataLoader.ts` and `src/app/components/PageClient.tsx` will still reference these — they're refactored in later tasks.

- [ ] **Step 5: Run calculateStats tests**

Run: `pnpm test src/core/calculateStats.test.ts`
Expected: PASS. This is the core algorithm — it must not be broken by type changes.

Other test files (`tursoDataLoader`, `PageClient`) will have type errors from the removed fields. Those files are refactored in later tasks — don't fix them now.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/winEquity.ts src/core/winEquity.test.ts
git commit -m "Remove win equity and raw win rate types and module"
```

---

### Task 3: Create getCards() Function

The core of the refactor — a single function that replaces `loadCardDataFromTurso()`.

**Files:**
- Create: `src/core/getCards.ts`
- Create: `src/core/getCards.test.ts`

- [ ] **Step 1: Write the test for getCards()**

Create `src/core/getCards.test.ts`. This tests the function's contract: given params, it returns the right shape. Since it queries Turso, this is an integration test that requires the database to be populated.

```typescript
import { getCards } from "./getCards";

describe("getCards", () => {
  it("returns card stats for all completed drafts by default", async () => {
    const result = await getCards({ includeMatchData: false });

    expect(result.cards).toBeDefined();
    expect(Array.isArray(result.cards)).toBe(true);
    expect(result.draftCount).toBeGreaterThan(0);
    expect(result.ingestionHash).toBeDefined();
    expect(typeof result.ingestionHash).toBe("string");
    expect(result.completedDraftIds.length).toBe(result.draftCount);
    expect(result.cubeCopies).toBeDefined();
    expect(result.draftMetadata).toBeDefined();

    // Cards should have stats but NOT match data
    if (result.cards.length > 0) {
      const card = result.cards[0];
      expect(card.cardName).toBeDefined();
      expect(card.weightedGeomean).toBeDefined();
      expect(card.scryfall).toBeDefined();
      expect(card.decklistWinRate).toBeUndefined();
    }
  });

  it("includes decklist win rate when includeMatchData is true", async () => {
    const result = await getCards({ includeMatchData: true });

    // At least some cards should have decklist win rates
    const cardsWithWinRate = result.cards.filter((c) => c.decklistWinRate);
    expect(cardsWithWinRate.length).toBeGreaterThan(0);

    const card = cardsWithWinRate[0];
    expect(card.decklistWinRate?.winRate).toBeDefined();
    expect(card.decklistWinRate?.gameWins).toBeDefined();
    expect(card.decklistWinRate?.gameLosses).toBeDefined();
  });

  it("filters by specific draft IDs", async () => {
    // First get all drafts to know valid IDs
    const all = await getCards({ includeMatchData: false });
    const firstDraftId = all.completedDraftIds[0];

    const filtered = await getCards({
      draftIds: [firstDraftId],
      includeMatchData: false,
    });

    expect(filtered.draftCount).toBe(1);
    expect(filtered.cards.length).toBeGreaterThan(0);
    // Fewer or equal cards compared to all drafts
    expect(filtered.cards.length).toBeLessThanOrEqual(all.cards.length);
  });

  it("returns ingestion hash", async () => {
    const result = await getCards({ includeMatchData: false });
    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/core/getCards.test.ts`
Expected: FAIL — module `./getCards` not found.

- [ ] **Step 3: Create the getCards() function**

Create `src/core/getCards.ts`. This is a refactor of `src/build/tursoDataLoader.ts` with these changes:
- Accepts `GetCardsParams` (optional `draftIds`, required `includeMatchData`)
- When `draftIds` is provided, filters to those drafts instead of all completed
- Conditionally queries and attaches `decklistWinRate` only when `includeMatchData` is true
- Does NOT compute `winEquity` or `rawWinRate` (those are deleted)
- Reads `ingestionHash` from `ingestion_meta` table
- Returns `CardStatsResponse` type

```typescript
import {
  DEFAULT_POOL_SIZE,
  type CardPick,
  type DraftMetadata,
  type DraftScore,
  type EnrichedCardStats,
  type ScryCard,
} from "./types";
import { calculateCardStats, DISTRIBUTION_BUCKET_COUNT } from "./calculateStats";
import { getClient } from "./db/client";
import { cardNameKey } from "./parseCsv";

export type GetCardsParams = {
  draftIds?: string[];
  includeMatchData: boolean;
};

export type CardStatsResponse = {
  cards: EnrichedCardStats[];
  draftCount: number;
  cubeCopies: Record<string, number>;
  draftMetadata: Record<string, { name: string; date: string }>;
  draftIds: string[];
  completedDraftIds: string[];
  ingestionHash: string;
};
```

Copy `transformScryfallJson()` and `getColorFromIdentity()` helper functions from `src/build/tursoDataLoader.ts` into this file (they're private helpers, ~30 lines each).

The main `getCards()` function is a refactor of `loadCardDataFromTurso()` (502 lines). Start by copying the function body, then apply these targeted changes:

**Change 1: Draft selection filtering (replaces hardcoded `completedDraftIds`)**

After querying all drafts and building `completedDraftSet`, determine the "selected" set:

```typescript
// Determine which drafts to compute stats for
const selectedDraftIds: string[] = params.draftIds
  ? params.draftIds.filter((id) => completedDraftSet.has(id))
  : completedDraftIds;
```

Use `selectedDraftIds` everywhere `completedDraftIds` was used for filtering picks and building unpicked entries. Note: `params.draftIds` is intersected with completed drafts — incomplete drafts are excluded from stat computation.

The response still returns ALL `draftIds` and `completedDraftIds` (the full universe), since the Settings panel needs to show all available drafts.

**Change 2: Remove win equity and raw win rate computation**

Delete the entire block that queries `match_events` and calls `calculateWinEquity()` / `calculateRawWinRate()` (approximately lines 299-338 and 415-435 of `tursoDataLoader.ts`). Also remove the loop that attaches `winEquity` and `rawWinRate` to stats.

**Change 3: Conditionally include decklist win rate**

Wrap the decklist win rate query (approximately lines 341-381 of `tursoDataLoader.ts`) in:

```typescript
if (params.includeMatchData) {
  // Existing decklist win rate query + attachment logic
  const decklistWinResult = await client.execute({ ... });
  // ... process and attach to stats
}
```

When `includeMatchData` is false, no match data is queried and `decklistWinRate` is never set on any card.

**Change 4: Add ingestion hash query**

Before the return statement:

```typescript
const hashResult = await client.execute({
  sql: `SELECT value FROM ingestion_meta WHERE key = 'last_hash'`,
  args: [],
});
const ingestionHash = (hashResult.rows[0]?.value as string) ?? "unknown";
```

**Change 5: Return `CardStatsResponse`**

Replace the return type and shape. The key differences from the old return:
- `cubeCopies` instead of `currentCubeCopies` (rename)
- No `currentCubeCards` array (redundant with `cubeCopies` keys)
- No `scryfallData` as a separate field (it's embedded in each card's `scryfall` property)
- Added `ingestionHash`

```typescript
return {
  cards: allCards,
  draftCount: selectedDraftIds.length,
  cubeCopies: currentCubeCopies,
  draftMetadata: draftMetadataObj,
  draftIds,
  completedDraftIds,
  ingestionHash,
};
```

**Prerequisite:** This is an integration test that requires a populated Turso database. Run `pnpm ingest` before running the tests if you haven't already.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/getCards.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/getCards.ts src/core/getCards.test.ts
git commit -m "Add getCards() server-side computation function"
```

---

### Task 4: Create the API Route

**Files:**
- Create: `src/app/api/cards/route.ts`

- [ ] **Step 1: Create the API route handler**

Create `src/app/api/cards/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getCards } from "@/core/getCards";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  // Parse draft IDs from comma-separated query param
  const draftsParam = searchParams.get("drafts");
  const draftIds = draftsParam
    ? draftsParam.split(",").filter(Boolean)
    : undefined;

  // Detect localhost from Host header
  const host = request.headers.get("host") ?? "";
  const isLocal =
    host.startsWith("localhost") || host.startsWith("127.0.0.1");

  const result = await getCards({
    draftIds,
    includeMatchData: isLocal,
  });

  const response = NextResponse.json(result);

  // Cache forever at the edge — the ?v= param busts the cache on new ingestions.
  // Localhost and production return different data (decklist win rate),
  // but they naturally get different cache keys because the client
  // includes &local=1 on localhost requests (see PageClient).
  response.headers.set(
    "Cache-Control",
    "public, s-maxage=31536000, stale-while-revalidate=60"
  );

  return response;
}
```

- [ ] **Step 2: Test the API route manually**

Start the dev server and test:
```bash
pnpm dev
# In another terminal:
curl -s "http://localhost:3000/api/cards" | jq '.draftCount, .ingestionHash, (.cards | length)'
curl -s "http://localhost:3000/api/cards?drafts=INVALID" | jq '.draftCount'
```

Expected: First request returns card count > 0, valid hash, draft count. Second request returns draftCount: 0 or empty cards (no valid drafts matched).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cards/route.ts
git commit -m "Add /api/cards serverless API route with edge caching"
```

---

## Chunk 2: Client-Side Refactor + Cleanup

This chunk rewires `PageClient` to consume `CardStatsResponse`, updates `page.tsx`, simplifies `Settings` and `CardTable`, and deletes obsolete files.

### Task 5: Update page.tsx and Refactor PageClient.tsx

These two files change together — `page.tsx` passes `initialData` and `PageClient` accepts it. Doing them in one task avoids a broken intermediate state.

The biggest change — update `page.tsx` to call `getCards()`, strip out all client-side stat computation from `PageClient`, and replace with API fetch-and-swap.

**Files:**
- Modify: `src/app/page.tsx`
- Modify: `src/app/components/PageClient.tsx`
- Modify: `src/app/components/PageClient.test.tsx`

- [ ] **Step 1: Update page.tsx**

Replace the current `page.tsx` content:

```typescript
import { headers } from "next/headers";
import { getCards } from "@/core/getCards";
import { PageClient } from "./components/PageClient";

export default async function Home() {
  const headersList = await headers();
  const host = headersList.get("host") ?? "";
  const isLocal =
    host.startsWith("localhost") || host.startsWith("127.0.0.1");

  const data = await getCards({ includeMatchData: isLocal });

  return <PageClient initialData={data} />;
}
```

- [ ] **Step 2: Rewrite PageClient props and state**

Replace the current props interface and state initialization. The component now accepts a single `initialData` prop of type `CardStatsResponse`:

```typescript
"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { CardTable, ColorFilter, Settings } from "./index";
import type { ColorFilterMode } from "@/core/colorFilter";
import type { ScryCard } from "@/core/types";
import type { CardStatsResponse } from "@/core/getCards";
import { searchLocalCards } from "@/core/localSearch";
import { hasScryfallOperators } from "@/core/searchUtils";
import { cardNameKey } from "@/core/parseCsv";

export interface PageClientProps {
  initialData: CardStatsResponse;
}

export function PageClient({ initialData }: PageClientProps) {
  // Card data from server (SSR or API)
  const [cardData, setCardData] = useState<CardStatsResponse>(initialData);
  const [isLoading, setIsLoading] = useState(false);

  // Draft selection
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(
    () => new Set(initialData.completedDraftIds)
  );

  // UI state (unchanged)
  const [searchQuery, setSearchQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<string[]>([]);
  const [colorFilterMode, setColorFilterMode] =
    useState<ColorFilterMode>("inclusive");
  const [scryfallSearchResults, setScryfallSearchResults] =
    useState<ScryCard[] | null>(null);
```

- [ ] **Step 3: Replace the draft selection handler**

Remove the old `handleDraftsChange` (which lazy-loaded `draft-data.json` and recomputed stats) and replace with:

```typescript
  // Cache the localhost check — stable across renders, used for cache key divergence
  const isLocal = typeof window !== "undefined" &&
    (window.location.hostname === "localhost" ||
     window.location.hostname === "127.0.0.1");

  const handleDraftsChange = useCallback(
    async (newSelection: Set<string>) => {
      setSelectedDrafts(newSelection);

      if (newSelection.size === 0) {
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
        const params = new URLSearchParams();
        params.set("drafts", [...newSelection].join(","));
        params.set("v", cardData.ingestionHash);
        if (isLocal) params.set("local", "1");

        const res = await fetch(`/api/cards?${params}`);
        if (!res.ok) throw new Error("API request failed");
        const data: CardStatsResponse = await res.json();
        setCardData(data);
      } catch (error) {
        console.error("Failed to fetch card data:", error);
      } finally {
        setIsLoading(false);
      }
    },
    [cardData.ingestionHash, isLocal]
  );
```

- [ ] **Step 4: Remove the stat computation useMemo**

Delete the entire `useMemo` block (approximately lines 96-203 in the old file) that computed `displayedCards`, `displayedCubeCopies`, and `effectiveDraftCount`. Replace with simple derivations from `cardData`:

```typescript
  const displayedCards = cardData.cards;
  const displayedCubeCopies = cardData.cubeCopies;
  const effectiveDraftCount = cardData.draftCount;
```

- [ ] **Step 5: Remove deleted imports and state**

Remove these imports and state variables:
- `useLocalStorage`, `useIsHydrated` imports (if no longer needed — check if `useIsHydrated` is used elsewhere in this component)
- `useIsLocalhost` import
- `calculateCardStats`, `metadataToMap`, `DISTRIBUTION_BUCKET_COUNT` imports
- `calculateWinEquity`, `calculateRawWinRate` imports
- `aggregateSeatStats` import
- `showWinEquity`, `showRawWinRate` state
- `isLocalhost`, `isHydrated` state
- `draftData`, `isDraftDataLoading`, `draftDataError` state
- `isDefaultSelection`, `isCompletedDraftSelection` logic

Note: Check whether `useIsHydrated` is still needed. It was used to gate the Settings component render (`{isHydrated && <Settings ... />}`). If the Settings component no longer depends on localStorage values, `isHydrated` may be unnecessary. However, if there's any SSR/hydration mismatch concern, keep it.

- [ ] **Step 6: Adapt the Scryfall search data source**

The search currently uses `Object.values(scryfallData)` where `scryfallData` was a top-level prop. Change to derive from the cards array:

```typescript
  // Build Scryfall data for local search from card data
  const scryfallCards = useMemo(
    () => cardData.cards.map((c) => c.scryfall).filter(Boolean) as ScryCard[],
    [cardData.cards]
  );
```

Then update the search effect to use `scryfallCards` instead of `Object.values(scryfallData)`:

```typescript
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setScryfallSearchResults(null);
      return;
    }
    if (!hasScryfallOperators(query)) {
      setScryfallSearchResults(null);
      return;
    }
    const timeoutId = setTimeout(() => {
      const results = searchLocalCards(query, scryfallCards);
      setScryfallSearchResults(results);
    }, 500);
    return () => clearTimeout(timeoutId);
  }, [searchQuery, scryfallCards]);
```

- [ ] **Step 7: Update the drafts array derivation**

Replace the old `drafts` memo that used `draftIds` and `draftMetadata` props:

```typescript
  const drafts = useMemo(
    () =>
      cardData.draftIds.map((id) => ({
        id,
        name: cardData.draftMetadata[id]?.name || id,
        date: cardData.draftMetadata[id]?.date || "1970-01-01",
      })),
    [cardData.draftIds, cardData.draftMetadata]
  );
```

- [ ] **Step 8: Replace isDefaultSelection with a simpler derivation**

The old code used `isDefaultSelection` to show a "(filtered)" indicator in the header. Replace with:

```typescript
const isFiltered = selectedDrafts.size !== cardData.completedDraftIds.length ||
  !cardData.completedDraftIds.every((id) => selectedDrafts.has(id));
```

Then in the header JSX, replace `!isDefaultSelection && selectedDrafts.size > 0` with `isFiltered`.

- [ ] **Step 9: Update the JSX**

Update the render to reflect removed props and state:
- Remove `showWinEquity` and `showRawWinRate` props from `<Settings>`
- Remove `showWinEquity`, `showRawWinRate`, and `isLocalhost` props from `<CardTable>`
- Replace `isDraftDataLoading` with `isLoading` in Settings and loading overlay
- Remove the `isHydrated` gate around Settings if no longer needed
- Replace the `draftDataError` conditional in the header status text. Since the new `handleDraftsChange` only logs errors to console, simplify the status text to show "Loading..." during fetches and the card count otherwise. Remove the "Draft filtering unavailable" text.
- Also update the empty-state `<div>` below the card table (approximately line 448-458 in the old file) — it has a `draftDataError` branch showing "Draft filtering unavailable. Try selecting all drafts." Remove that branch.

The `<CardTable>` call becomes:
```tsx
<CardTable
  cards={searchFilteredCards}
  colorFilter={colorFilter}
  colorFilterMode={colorFilterMode}
  currentCubeCopies={displayedCubeCopies}
/>
```

The `<Settings>` call becomes:
```tsx
<Settings
  drafts={drafts}
  selectedDrafts={selectedDrafts}
  onDraftsChange={handleDraftsChange}
  isLoading={isLoading}
/>
```

- [ ] **Step 10: Update PageClient.test.tsx**

The test file uses the old `PageClientProps` shape (7 props) and mocks `useLocalStorage`/`useIsHydrated`. Update it:

- Change `makeTestProps()` to return `{ initialData: CardStatsResponse }` instead of the old 7-prop shape
- Remove the `useLocalStorage` and `useIsHydrated` mocks if they're no longer needed
- Update the Settings mock to reflect the simplified props
- Add a `fetch` mock for the API call in draft selection tests
- Remove or rewrite test cases that assert on "Draft filtering unavailable" — this text no longer exists. The "shows error when draft data fetch fails" and "clears error state" tests reference deleted behavior and need updating.

The test data structure becomes:
```typescript
function makeTestProps(overrides?: Partial<CardStatsResponse>): PageClientProps {
  return {
    initialData: {
      cards: [/* test cards */],
      draftCount: 2,
      cubeCopies: { "Lightning Bolt": 1 },
      draftIds: ["draft-a", "draft-b", "draft-c"],
      completedDraftIds: ["draft-a", "draft-b"],
      draftMetadata: {
        "draft-a": { name: "Draft A", date: "2026-01-01" },
        "draft-b": { name: "Draft B", date: "2026-02-01" },
        "draft-c": { name: "Draft C", date: "2026-03-01" },
      },
      ingestionHash: "abc12345",
      ...overrides,
    },
  };
}
```

- [ ] **Step 11: Verify the dev server runs**

Run: `pnpm dev`
Expected: Page loads with card data. Changing draft selection triggers API call and updates the table. No console errors.

- [ ] **Step 12: Run PageClient tests**

Run: `pnpm test src/app/components/PageClient.test.tsx`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add src/app/page.tsx src/app/components/PageClient.tsx src/app/components/PageClient.test.tsx
git commit -m "Refactor page.tsx and PageClient to use server-side card stats API"
```

---

### Task 6: Simplify Settings.tsx

**Files:**
- Modify: `src/app/components/Settings.tsx`

- [ ] **Step 1: Remove win rate toggles and simplify props**

Update `SettingsProps` to remove the toggle props:

```typescript
export interface SettingsProps {
  drafts: Array<{ id: string; name: string; date: string }>;
  selectedDrafts: Set<string>;
  onDraftsChange: (selected: Set<string>) => void;
  isLoading?: boolean;
}
```

Remove the `showWinEquity`, `onToggleWinEquity`, `showRawWinRate`, `onToggleRawWinRate` props from the function signature and destructuring.

Remove the two `<label>` checkbox elements for "Show Win Equity column" and "Show Win Rate column" from the JSX (approximately lines 136-159).

Rename `isDraftDataLoading` to `isLoading` in the component.

- [ ] **Step 2: Verify Settings renders correctly**

Run: `pnpm dev`
Expected: Settings modal shows only the draft selector, no checkboxes below it.

- [ ] **Step 3: Commit**

```bash
git add src/app/components/Settings.tsx
git commit -m "Simplify Settings to draft selector only"
```

---

### Task 7: Simplify CardTable.tsx

**Files:**
- Modify: `src/app/components/CardTable.tsx`

- [ ] **Step 1: Remove win equity and raw win rate columns, simplify props**

Update the props interface to remove `showWinEquity`, `showRawWinRate`, and `isLocalhost`:

```typescript
interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
}
```

Remove the Win Equity column definition (approximately lines 174-207 in the current file).

Remove the Raw Win Rate column definition (approximately lines 209-243).

Change the Deck WR column (approximately lines 245-284) from being conditional on `isLocalhost` to being conditional on whether any card in the dataset has `decklistWinRate`:

```typescript
// Conditionally include decklist win rate column
const hasAnyDecklistWinRate = cards.some((c) => c.decklistWinRate);
```

Then conditionally include the column definition:
```typescript
...(hasAnyDecklistWinRate
  ? [
      columnHelper.accessor(/* existing Deck WR column definition */),
    ]
  : []),
```

Also update the `columns` useMemo dependency array (currently `[currentCubeCopies, showWinEquity, showRawWinRate, isLocalhost, draftTimeline]`) to:
```typescript
[currentCubeCopies, hasAnyDecklistWinRate, draftTimeline]
```

Remove the `WIN_EQUITY_EXPLANATION` and `RAW_WIN_RATE_EXPLANATION` constants and their usage in the mobile-only help text block (approximately lines 364-377). Keep only the "Pick Score" help text in that section.

- [ ] **Step 2: Verify the table renders correctly**

Run: `pnpm dev`
Expected: On localhost, the Deck WR column appears. Win Equity and Win Rate columns are gone.

- [ ] **Step 3: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Remove win equity and raw win rate columns, data-drive decklist win rate visibility"
```

---

### Task 8: Delete Obsolete Files and Clean Up

**Files:**
- Delete: `scripts/generate-draft-data.ts`
- Delete: `src/build/tursoDataLoader.ts`
- Delete: `src/app/hooks/useIsLocalhost.ts`
- Modify: `package.json` (remove prebuild, simplify predev)
- Modify: `.gitignore` (remove draft-data.json entry)

- [ ] **Step 1: Delete obsolete files**

```bash
rm scripts/generate-draft-data.ts
rm src/build/tursoDataLoader.ts
rm src/app/hooks/useIsLocalhost.ts
rm -f public/api/draft-data.json
```

- [ ] **Step 2: Update package.json scripts**

In `package.json`, update:

```json
"predev": "tsx scripts/sync-sheets.ts",
```

Remove the `"prebuild"` script entirely.

- [ ] **Step 3: Clean up .gitignore**

Remove the line `public/api/draft-data.json` from `.gitignore` — the file is no longer generated.

- [ ] **Step 4: Check for any remaining dead imports**

Search for references to deleted modules:

```bash
grep -r "tursoDataLoader\|generate-draft-data\|useIsLocalhost\|winEquity\|DraftDataFile" src/ scripts/ --include="*.ts" --include="*.tsx" -l
```

Fix any remaining references. Common ones:
- `src/app/components/index.ts` may re-export deleted hooks
- Test files may import deleted modules

- [ ] **Step 5: Check if useLocalStorage.ts is still needed**

If `useLocalStorage` is no longer imported anywhere (the win rate toggles were its only consumers), it can be deleted. Check:

```bash
grep -r "useLocalStorage" src/ --include="*.ts" --include="*.tsx" -l
```

If only `useLocalStorage.ts` itself appears, delete it. If `useIsHydrated` (exported from the same file) is still used, keep the file but remove the unused `useLocalStorage` export.

- [ ] **Step 6: Verify src/build/ still has its other files**

`src/build/` also contains `scryfall.ts`, `scryfall.test.ts`, `sheets.ts`, and `sheets.test.ts`. Only `tursoDataLoader.ts` was deleted — the directory stays.

- [ ] **Step 7: Run full test suite**

Run: `pnpm test`
Expected: All tests pass. Tests for deleted modules (`winEquity.test.ts`) should already be gone from Task 2.

- [ ] **Step 8: Run build**

Run: `pnpm build`
Expected: Build succeeds. The page renders via SSR (no prebuild step needed).

- [ ] **Step 9: Verify the full flow end-to-end**

```bash
pnpm dev
```

Test:
1. Page loads with card data (SSR) — no loading spinner
2. Open Settings, deselect a draft, data updates via API call
3. Reselect the same drafts — response comes from browser cache (fast)
4. On localhost, Deck WR column appears
5. Search and color filters still work
6. Sparklines and distributions render correctly

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "Delete obsolete files: draft-data generator, tursoDataLoader, client-side win rate code"
```
