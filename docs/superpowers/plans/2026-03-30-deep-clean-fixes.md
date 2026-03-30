# Deep Clean Fixes — 2026-03-30

Post-data-flow-consolidation audit fixes. 31 items across 7 domains.

## Chunk 1: Quick Fixes (no dependencies, parallelizable)

### Task 1: Fix Set-in-filter O(n*m) bug
**Files:** `src/core/getCards.ts:457`, `src/core/getDraftStats.ts:217`
- Create Set once outside `.filter()` loop instead of per iteration

### Task 2: Consolidate `isAuthed` into a selector
**Files:** `src/app/stores/selectors.ts`, then update 7 consumer files
- Export `getIsAuthed()` from `selectors.ts`
- Replace inline `mySeat !== null && mySeat === selectedSeat` in: PageClient, CardStatsModal, DeckBuilderPanel, Settings, DraftBoardModal, liveStore syncDeckWithPicks

### Task 3: Fix `display_name` type validation
**Files:** `src/app/api/drafts/[id]/seat-settings/route.ts`
- Reject non-string, non-null `display_name` values before the length check

### Task 4: Fix `flushDeckSave` silent failure
**Files:** `src/app/stores/liveStore.ts`
- Set `deckSaveStatus` to `"idle"` in the catch block (not an error state — the dirty flag ensures retry)
- Schedule a retry timer (e.g., 5s) on failure

### Task 5: Debounce `fetchCardData` to prevent duplicate calls
**Files:** `src/app/stores/cardStore.ts`
- Add a 50ms debounce to `fetchCardData` to coalesce rapid subscription triggers
- Skip if a fetch is already in-flight with the same params

### Task 6: Fix shared deck overwrite
**Files:** `src/app/hooks/useSharedDeckLoader.ts`, `src/app/stores/liveStore.ts`
- Track a `viewingSharedDeck` flag in liveStore
- Skip `fetchDeckState` when `viewingSharedDeck` is true

### Task 7: Extract `cardNameKey` to `cardNames.ts`
**Files:** `src/core/parseSheetRows.ts`, `src/core/cardNames.ts`, update importers

### Task 8: Extract duplicated constants
**Files:** Create `src/core/constants.ts`
- `MIN_SAMPLE_SIZE = 5` (from cardStats.ts, rankedAvailable.ts)
- `DEFAULT_NUM_SEATS = 10` (from getCards.ts, sync.ts)
- Extract SQL `placeholders(n)` utility to `src/core/db/queries/helpers.ts`

---

## Chunk 2: Query Optimizations (independent of each other)

### Task 9: Scope `getCards` query to selected draftIds
**Files:** `src/core/getCards.ts`
- Pass `draftIds` to `loadPickEvents` and `loadCubeCards`
- Add `WHERE draft_id IN (...)` clause
- Derive draftIds from params before calling these functions

### Task 10: Parallelize `pickStats` sub-queries
**Files:** `src/core/db/queries/stats/pickStats.ts`
- After `draftsWithCardResult`, run `bannedResult`, `picksResult`, `cubeSizesResult`, `optOutResult`, `deckCardsResult` in parallel via `Promise.all`

### Task 11: Batch float inserts in queue PUT
**Files:** `src/app/api/drafts/[id]/queue/route.ts`
- Replace per-card `addFloatedCard` calls with `client.batch()` for all removed cards

### Task 12: Optimize processPick cascade where safe
**Files:** `src/core/processPick.ts`
- Parallelize queue-containing-card check with the copy-check query where they don't depend on each other
- Pre-fetch banned cards list before the loop

---

## Chunk 3: Code Deduplication (ordered by dependency)

### Task 13: Extract shared match aggregation helper
**Files:** Create helper in `src/core/db/queries/matches.ts`, update `decklists.ts` and `picks.ts`
- Extract the match-result aggregation loop (iterate match_events, compute wins/losses per seat) into a shared function

### Task 14: Extract shared deck color inference
**Files:** Consolidate into `src/core/db/queries/helpers.ts` (`getSeatsMatchingColors` already exists there), update `decklists.ts` and `getDraftStats.ts`
- Remove inline implementations, import the shared helper

### Task 15: Unify opt-out abstractions
**Files:** `src/core/db/queries/helpers.ts`, `src/core/db/queries/decklists.ts`
- Add a `draftId` overload to `fetchOptOuts` so it handles both single-draft and multi-draft cases
- Remove `getOptedOutSeats` or make it call `fetchOptOuts` internally

---

## Chunk 4: Test Coverage

### Task 16: Add mock-based tests for `getCards.ts`
**Files:** `src/core/getCards.test.ts`
- Replace the skipped Turso-dependent tests with mock-based tests
- Mock `getClient()` and verify: draft metadata resolution, pick aggregation, cube snapshot filtering, Scryfall enrichment, ingestion hash computation
- Test with multiple drafts, empty drafts, activeDraft parameter

### Task 17: Add mock-based tests for `getDraftStats.ts`
**Files:** `src/core/getDraftStats.test.ts`
- Same approach: mock DB client, test win rate by seat, win rate by color, ingestion hash

### Task 18: Add tests for untested `sync.ts` functions
**Files:** `src/core/__tests__/sync.test.ts`
- Add tests for: `insertNewPicks`, `markDraftComplete`, `incrementalIngest`, `acquireSyncLock`, `releaseSyncLock`, `updateLastSyncedAt`, `getSyncStatus`, `getActiveDrafts`

### Task 19: Add `removeFloatedCardByCardId` verification to processPick test
**Files:** `src/core/processPick.test.ts`
- Assert that `removeFloatedCardByCardId` is called with correct args when `isLastCopy` is true

### Task 20: Add tests for `snakeDraft.ts` functions
**Files:** `src/core/snakeDraft.test.ts`
- Test `getNextPick`: normal case, null when all picks made, edge cases
- Test `buildPickMatrix`: correct grid layout, empty draft

### Task 21: Add tests for 3 untested API routes
**Files:** Create test files for `/api/cards`, `/api/draft-stats`, `/api/sync-status`
- Test parameter parsing, cache-control headers, error handling

---

## Chunk 5: Minor Fixes & Polish

### Task 22: Reduce sync-status poll frequency for live drafts
**Files:** `src/app/stores/draftStore.ts`
- Poll `/api/sync-status` every 3rd cycle (30s) instead of every cycle

### Task 23: Fix `recompute()` to skip Map rebuilds when only filter state changed
**Files:** `src/app/stores/cardStore.ts`
- Track `cardData` reference; only rebuild `scryfallDataMap`/`cardStatsMap` when `cardData` changes

### Task 24: Debounce `syncDeckWithPicks` subscriptions
**Files:** `src/app/stores/liveStore.ts`
- Add 50ms debounce to consolidate rapid subscription triggers

### Task 25: Consolidate `deckBuilderActive` to one location
**Files:** `src/app/stores/liveStore.ts`, `src/app/hooks/useModalManagement.ts`, `src/app/components/PageClient.tsx`
- Remove from useModalManagement, read from liveStore only

### Task 26: Add `selectedDrafts` subscription to auto-trigger fetchCardData
**Files:** `src/app/stores/cardStore.ts`, `src/app/components/Settings.tsx`
- Add subscription so explicit `fetchCardData()` call in Settings is no longer needed

### Task 27: Split `decklists.ts` (542 lines) into focused modules
**Files:** `src/core/db/queries/decklists.ts` → `deckQueries.ts`, `playStats.ts`, `winStats.ts`

---

## Chunk 6: Documentation

### Task 28: Update CLAUDE.md
- Remove deleted hooks from project structure, add `stores/` directory
- Replace `/status` and `/board` with `/live` in API tables
- Add missing plan/spec document references
- Update data flow description to mention Zustand stores
- Add Zustand to tech stack mentions

### Task 29: Update README.md
- Same API route updates as CLAUDE.md
- Add Zustand to tech stack
