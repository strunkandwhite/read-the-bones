# Deep Clean Audit Report — 2026-03-21

**Branch:** `deep-clean-fixes` (20 commits, 53 files changed, +1201 / -474 lines)

## Summary

Full codebase health audit covering architecture, security, performance, code quality, and test quality. All findings addressed across 20 self-contained commits.

## Findings by Category

### Architecture (4 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Important | Two `wilsonInterval` implementations with incompatible signatures (tuple vs object) | Consolidated into `wilsonInterval.ts` with `{lower, center, upper}` return type |
| 2 | Important | Deck color inference (30% threshold) duplicated in `getDraftStats.ts` and `helpers.ts` | Extracted to `src/core/inferDeckColor.ts` |
| 3 | Minor | DFC front-face splitting (`name.split(" // ")[0]`) duplicated in 5+ files | Extracted to `src/core/cardNames.ts` (`getFrontFace`) |
| 4 | Minor | Color pair decomposition duplicated in `stats/route.ts` and `DraftStats.tsx` | Extracted to `src/core/colorDecomposition.ts` |
| 5 | Minor | `InfoTooltip` component duplicated in `CardTable.tsx` and `DraftStats.tsx` | Extracted to `src/app/components/InfoTooltip.tsx` |
| 6 | Minor | `DraftMetadata` type name collision between ingest and query modules | Renamed ingest version to `IngestDraftMetadata` |
| 7 | Minor | `fetchDraftFromSheet` in `build/` module but used at runtime by sync API | Moved to `src/core/sheets.ts` |

### Security (3 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 8 | Important | `POST /api/deck` accepts arbitrary JSON body with no shape validation | Added `validateDeckState` with field type/range checks; generic error message to avoid leaking expected shape |
| 9 | Important | `generateDeckId` used `Math.random()` (predictable) | Replaced with `crypto.randomUUID()` |
| 10 | Minor | `before_pick_n` and `limit` API params accepted unbounded values | Added `before_pick_n >= 1` check and `limit` cap at 1000 |

### Performance (3 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 11 | Important | `getCardStats` called `resolveCard` 3 times (once per sub-function) | Resolve once at top, pass `card_id` to sub-functions |
| 12 | Important | `insertNewPicks` in sync resolved card names and inserted picks one at a time (N+1) | Batch-resolve via `IN` clause, batch-insert via `client.batch()` |
| 13 | Minor | REST API routes had no `Cache-Control` headers | Added `s-maxage=60` for draft data, `s-maxage=300` for stats |

### Code Quality (2 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 14 | Minor | Magic number `5` used for minimum sample size in 4 places in `stats.ts` | Extracted to `MIN_SAMPLE_SIZE` constant |
| 15 | Minor | `Math.round(x * 1000) / 1000` inlined in 3 files | Replaced with shared `round3` utility |

### Test Quality (5 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 16 | Important | `calculatePickWeight` and `weightedGeometricMean` had zero test coverage | Added 11 tests covering edge cases, weight application, and geometric mean math |
| 17 | Important | `getDraftStats` test claimed to test draft ID filtering but didn't | Removed misleading test (function requires live Turso; remaining tests are skipped correctly) |
| 18 | Important | API route tests only checked status codes, not response shapes | Added response body structure assertions and error handling tests to 6 route test files |
| 19 | Minor | `optOuts.ts` (privacy functions) had no tests | Added 6 tests for `isOptedOut` and `loadOptOutNames` |
| 20 | Minor | Sync module (`isRateLimited`, `getDbMaxPickN`, `resolveCardNameToId`) untested | Added 7 tests with mocked DB client |

## Test Impact

- **Before:** 509 tests (502 passing, 7 skipped)
- **After:** 536 tests (529 passing, 7 skipped)
- **New test files:** 5 (`inferDeckColor`, `cardNames`, `colorDecomposition`, `validateDeckState`, `optOuts`)
- **Enhanced test files:** 3 (`utils.test.ts`, `sync.test.ts`, 6 API route test files)

## New Modules

| File | Purpose |
|------|---------|
| `src/core/wilsonInterval.ts` | Canonical Wilson score interval (consolidated) |
| `src/core/inferDeckColor.ts` | 30% threshold deck color inference |
| `src/core/cardNames.ts` | DFC front-face extraction |
| `src/core/colorDecomposition.ts` | Color pair win rate decomposition |
| `src/core/validateDeckState.ts` | Deck state shape validation |
| `src/core/sheets.ts` | Google Sheets fetch (moved from build/) |
| `src/app/components/InfoTooltip.tsx` | Shared tooltip component |

## Not Addressed

These items were considered but intentionally left alone:

- **`POST /api/sync` authentication**: Rate-limited by design; no auth needed for the polling endpoint.
- **Knip hint about `migrate.ts`**: Pre-existing configuration hint, not a code issue.
- **Skipped integration tests** (`getDraftStats`, `getCards`): Require live Turso connection; `skipIf` guards are correct.
