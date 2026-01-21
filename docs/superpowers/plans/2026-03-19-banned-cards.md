# Banned Cards Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-draft card bans that exclude cards from stats and hide them during active drafts.

**Architecture:** Bans are declared in metadata.json, stored in the `drafts` table during ingestion, read at query time to skip unpicked penalty entries, and filtered out in the client when an active draft is selected.

**Tech Stack:** TypeScript, SQLite (Turso/libSQL), Next.js, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-19-banned-cards-design.md`

---

## Chunk 1: Schema & Ingestion

### Task 1: Add banned_cards column to schema

**Files:**
- Modify: `src/core/db/schema.sql:51` (after existing ALTER TABLE statements)

- [ ] **Step 1: Add the ALTER TABLE statement**

Insert between line 51 (`ALTER TABLE drafts ADD COLUMN sheet_id TEXT;`) and line 52 (`INSERT OR IGNORE INTO ingestion_meta ...`). The new line goes with the other ALTER TABLE statements, before the INSERT statements:

```sql
ALTER TABLE drafts ADD COLUMN sheet_id TEXT;

-- Per-draft card bans (JSON array of card names, e.g. '["Reanimate","Channel"]')
ALTER TABLE drafts ADD COLUMN banned_cards TEXT;

INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('sync_lock', '');
```

- [ ] **Step 2: Run migration to verify**

Run: `pnpm db:migrate`
Expected: Success (or "duplicate column" if already present — the migration runner handles this gracefully)

- [ ] **Step 3: Commit**

```bash
git add src/core/db/schema.sql
git commit -m "Add banned_cards column to drafts table"
```

---

### Task 2: Update ingestion to read and store bans

**Files:**
- Modify: `src/core/db/ingest.ts:38-43` (DraftMetadata interface)
- Modify: `src/core/db/ingest.ts:105-112` (computeImportHash)
- Modify: `src/core/db/ingest.ts:451-467` (createDraft function)
- Modify: `src/core/db/ingest.ts:643-668` (processDraftInner — metadata loading)
- Modify: `src/core/db/ingest.ts:670-683` (pool loading — ban validation)
- Modify: `src/core/db/ingest.ts:750-760` (createDraft call site)

- [ ] **Step 1: Write tests for ingestion changes**

Create `src/core/db/__tests__/ingest-bans.test.ts`, following the pattern in `ingest-sheet-id.test.ts` (source-file inspection tests since ingestion functions are not exported):

```typescript
/**
 * Tests that ingestion handles banned cards from metadata.json.
 * Uses source inspection since ingest functions are not exported.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ingestSource = readFileSync(join(__dirname, "..", "ingest.ts"), "utf-8");

describe("ingestion banned cards support", () => {
  it("DraftMetadata interface includes bans field", () => {
    expect(ingestSource).toMatch(/interface DraftMetadata\s*\{[^}]*bans\?\s*:\s*string\[\]/);
  });

  it("computeImportHash includes metadata.json", () => {
    expect(ingestSource).toContain("metadata.json");
    // The hash function should reference metadata
    expect(ingestSource).toMatch(/metadataHash|hashFile\([^)]*metadata\.json/);
  });

  it("createDraft function accepts bannedCards parameter", () => {
    expect(ingestSource).toMatch(
      /function createDraft\([^)]*bannedCards:\s*string\s*\|\s*null/
    );
  });

  it("INSERT INTO drafts includes banned_cards column", () => {
    expect(ingestSource).toMatch(
      /INSERT INTO drafts\s*\([^)]*banned_cards[^)]*\)/
    );
  });

  it("INSERT has matching number of columns and placeholders (9)", () => {
    const insertMatch = ingestSource.match(
      /INSERT INTO drafts\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/
    );
    expect(insertMatch).not.toBeNull();

    const columns = insertMatch![1].split(",").map((s) => s.trim());
    const placeholders = insertMatch![2].split(",").map((s) => s.trim());

    expect(columns).toHaveLength(9);
    expect(placeholders).toHaveLength(9);
    expect(columns).toContain("banned_cards");
  });

  it("validates banned card names against pool", () => {
    // Should warn about unmatched ban names
    expect(ingestSource).toMatch(/[Ww]arning.*ban/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/__tests__/ingest-bans.test.ts`
Expected: FAIL (DraftMetadata doesn't have bans, createDraft doesn't have bannedCards, etc.)

- [ ] **Step 3: Add bans to DraftMetadata interface**

In `src/core/db/ingest.ts`, change the `DraftMetadata` interface (line 38):

```typescript
interface DraftMetadata {
  name: string;
  date: string;
  sheetId?: string;
  status?: string;
  bans?: string[];
}
```

- [ ] **Step 4: Add metadata.json to computeImportHash**

In `src/core/db/ingest.ts`, modify `computeImportHash` (line 105):

```typescript
function computeImportHash(draftPath: string): string {
  const picksHash = hashFile(join(draftPath, "picks.csv"));
  const poolHash = hashFile(join(draftPath, "pool.csv"));
  const matchesHash = hashFile(join(draftPath, "matches.csv"));
  const decklistsHash = hashFile(join(draftPath, "decklists.csv"));
  const metadataHash = hashFile(join(draftPath, "metadata.json"));
  const combined = `${picksHash}:${poolHash}:${matchesHash}:${decklistsHash}:${metadataHash}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}
```

- [ ] **Step 5: Add bannedCards parameter to createDraft**

In `src/core/db/ingest.ts`, modify the `createDraft` function (line 451):

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
  sheetId: string | null,
  bannedCards: string | null
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, import_hash, num_seats, is_complete, sheet_id, banned_cards)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draftId, draftName, draftDate, cubeSnapshotId, importHash, numSeats, isComplete ? 1 : 0, sheetId, bannedCards],
  });
}
```

- [ ] **Step 6: Add ban validation and pass bans to createDraft**

In `processDraftInner`, after pool card names are loaded (after line 683), add ban validation. Then update the `createDraft` call (around line 750).

After the `cardNameCounts` loop (line 683), add:

```typescript
  // Validate and normalize banned cards
  const bannedCardNames: string[] = [];
  if (metadata.bans && metadata.bans.length > 0) {
    const poolNameSet = new Set(
      Array.from(cardNameCounts.keys()).map((n) => n.toLowerCase())
    );
    for (const ban of metadata.bans) {
      const normalized = normalizeCardName(ban);
      if (!poolNameSet.has(normalized.toLowerCase())) {
        log(`Warning: Banned card "${ban}" not found in pool for ${draftId}`);
      } else {
        bannedCardNames.push(normalized);
      }
    }
    if (bannedCardNames.length > 0) {
      logIndent(`${bannedCardNames.length} banned card(s)`);
    }
  }
```

Update the `createDraft` call (around line 750) to pass the serialized bans:

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
    metadata.sheetId ?? null,
    bannedCardNames.length > 0 ? JSON.stringify(bannedCardNames) : null
  );
```

- [ ] **Step 7: Update the existing ingest-sheet-id test**

In `src/core/db/__tests__/ingest-sheet-id.test.ts`, update the column/placeholder count expectation from 8 to 9:

```typescript
  it("INSERT has matching number of columns and placeholders", () => {
    const insertMatch = ingestSource.match(
      /INSERT INTO drafts\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/
    );
    expect(insertMatch).not.toBeNull();

    const columns = insertMatch![1].split(",").map((s) => s.trim());
    const placeholders = insertMatch![2].split(",").map((s) => s.trim());

    expect(columns).toHaveLength(9);
    expect(placeholders).toHaveLength(9);
    expect(columns).toContain("sheet_id");
  });
```

- [ ] **Step 8: Run all tests to verify they pass**

Run: `pnpm test src/core/db/__tests__/`
Expected: All PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/db/ingest.ts src/core/db/__tests__/ingest-bans.test.ts src/core/db/__tests__/ingest-sheet-id.test.ts
git commit -m "Add banned cards support to ingestion pipeline

Read bans from metadata.json, validate against pool, store in DB.
Include metadata.json in import hash for change detection."
```

---

## Chunk 2: Stats Calculation (getCards.ts)

### Task 3: Exclude banned cards from unpicked entries and return bannedCardNames

**Files:**
- Modify: `src/core/getCards.ts:27-36` (CardStatsResponse type)
- Modify: `src/core/getCards.ts:91-96` (drafts SELECT query)
- Modify: `src/core/getCards.ts:125-146` (draft metadata loop — parse banned_cards)
- Modify: `src/core/getCards.ts:267-308` (unpicked entry generation)
- Modify: `src/core/getCards.ts:432-440` (takenCardNames section — add bannedCardNames)
- Modify: `src/core/getCards.ts:446-455` (return object)

- [ ] **Step 1: Add bannedCardNames to CardStatsResponse**

In `src/core/getCards.ts`, add to the type (line 35):

```typescript
export type CardStatsResponse = {
  cards: EnrichedCardStats[];
  draftCount: number;
  cubeCopies: Record<string, number>;
  draftMetadata: Record<string, { name: string; date: string }>;
  draftIds: string[];
  completedDraftIds: string[];
  ingestionHash: string;
  takenCardNames?: string[];
  bannedCardNames?: string[];
};
```

- [ ] **Step 2: Add banned_cards to the drafts SELECT query**

In `src/core/getCards.ts`, modify the SQL query (line 93):

```sql
SELECT d.draft_id, d.draft_name, d.draft_date, d.cube_snapshot_id, d.num_seats, d.is_complete, d.banned_cards
FROM drafts d
ORDER BY d.draft_date DESC
```

- [ ] **Step 3: Parse banned_cards per draft in the metadata loop**

After the existing loop that processes `draftsResult.rows` (around line 125-146), add a map for banned cards. Inside the loop, parse the JSON:

Add a new map declaration before the loop:

```typescript
const bannedCardsByDraft = new Map<string, Set<string>>();
```

Inside the `for (const row of draftsResult.rows)` loop, after `draftCubeSnapshots.set(...)`, add:

```typescript
    const bannedCardsJson = row.banned_cards as string | null;
    if (bannedCardsJson) {
      try {
        const names = JSON.parse(bannedCardsJson) as string[];
        bannedCardsByDraft.set(draftId, new Set(names.map(n => cardNameKey(n))));
      } catch {
        // Ignore malformed JSON
      }
    }
```

- [ ] **Step 4: Filter banned cards from unpicked entry generation**

In the unpicked entry loop (line 278), add a check for banned cards:

```typescript
    for (const [, cardInfo] of cubeCards) {
      const key = cardNameKey(cardInfo.cardName);

      // Skip banned cards — they get no entry (picked or unpicked) for this draft
      const draftBans = bannedCardsByDraft.get(draftId);
      if (draftBans?.has(key)) continue;

      const pickedCount = draftPicks.get(key)?.length || 0;
      // ... rest unchanged
```

- [ ] **Step 5: Return bannedCardNames for active draft**

After the `takenCardNames` block (line 440), add. Reuse the already-parsed `bannedCardsByDraft` map rather than re-parsing JSON:

```typescript
  // Get banned card names for active draft filtering
  let bannedCardNames: string[] | undefined;
  if (params.activeDraft) {
    const draftBans = bannedCardsByDraft.get(params.activeDraft);
    if (draftBans && draftBans.size > 0) {
      bannedCardNames = [...draftBans];
    }
  }
```

Update the return object to include `bannedCardNames`:

```typescript
  return {
    cards: allCards,
    draftCount: selectedDraftIds.length,
    cubeCopies,
    draftMetadata: draftMetadataObj,
    draftIds,
    completedDraftIds,
    ingestionHash,
    takenCardNames,
    bannedCardNames,
  };
```

- [ ] **Step 6: Run tests**

Run: `pnpm test src/core/getCards.test.ts`
Expected: PASS (existing integration tests should still pass since no drafts have bans yet)

- [ ] **Step 7: Commit**

```bash
git add src/core/getCards.ts
git commit -m "Exclude banned cards from unpicked penalty and return bannedCardNames

Query-time filtering skips banned cards during unpicked entry generation.
Returns bannedCardNames for active draft UI filtering."
```

---

## Chunk 3: Client-Side Filtering

### Task 4: Filter banned cards in PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx:160-177` (filtering logic)

- [ ] **Step 1: Write test for banned card filtering**

Add a test to `src/app/components/PageClient.test.tsx`:

```typescript
  it("filters out banned cards from display", () => {
    const props = makeTestProps({
      bannedCardNames: ["Lightning Bolt"],
    });
    render(<PageClient {...props} />);
    // With the only card banned, should show empty state
    const matches = screen.getAllByText("No card data available.");
    expect(matches.length).toBeGreaterThan(0);
  });
```

Note: This test relies on `makeTestProps` supporting `bannedCardNames` in the overrides, which it already does via the spread operator since `CardStatsResponse` will have the field.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/app/components/PageClient.test.tsx`
Expected: FAIL (banned cards not filtered yet, Lightning Bolt still shows)

- [ ] **Step 3: Add bannedCardNames filtering to PageClient**

In `src/app/components/PageClient.tsx`, add a `bannedCardNamesSet` memo after `takenCardNamesSet` (line 164):

```typescript
  const bannedCardNamesSet = useMemo(() => {
    if (!activeDraft || !cardData.bannedCardNames) return undefined;
    return new Set(cardData.bannedCardNames);
  }, [activeDraft, cardData.bannedCardNames]);
```

Update the `displayCards` memo to filter banned cards first:

```typescript
  const displayCards = useMemo(() => {
    let cards = cardData.cards;

    // Always filter out banned cards when active draft is selected
    if (bannedCardNamesSet) {
      cards = cards.filter((c) => !bannedCardNamesSet.has(c.cardName));
    }

    // Conditionally filter taken cards
    if (activeDraft && takenCardNamesSet && hideTaken) {
      cards = cards.filter((c) => !takenCardNamesSet.has(c.cardName));
    }

    return cards;
  }, [activeDraft, cardData, hideTaken, takenCardNamesSet, bannedCardNamesSet]);
```

Update `availableCount` to exclude banned cards:

```typescript
  const availableCount = useMemo(() => {
    if (!activeDraft || !takenCardNamesSet) return 0;
    return cardData.cards.filter(
      (c) => !takenCardNamesSet.has(c.cardName) && !bannedCardNamesSet?.has(c.cardName)
    ).length;
  }, [activeDraft, cardData, takenCardNamesSet, bannedCardNamesSet]);
```

- [ ] **Step 4: Refactor useSyncStatus mock for per-test control and write banned cards test**

The test for banned card filtering needs an active draft to be set. The current `useSyncStatus` mock returns a static value. Refactor it to use a mutable variable so individual tests can override the return value.

At the top of `PageClient.test.tsx`, replace the static `useSyncStatus` mock with a configurable one:

```typescript
let mockSyncStatus = {
  lastSyncedAt: "0",
  syncInProgress: false,
  activeDraftIds: [] as string[],
  triggerSync: async () => {},
  manualSyncInFlight: false,
  dataChanged: false,
};

vi.mock("../hooks/useSyncStatus", () => ({
  useSyncStatus: () => mockSyncStatus,
}));
```

In the `beforeEach`, reset it:

```typescript
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__settingsOnDraftsChange;
    mockSyncStatus = {
      lastSyncedAt: "0",
      syncInProgress: false,
      activeDraftIds: [],
      triggerSync: async () => {},
      manualSyncInFlight: false,
      dataChanged: false,
    };
  });
```

Then add the test:

```typescript
  it("filters out banned cards from display when active draft is selected", () => {
    // Configure mock to include an active draft
    mockSyncStatus = {
      ...mockSyncStatus,
      activeDraftIds: ["draft-c"],
    };

    // Set activeDraft in localStorage so PageClient picks it up
    localStorage.setItem("activeDraft", "draft-c");

    const props = makeTestProps({
      bannedCardNames: ["Lightning Bolt"],
    });
    render(<PageClient {...props} />);

    // The only card is banned + filtered, so we should see the empty state
    const emptyState = screen.queryAllByText("No card data available.");
    expect(emptyState.length).toBeGreaterThan(0);

    localStorage.removeItem("activeDraft");
  });
```

- [ ] **Step 5: Run tests**

Run: `pnpm test src/app/components/PageClient.test.tsx`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/components/PageClient.tsx src/app/components/PageClient.test.tsx
git commit -m "Filter banned cards from display during active drafts

Banned cards are always hidden (not dimmed) when an active draft is
selected. Available count excludes banned cards."
```

---

### Task 5: Verify end-to-end (manual)

- [ ] **Step 1: Run all tests**

Run: `pnpm test`
Expected: All PASS

- [ ] **Step 2: Run the build**

Run: `pnpm build`
Expected: Build succeeds with no type errors

- [ ] **Step 3: Commit any fixes if needed**

---

### Task 6: Final commit and cleanup

- [ ] **Step 1: Verify git status is clean**

Run: `git status`
Expected: Clean working tree (all changes committed)
