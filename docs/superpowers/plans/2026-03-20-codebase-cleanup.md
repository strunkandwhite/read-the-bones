# Codebase Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up unused code, split overgrown files, fix broken tests, and get the pre-commit hook passing.

**Architecture:** Three files have outgrown their boundaries: `queries.ts` (2061 lines, 43 exports), `ingest.ts` (1462 lines), and `PageClient.tsx` (536 lines, 33 hooks). Each gets split into focused modules. Dead code identified by Knip gets removed. Brittle tests get replaced with functional ones.

**Tech Stack:** TypeScript, Next.js, React, Vitest, Turso (libsql), Knip

---

## Chunk 1: Quick Wins — Get Pre-commit Passing

### Task 1: Configure Knip

Knip reports false positives for some exports used only at build/ingest time.

**Files:**
- Create: `knip.json`

- [ ] **Step 1: Create knip.json**

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": [
    "src/app/**/*.{ts,tsx}",
    "scripts/*.ts",
    "src/core/db/migrate.ts"
  ],
  "project": ["src/**/*.{ts,tsx}", "scripts/**/*.ts"],
  "ignore": [
    "src/core/db/schema.ts"
  ],
  "ignoreDependencies": ["postcss"]
}
```

The `ignore` for `schema.ts` keeps the DB documentation types from being flagged. The `ignoreDependencies` for `postcss` silences the "unlisted" warning (it's a transitive dep from Tailwind's PostCSS plugin).

- [ ] **Step 2: Run knip and verify reduced findings**

Run: `pnpm knip`
Expected: Only legitimate unused items remain (metadataToMap, formatColors, barrel file). CLI-related false positives should be gone.

- [ ] **Step 3: Commit**

```bash
git add knip.json
git commit -m "Add Knip configuration with CLI and script entry points"
```

---

### Task 2: Delete Dead Code

Remove confirmed unused code and the barrel file.

**Files:**
- Modify: `src/core/calculateStats.ts` (remove `metadataToMap`, lines 199-207)
- Modify: `src/core/colors.ts` (remove `formatColors`, lines 35-40)
- Modify: `src/app/components/PageClient.tsx` (update imports before barrel deletion)
- Delete: `src/app/components/index.ts`

- [ ] **Step 1: Remove metadataToMap from calculateStats.ts**

Delete the exported function `metadataToMap` (lines 199-207). Also remove the `DraftMetadata` import if it becomes unused after this removal.

- [ ] **Step 2: Remove formatColors from colors.ts**

Delete the exported function `formatColors` (lines 35-40). Also remove `getColorLabel` import/function if it's only used by `formatColors`. Check first — `getColorLabel` may be used elsewhere.

- [ ] **Step 3: Update PageClient.tsx imports and delete the barrel file**

`PageClient.tsx` line 4 imports from the barrel: `import { ActiveDraftIndicator, CardTable, ColorFilter, Settings } from "./index"`. Replace with direct imports from individual component files:

```typescript
import { ActiveDraftIndicator } from "./ActiveDraftIndicator";
import { CardTable } from "./CardTable";
import { ColorFilter } from "./ColorFilter";
import { Settings } from "./Settings";
```

Then delete `src/app/components/index.ts`.

- [ ] **Step 4: Run knip to verify**

Run: `pnpm knip`
Expected: These items no longer appear. Remaining findings (if any) should only be items we've consciously decided to keep.

- [ ] **Step 5: Commit**

```bash
git commit -m "Remove dead code: metadataToMap, formatColors, component barrel file"
```

---

### Task 3: Investigate and Clean Up isOptedOut

`isOptedOut` in `src/core/optOuts.ts` is exported and mocked in `toolExecutor.test.ts` but never actually imported by production code. Determine if it's dead or incomplete.

**Files:**
- Modify: `src/core/optOuts.ts`

- [ ] **Step 1: Search for usage**

Search for `isOptedOut` across the codebase (the CLI that previously used it has been removed).

- [ ] **Step 2: If unused in production code, remove it**

Remove `isOptedOut` from `optOuts.ts`.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass (except the known PageClient failure, addressed in Task 4).

- [ ] **Step 4: Commit**

```bash
git commit -m "Remove unused isOptedOut function and stale test mock"
```

---

### Task 4: Fix Failing PageClient Test

The test "displays correct card count in header" expects `/1 cards from 2 drafts/` but the header now renders "Showing data from {n} draft(s)".

**Files:**
- Modify: `src/app/components/PageClient.test.tsx`

- [ ] **Step 1: Read PageClient.tsx header rendering**

Find the current subheader text near lines 319-330. Note the exact format string.

- [ ] **Step 2: Update the test assertion**

The test at line 101-106 should match the current header text. Update the regex to match the actual format: "Showing data from {n} draft(s)" or whatever the current text is. If the test is now redundant with another test (e.g., "shows precomputed data with default selection" already checks the subheader), delete it instead.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "Fix stale PageClient test assertion to match current header text"
```

---

### Task 5: Add postcss and Clean Up Unused Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add postcss as explicit devDependency**

Run: `pnpm add -D postcss`

- [ ] **Step 2: Remove unused dependencies (if confirmed by Knip after config)**

After Task 1's Knip config is in place, re-check whether any dependencies are still flagged. Only remove deps that Knip still flags after proper configuration.

- [ ] **Step 3: Run pre-commit checks**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, and tests all pass. This is the green baseline.

- [ ] **Step 4: Commit**

```bash
git commit -m "Add postcss as explicit devDependency"
```

---

## Chunk 2: Split queries.ts into Domain Modules

`src/core/db/queries.ts` is 2061 lines with 43 exports serving two audiences (web app and CLI). Split into focused modules by domain.

### Target Structure

```
src/core/db/queries/
  helpers.ts      — Shared utilities (getOptedOutSeats, parseScryfallJson, matchesColorFilter, etc.)
  cards.ts        — Card resolution (resolveCard, resolveCardFuzzy, lookupCard)
  drafts.ts       — Draft metadata (listDrafts, getDraft)
  picks.ts        — Pick queries (getPicks, getAvailableCards, getStandings)
  pool.ts         — Draft pool with grouping (getDraftPool)
  decklists.ts    — Deck queries (getDeck, getCardPlayStats, getCardWinStats)
  stats.ts        — Aggregate stats (getCardPickStats, getCardStats, rankAvailableCards)
  index.ts        — Barrel re-export (toolExecutor.ts imports `* as queries`)
```

### Internal Dependency Map

These helpers are shared across modules and must live in `helpers.ts`:

| Helper | Used By |
|--------|---------|
| `getOptedOutSeats` | picks, pool, decklists |
| `parseScryfallJson` | cards, picks, pool |
| `matchesColorFilter` | picks, pool |
| `getSeatsMatchingColors` | decklists, stats |
| `rowToCard` | cards |
| `fetchFromScryfallApi` | cards |

**Important:** Every query module calls `const client = await getClient()` directly. Each module file must import `getClient` from `../client`. Do not forget this import — it is the most common dependency across all modules.

### Task 6: Create queries/helpers.ts

**Files:**
- Create: `src/core/db/queries/helpers.ts`

- [ ] **Step 1: Create helpers.ts with shared utilities**

Move these functions from `queries.ts` to `queries/helpers.ts`:
- `getOptedOutSeats` (line 20) — keep unexported, export from helpers
- `rowToCard` (line 52) — keep unexported, export from helpers
- `parseScryfallJson` (line 134) — keep unexported, export from helpers
- `matchesColorFilter` (line 148) — keep unexported, export from helpers
- `getSeatsMatchingColors` (line 164) — keep unexported, export from helpers
- `fetchFromScryfallApi` (line 246) — keep unexported, export from helpers

Include all necessary imports at the top:
```typescript
import { getClient } from "../client";
import type { Card, ScryfallCardData } from "../schema";
import { SCRYFALL_API_BASE, transformApiResponse, type ScryfallApiResponse } from "../../scryfallApi";
```

**Note:** `getClient` is re-exported from helpers for convenience, but each module may also import it directly from `../client`.

- [ ] **Step 2: Verify helpers.ts compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract shared query helpers into queries/helpers.ts"
```

---

### Task 7: Create queries/cards.ts

**Files:**
- Create: `src/core/db/queries/cards.ts`

- [ ] **Step 1: Move card resolution functions**

Move from `queries.ts`:
- `resolveCard` (line 33)
- `FuzzyCardMatch` interface (line 42)
- `FuzzyCardResult` interface (line 47)
- `resolveCardFuzzy` (line 66)
- `LookupCardResult` interface (line 233)
- `lookupCard` (line 276)

Import `getClient` from `../client`. Import helpers: `rowToCard`, `parseScryfallJson`, `fetchFromScryfallApi` from `./helpers`.

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract card resolution queries into queries/cards.ts"
```

---

### Task 8: Create queries/drafts.ts

**Files:**
- Create: `src/core/db/queries/drafts.ts`

- [ ] **Step 1: Move draft metadata functions**

Move from `queries.ts`:
- `DraftListItem` interface (line 301)
- `ListDraftsFilters` interface (line 307)
- `listDrafts` (line 317)
- `DraftDetails` interface (line 358)
- `getDraft` (line 369)

Import `getClient` from `../client`. These have no other internal dependencies.

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract draft metadata queries into queries/drafts.ts"
```

---

### Task 9: Create queries/picks.ts

**Files:**
- Create: `src/core/db/queries/picks.ts`

- [ ] **Step 1: Move pick and standings functions**

Move from `queries.ts`:
- `GetPicksParams` interface (line 397)
- `PicksResult` interface (line 405)
- `getPicks` (line 421)
- `GetAvailableCardsParams` interface (line 498)
- `AvailableCardsResult` interface (line 505)
- `getAvailableCards` (line 521)
- `StandingsEntry` interface (line 620)
- `StandingsResult` interface (line 628)
- `getStandings` (line 638)

Import `getClient` from `../client`. Import from helpers: `getOptedOutSeats` (used by `getPicks`, `getStandings`), `parseScryfallJson` (used by `getAvailableCards`), `matchesColorFilter` (used by `getAvailableCards`).

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract pick and standings queries into queries/picks.ts"
```

---

### Task 10: Create queries/pool.ts

**Files:**
- Create: `src/core/db/queries/pool.ts`

- [ ] **Step 1: Move draft pool functions**

Move from `queries.ts`:
- `GetDraftPoolParams` interface (line 974)
- `PoolCard` interface (line 984)
- `DraftPoolResult` interface (line 996)
- `normalizeColorIdentity` helper (line 1010)
- `extractMajorTypes` helper (line 1023)
- `groupPoolByColor` helper (line 1048)
- `groupPoolByType` helper (line 1068)
- `getDraftPool` (line 1101)

Import `getClient` from `../client`. Import from helpers: `getOptedOutSeats`, `parseScryfallJson`, `matchesColorFilter`.

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract draft pool queries into queries/pool.ts"
```

---

### Task 11: Create queries/decklists.ts

**Files:**
- Create: `src/core/db/queries/decklists.ts`

- [ ] **Step 1: Move decklist functions**

Move from `queries.ts`:
- `GetDeckParams` interface (line 1250)
- `DeckResult` interface (line 1255)
- `getDeck` (line 1267)
- `GetCardPlayStatsParams` interface (line 1310)
- `CardPlayStatsResult` interface (line 1316)
- `getCardPlayStats` (line 1328)
- `GetCardWinStatsParams` interface (line 1413)
- `CardWinStatsResult` interface (line 1419)
- `getCardWinStats` (line 1432)

Import `getClient` from `../client`. Import from helpers: `getOptedOutSeats` (used by `getDeck`), `getSeatsMatchingColors` (used by `getCardPlayStats`, `getCardWinStats`). Import from cards: `resolveCard` (used by `getCardPlayStats`, `getCardWinStats`).

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract decklist queries into queries/decklists.ts"
```

---

### Task 12: Create queries/stats.ts

**Files:**
- Create: `src/core/db/queries/stats.ts`

- [ ] **Step 1: Move stats functions**

Move from `queries.ts`:
- `GetCardPickStatsParams` interface (line 729)
- `CardPickStatsResult` interface (line 736)
- `getCardPickStats` (line 753)
- `GetCardStatsParams` interface (line 1529)
- `CardStatsResult` interface (line 1538)
- `getCardStats` (line 1577)
- `RankAvailableCardsParams` interface (line 1697)
- `RankedCard` interface (line 1711)
- `RankAvailableCardsResult` interface (line 1724)
- `rankAvailableCards` (line 1735)

Import `getClient` from `../client`. Import from helpers: `getSeatsMatchingColors` (used by `rankAvailableCards`). Import from cards: `resolveCard` (used by `getCardPickStats`), `lookupCard` (used by `getCardStats`). Import from picks: `getAvailableCards` (used by `rankAvailableCards`). Import from decklists: `getCardPlayStats`, `getCardWinStats` (used by `getCardStats`). Import from `../../utils`: `calculatePickWeight`, `weightedGeometricMean`, `wilsonInterval`. Import from `../../types`: `DEFAULT_POOL_SIZE`.

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract card stats queries into queries/stats.ts"
```

---

### Task 13: Create queries/index.ts and Update Consumers

**Files:**
- Create: `src/core/db/queries/index.ts`
- Delete: `src/core/db/queries.ts` (the original monolith)
- Modify: `src/core/db/queries.test.ts` (update import path)
- Modify: `src/core/db/queries.decklist.test.ts` (update import path)
- Modify: any other files importing from `./queries` or `../db/queries`

- [ ] **Step 1: Create barrel index.ts**

Re-export everything from each module:

```typescript
export * from "./helpers";
export * from "./cards";
export * from "./drafts";
export * from "./picks";
export * from "./pool";
export * from "./decklists";
export * from "./stats";
```

- [ ] **Step 2: Update all import paths**

Search for all files importing from `queries.ts` or `queries`:
- `src/core/db/queries.test.ts`: update import path
- `src/core/db/queries.decklist.test.ts`: update import path
- Any other consumers found by grep

- [ ] **Step 3: Delete the original queries.ts**

Only after all imports are updated and pointing to the new barrel.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 5: Run typecheck and knip**

Run: `pnpm typecheck && pnpm knip`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git commit -m "Replace monolithic queries.ts with domain-based query modules"
```

---

## Chunk 3: Split ingest.ts into Domain Modules

`src/core/db/ingest.ts` is 1462 lines handling discovery, Scryfall caching, card resolution, full import, incremental sync, and CLI argument parsing. Split into focused modules.

### Target Structure

```
src/core/db/ingest/
  utils.ts          — Logging, hashing, env loading
  discover.ts       — Scan data/ for draft folders
  scryfall.ts       — Load/fetch/backfill Scryfall cache
  db-helpers.ts     — Thin INSERT/DELETE wrappers and card/cube operations
  incremental.ts    — incrementalPicks, incrementalMatches, incrementalDecklists
  full-import.ts    — processDraftInner (full draft import)
  index.ts          — processDraft router, parseIngestArgs, main()
```

`src/core/db/ingest.ts` stays as the CLI entry point, but becomes a thin wrapper:

```typescript
import { main } from "./ingest/index";
main();
```

### Task 14: Create ingest/utils.ts

**Files:**
- Create: `src/core/db/ingest/utils.ts`

- [ ] **Step 1: Move utility functions**

Move from `ingest.ts`:
- `loadEnv` (line 73)
- `log` (line 82)
- `logIndent` (line 86)
- `generateOracleId` (line 102)
- `hashFile` (line 110)
- `computeImportHash` (line 119)
- `computeCubeHash` (line 132)
- `DraftMetadata` interface (line 51)
- `PROJECT_ROOT` and `__dirname` constants (line 45) — these are used by multiple modules (`discoverDrafts`, `loadScryfallCache`, `main`), so they belong in utils where all modules can import them.

- [ ] **Step 2: Verify compiles**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git commit -m "Extract ingest utility functions into ingest/utils.ts"
```

---

### Task 15: Create ingest/discover.ts

**Files:**
- Create: `src/core/db/ingest/discover.ts`

- [ ] **Step 1: Move discovery logic**

Move from `ingest.ts`:
- `DraftFolder` interface (line 59)
- `discoverDrafts` (line 151)

- [ ] **Step 2: Commit**

```bash
git commit -m "Extract draft discovery into ingest/discover.ts"
```

---

### Task 16: Create ingest/scryfall.ts

**Files:**
- Create: `src/core/db/ingest/scryfall.ts`

- [ ] **Step 1: Move Scryfall cache functions**

Move from `ingest.ts`:
- `loadScryfallCache` (line 202)
- `fetchMissingScryfallCards` (line 225)
- `backfillScryfallData` (line 585)
- `SCRYFALL_CACHE_PATH` constant
- `RATE_LIMIT_DELAY_MS` constant

- [ ] **Step 2: Commit**

```bash
git commit -m "Extract Scryfall cache management into ingest/scryfall.ts"
```

---

### Task 17: Create ingest/db-helpers.ts

**Files:**
- Create: `src/core/db/ingest/db-helpers.ts`

- [ ] **Step 1: Move DB operation functions**

Move from `ingest.ts`:
- `getDraftImportHash` (line 265)
- `deleteDraft` (line 284)
- `createDraft` (line 735)
- `insertPickEvent` (line 757)
- `insertMatchEvent` (line 773)
- `insertOptOuts` (line 792)
- `ensureCard` (line 545)
- `ensureCubeSnapshot` (line 635)

- [ ] **Step 2: Commit**

```bash
git commit -m "Extract ingest DB helpers into ingest/db-helpers.ts"
```

---

### Task 18: Create ingest/incremental.ts

**Files:**
- Create: `src/core/db/ingest/incremental.ts`

- [ ] **Step 1: Move incremental sync functions**

Move from `ingest.ts`:
- `incrementalPicks` (line 312)
- `incrementalMatches` (line 358)
- `incrementalDecklists` (line 416)
- `incrementalIngestDraft` (line 890)

These import from `../../sync` and `../../parseMatches`. Keep those imports.

- [ ] **Step 2: Commit**

```bash
git commit -m "Extract incremental ingestion into ingest/incremental.ts"
```

---

### Task 19: Create ingest/full-import.ts

**Files:**
- Create: `src/core/db/ingest/full-import.ts`

- [ ] **Step 1: Move full import functions**

Move from `ingest.ts`:
- `processDraftInner` (line 1017)
- `ingestDecklists` (line 819)

These are the largest functions. They import from utils, db-helpers, and scryfall modules.

- [ ] **Step 2: Commit**

```bash
git commit -m "Extract full draft import into ingest/full-import.ts"
```

---

### Task 20: Create ingest/index.ts and Update Entry Point

**Files:**
- Create: `src/core/db/ingest/index.ts`
- Modify: `src/core/db/ingest.ts` (becomes thin entry point)
- Modify: test files that import from `ingest.ts`

- [ ] **Step 1: Create orchestrator index.ts**

Move from `ingest.ts`:
- `processDraft` (line 971)
- `parseIngestArgs` (line 946)
- `main` (line 1314)

Re-export public API:
```typescript
export { incrementalPicks, incrementalMatches, incrementalDecklists } from "./incremental";
export { parseIngestArgs } from "./index"; // or keep in same file
```

- [ ] **Step 2: Reduce ingest.ts to entry point**

Replace `src/core/db/ingest.ts` with a thin wrapper that preserves the `isDirectRun` guard. This is critical — without it, importing from `ingest.ts` in tests would trigger `main()` execution.

```typescript
import { main } from "./ingest/index";

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("/ingest.ts") ||
    process.argv[1].endsWith("/ingest.js"));

if (isDirectRun) {
  main().catch((error) => {
    console.error("[ingest] Fatal error:", error);
    process.exit(1);
  });
}
```

Note: Tests should import from `./ingest/incremental` or `./ingest/index` directly, not from `ingest.ts`.

- [ ] **Step 3: Update test imports**

Update `src/core/db/__tests__/incremental-ingest.test.ts` to import from the new module paths.

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass.

- [ ] **Step 5: Run typecheck and knip**

Run: `pnpm typecheck && pnpm knip`

- [ ] **Step 6: Commit**

```bash
git commit -m "Replace monolithic ingest.ts with domain-based ingest modules"
```

---

## Chunk 4: Extract PageClient Custom Hooks

`PageClient.tsx` has 536 lines with 33 hooks managing draft selection, data fetching, search, and filtering. Extract into focused custom hooks.

### Target Structure

```
src/app/hooks/
  useSyncStatus.ts        — (already exists)
  useDraftSelection.ts    — Draft selection + localStorage + active draft
  useCardData.ts          — API fetching for cards + stats
  useCardSearch.ts        — Search query + Scryfall operators + color filter
  useCardFiltering.ts     — Taken/banned filtering + display cards
```

### Task 21: Extract useDraftSelection Hook

**Files:**
- Create: `src/app/hooks/useDraftSelection.ts`
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Create the hook**

Extract from PageClient:
- `selectedDrafts` + `setSelectedDrafts` state
- `activeDraft` + `setActiveDraft` state
- `hideTaken` + `setHideTaken` state
- `hydrated` state
- Effect: localStorage hydration (lines 44-50)
- Effect: activeDraft persistence (lines 53-60)
- Effect: hideTaken persistence (lines 62-65)
- Effect: sync-driven active draft invalidation (lines 71-75)

**Interface:**
```typescript
interface UseDraftSelectionProps {
  initialDraftIds: string[];
  completedDraftIds: string[];
  activeDraftIds: string[];
}

interface UseDraftSelectionReturn {
  selectedDrafts: Set<string>;
  setSelectedDrafts: (drafts: Set<string>) => void;
  activeDraft: string | null;
  setActiveDraft: (draft: string | null) => void;
  hideTaken: boolean;
  setHideTaken: (hide: boolean) => void;
  hydrated: boolean;
}
```

- [ ] **Step 2: Update PageClient to use the hook**

Replace the 4 useState + 4 useEffect blocks with a single `useDraftSelection(...)` call.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Commit**

```bash
git commit -m "Extract useDraftSelection hook from PageClient"
```

---

### Task 22: Extract useCardData Hook

**Files:**
- Create: `src/app/hooks/useCardData.ts`
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Create the hook**

Extract from PageClient:
- `cardData` + `setCardData` state
- `draftStats` + `setDraftStats` state
- `isLoading` + `setIsLoading` state
- `fetchCardData` callback (lines 94-139)
- `handleDraftsChange` callback (lines 142-148)
- Effect: refetch on sync data change (lines 151-155)
- Effect: refetch on active draft change (lines 159-165) + the `activeDraftInitializedRef`

**Interface:**
```typescript
interface UseCardDataProps {
  initialCardData: CardStatsResponse;
  initialDraftStats: DraftStatsResponse;
  selectedDrafts: Set<string>;
  activeDraft: string | null;
  syncDataChanged: boolean;
}

interface UseCardDataReturn {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;
  handleDraftsChange: (drafts: Set<string>) => Promise<void>;
}
```

- [ ] **Step 2: Update PageClient**

Replace the state + callbacks + effects with `useCardData(...)`.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Commit**

```bash
git commit -m "Extract useCardData hook from PageClient"
```

---

### Task 23: Extract useCardSearch Hook

**Files:**
- Create: `src/app/hooks/useCardSearch.ts`
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Create the hook**

Extract from PageClient:
- `searchQuery` + `setSearchQuery` state
- `colorFilter` + `setColorFilter` state
- `colorFilterMode` + `setColorFilterMode` state
- `scryfallSearchResults` + `setScryfallSearchResults` state
- Effect: debounced Scryfall search (lines 233-255)
- Memo: `scryfallCards` (lines 226-230)
- Memo: `scryfallMatchNames` (lines 265-277)
- `clearSearch` callback (lines 258-261)

**Interface:**
```typescript
interface UseCardSearchProps {
  cards: CardStats[];
}

interface UseCardSearchReturn {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  colorFilter: string[];
  setColorFilter: (colors: string[]) => void;
  colorFilterMode: ColorFilterMode;
  setColorFilterMode: (mode: ColorFilterMode) => void;
  scryfallMatchNames: Set<string> | null;
  clearSearch: () => void;
}
```

- [ ] **Step 2: Update PageClient**

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Commit**

```bash
git commit -m "Extract useCardSearch hook from PageClient"
```

---

### Task 24: Extract useCardFiltering Hook

**Files:**
- Create: `src/app/hooks/useCardFiltering.ts`
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Create the hook**

Extract from PageClient:
- Memo: `takenCardNamesSet` (lines 168-171)
- Memo: `bannedCardNamesSet` (lines 173-176)
- Callback: `isBanned` (lines 178-185)
- Memo: `displayCards` (lines 187-201)
- Memo: `availableCount` (lines 203-208)
- Memo: `filteredDisplayedCards` (lines 280-285)
- Memo: `searchFilteredCards` (lines 288-297)

**Interface:**
```typescript
interface UseCardFilteringProps {
  cardData: CardStatsResponse;
  activeDraft: string | null;
  hideTaken: boolean;
  searchQuery: string;
  scryfallMatchNames: Set<string> | null;
}

interface UseCardFilteringReturn {
  displayCards: CardStats[];
  searchFilteredCards: CardStats[];
  availableCount: number;
  takenCardNamesSet: Set<string> | undefined;
}
```

- [ ] **Step 2: Update PageClient**

PageClient should now be mostly orchestration: call hooks, pass results to child components.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Run full pre-commit suite**

Run: `pnpm precommit`
Expected: All checks pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "Extract useCardFiltering hook from PageClient"
```

---

## Chunk 5: Test Improvements

### Task 25: Replace Brittle Code-Based Ingest Tests

`ingest-bans.test.ts` and `ingest-sheet-id.test.ts` read source code with regex to verify SQL patterns exist. Replace with functional tests.

**Files:**
- Rewrite: `src/core/db/__tests__/ingest-bans.test.ts`
- Rewrite: `src/core/db/__tests__/ingest-sheet-id.test.ts`

- [ ] **Step 1: Rewrite ingest-bans.test.ts**

Instead of regex-matching source code, test that the `createDraft` function (now in `ingest/db-helpers.ts`) accepts a `bannedCards` parameter and includes it in the INSERT. Use a mock libsql client (same pattern as `queries.test.ts`) to capture the SQL and verify the banned_cards column is populated.

If `createDraft` is a thin wrapper that's hard to unit test, an alternative: test `processDraftInner` with a mock client and a test data directory that includes bans in metadata.json, and verify the draft row contains banned_cards.

- [ ] **Step 2: Rewrite ingest-sheet-id.test.ts**

Same approach: test that `createDraft` passes sheet_id through to the INSERT. Use mock client to capture SQL params.

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: New tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git commit -m "Replace brittle code-pattern ingest tests with functional tests"
```

---

### Task 26: Write Tests for Extracted Hooks

The existing PageClient tests are heavily mocked and test infrastructure more than behavior. Now that logic is in hooks, write focused hook tests.

**Files:**
- Create: `src/app/hooks/useDraftSelection.test.ts`
- Create: `src/app/hooks/useCardSearch.test.ts`
- Create: `src/app/hooks/useCardFiltering.test.ts`

- [ ] **Step 1: Write useDraftSelection tests**

Use `renderHook` from `@testing-library/react`. Test:
- Initial state matches provided completedDraftIds
- localStorage hydration sets activeDraft
- Changing activeDraft persists to localStorage
- Active draft cleared when removed from activeDraftIds

- [ ] **Step 2: Write useCardSearch tests**

Test:
- Debounced search fires after 500ms
- Search clears when query is empty
- Scryfall operators trigger structured search
- Plain text doesn't trigger structured search

- [ ] **Step 3: Write useCardFiltering tests**

Test:
- Banned cards filtered from display
- Taken cards filtered when hideTaken is true
- Taken cards shown when hideTaken is false
- availableCount excludes taken and banned

- [ ] **Step 4: Run full test suite**

Run: `pnpm test`
Expected: All pass.

- [ ] **Step 5: Run pre-commit**

Run: `pnpm precommit`
Expected: All checks pass. This is the final green state.

- [ ] **Step 6: Commit**

```bash
git commit -m "Add focused tests for extracted PageClient hooks"
```

---

## Execution Notes

**Task dependencies:**
- Chunk 1 (Tasks 1-5) must complete first to establish the green baseline
- Chunks 2, 3, and 4 are independent of each other and can be parallelized
- Chunk 5 depends on Chunks 3 and 4 (tests reference new file structure)

**Parallelization opportunities:**
- Tasks 6-12 (queries split) are sequential (each depends on helpers.ts existing)
- Tasks 14-19 (ingest split) are sequential
- Tasks 21-24 (hook extraction) are sequential
- But the three sequences (queries, ingest, hooks) can run in parallel

**Key risks:**
- The queries.test.ts and queries.decklist.test.ts files import specific functions. After the split, they should import from the barrel `queries/index.ts` to minimize churn. Alternatively, update to import from specific modules for clarity.
- After Chunks 2-3, update `knip.json` entry points if needed. The ingest entry point (`src/core/db/ingest.ts`) becomes a thin wrapper — Knip should still trace through to `./ingest/index`. Verify with `pnpm knip` after each chunk.
