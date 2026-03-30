# Deep Clean Audit Report — 2026-03-30

**Branch:** `feature/data-flow-consolidation` (post-data-flow-consolidation refactor)

## Summary

Comprehensive audit across 7 domains (architecture, security, performance, code quality, test quality, documentation, data flow) following the major refactor that replaced 17 React hooks with 3 Zustand stores. Fixed 31 findings across 29 tasks: documentation updates, query optimizations, code deduplication, test coverage expansion, and minor polish.

## Findings by Category

### Architecture (3 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Important | `isAuthed` expression duplicated across 7 files | Extracted `getIsAuthed()` and `useIsAuthed()` into `selectors.ts` |
| 2 | Minor | `cardNameKey` defined in `parseSheetRows.ts` — awkward import for unrelated modules | Moved to `cardNames.ts` alongside `getFrontFace` |
| 3 | Minor | `decklists.ts` at 542 lines covers 4 query domains | Split into `decklists.ts`, `playStats.ts`, `winStats.ts`, `winningDecks.ts` |

### Security (1 fix)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 4 | Important | `display_name` type validation bypass — non-string values skip length check | Added early type guard rejecting non-string values with 400 |

### Performance (6 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 5 | Important | `getCards()` loads ALL pick events with no WHERE clause | Scoped `loadPickEvents` to selected draftIds |
| 6 | Important | `pickStats`: serial waterfall of 5 queries | Parallelized into 2 batches via `Promise.all` |
| 7 | Important | Queue PUT: N+1 `addFloatedCard` calls | Batched via `client.batch()` |
| 8 | Important | `processPick` cascade: sequential removes | Parallelized `removeCardFromAllQueues` + `removeFloatedCardByCardId` |
| 9 | Minor | `recompute()` rebuilds Maps on every call | Added reference-tracking cache; Maps only rebuild when `cardData` changes |
| 10 | Minor | Polling always fetches sync-status every 10s | Reduced to every 3rd cycle (~30s) |

### Code Quality (7 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 11 | Important | Set created inside `.filter()` loop — O(n*m) | Created Set once outside loop in `getCards.ts` and `getDraftStats.ts` |
| 12 | Important | Duplicated match result aggregation in 2 files | Extracted `aggregateMatchRecords()` into `matches.ts` |
| 13 | Important | Duplicated deck color inference across 3 files | Consolidated into `inferSeatColors()` in `helpers.ts` |
| 14 | Important | Two incompatible opt-out abstractions | Unified: `getOptedOutSeats` now delegates to `fetchOptOuts` |
| 15 | Important | `flushDeckSave` silently swallows failures | Added status reset + 5s retry timer |
| 16 | Minor | `MIN_SAMPLE_SIZE` and `DEFAULT_NUM_SEATS` duplicated | Extracted to `constants.ts` |
| 17 | Minor | SQL placeholder pattern repeated 18 times | Added `placeholders(n)` utility to `helpers.ts` |

### Test Quality (6 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 18 | Critical | `getCards.ts` — zero exercised tests (skipped behind hasTurso) | Added 9 mock-based tests |
| 19 | Critical | `getDraftStats.ts` — same skipped-test issue | Added 6 mock-based tests |
| 20 | Critical | `sync.ts` — 8 of 13 exported functions untested | Added 20 tests covering all functions |
| 21 | Important | `processPick` doesn't verify `removeFloatedCardByCardId` | Added assertion |
| 22 | Important | `snakeDraft.ts` — `getNextPick` and `buildPickMatrix` untested | Added 12 tests |
| 23 | Important | 3 API routes with no tests (`/api/cards`, `/api/draft-stats`, `/api/sync-status`) | Added 12 tests across 3 new test files |

### Documentation (2 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 24 | Critical | CLAUDE.md lists deleted hooks, deleted routes, omits stores + /live | Full update: hooks, routes, structure, data flow, plan/spec refs |
| 25 | Important | README.md missing Zustand, stale route references | Updated tech stack and API routes |

### Data Flow (4 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 26 | Important | Triple `fetchCardData` on `activeDraft` change | Added in-flight guard to deduplicate |
| 27 | Important | Shared deck overwrite — `fetchDeckState` clobbers shared snapshot | Added `viewingSharedDeck` flag to skip fetch |
| 28 | Minor | `syncDeckWithPicks` fires from 4 subscriptions, no debounce | Added 50ms debounce |
| 29 | Minor | `deckBuilderActive` tracked in both liveStore and useModalManagement | Consolidated to liveStore only |
| 30 | Minor | `selectedDrafts` change doesn't auto-trigger fetchCardData | Added subscription; removed manual call in Settings |

## Test Impact

- **Before:** 950 tests (950 passing, 6 skipped, 2 test files skipped)
- **After:** 1009 tests (1009 passing, 0 skipped, 0 test files skipped)
- **New test files:** `cards/route.test.ts`, `draft-stats/route.test.ts`, `sync-status/route.test.ts`
- **Enhanced test files:** `getCards.test.ts` (9 new), `getDraftStats.test.ts` (6 new), `sync.test.ts` (20 new), `processPick.test.ts` (1 new), `snakeDraft.test.ts` (12 new)

## New Modules

| File | Purpose |
|------|---------|
| `src/core/constants.ts` | Shared constants (MIN_SAMPLE_SIZE, DEFAULT_NUM_SEATS) |
| `src/core/db/queries/playStats.ts` | Card play stats queries (split from decklists.ts) |
| `src/core/db/queries/winStats.ts` | Card win stats queries (split from decklists.ts) |
| `src/core/db/queries/winningDecks.ts` | Winning decks by color query (split from decklists.ts) |

## Not Addressed

| Item | Reason |
|------|--------|
| liveStore size (782 lines) | Domains are cohesive; no maintainability concern at current scale |
| POST /api/sync origin check spoofable | Low risk for small community tool |
| POST /api/deck unauthenticated | Low risk; structural validation prevents abuse |
| Match reporting seat bounds check | Doesn't affect standings; low impact |
