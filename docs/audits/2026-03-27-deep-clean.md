# Deep Clean Audit Report — 2026-03-27

**Branch:** `deep-clean-2026-03-27` (16 commits, 39 files changed, +501 / -272 lines)

## Summary

Comprehensive codebase health audit covering architecture, security, performance, code quality, test quality, and documentation. Six parallel review agents identified 47 findings across all domains. 30 findings were fixed in 16 commits; 17 were triaged as deferred (large refactors, coverage expansion, or low-priority items). All quality gates pass (typecheck, lint, knip, 791 unit tests).

## Findings by Category

### Architecture (4 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| A5 | Important | Pick route uses string matching on `error.message` for HTTP status dispatch | Created `AppError` class hierarchy (`AuthError`, `ValidationError`, `NotFoundError`, `ConflictError`) with `statusCode` property. Updated `tokenAuth.ts`, `processPick.ts`, and 4 route handlers to use `instanceof` dispatch |
| A6 | Important | Duplicate body scroll locking in `PageClient` and `DraftBoardModal` | Extracted `useScrollLock` hook with ref-based overflow tracking, replaced duplicate logic in both components |
| A9 | Minor | Unreachable `if (!isOpen) return null` in `DraftBoardModal` | Removed — parent already conditionally renders the component |
| A10 | Minor | `isLocal` detection duplicated 4 times with 2 implementations | Extracted `isLocalHost` (server) and `isLocalClient` (client) helpers |

### Security (4 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| S1 | Important | `POST /api/sync` has no authentication | Added same-origin check: allows requests with valid `CRON_SECRET` header or matching `origin`/`host` |
| S2 | Important | Match route missing type validation on `wins`/`losses`/`opponent_seat` | Added `Number.isInteger`, non-negative, and minimum seat validation |
| S4 | Important | `display_name` has no length limit | Added 50-character maximum |
| S6 | Minor | Queue PUT doesn't validate body is array | Added `Array.isArray` check before `.map()` |

### Performance (4 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| P1 | Important | `setQueue` N+1 queries (1 DELETE + N individual INSERTs) | Rewritten to use `client.batch()` — single round trip |
| P2 | Important | `removeCardFromAllQueues` N+1 queries per affected seat | Batched renumbering into single `client.batch()` call |
| P3 | Important | Queue PUT route resolves card names sequentially | Replaced with single `WHERE name IN (...)` query |
| P6 | Minor | `ensureCubeSnapshot` inserts cards one at a time | Replaced with existing `batchInsertCubeSnapshotCards` function |

### Code Quality (7 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| Q1 | Important | Banned cards JSON parsing duplicated in 6 places | Extracted `parseBannedCards` (returns Set) and `parseBannedCardNames` (returns array) to `helpers.ts` |
| Q2 | Important | SHA-256 truncated hash pattern duplicated in 4 places | Exported `sha256Short` from `domains.ts`, updated all consumers |
| Q3 | Important | Ingestion hash computation duplicated in `getCards.ts` and `getDraftStats.ts` | Extracted `computeIngestionHash` to `domains.ts` |
| Q4 | Important | Snake draft seat derivation re-implemented in `PageClient` | Replaced with `derivePickSeat` from `snakeDraft.ts` |
| Q5 | Important | `computeCubeHash` and `hashPool` are functionally identical | Replaced `computeCubeHash` with re-export of `hashPool` |
| Q6 | Minor | `board/route.ts` parses scryfall_json inline | Replaced with `transformScryfallJson` helper |
| Q8 | Minor | Knip config has redundant entry for `migrate.ts` | Removed — auto-detected from `package.json` scripts |

### Test Quality (0 fixes)

No test fixes in this audit. Coverage gaps and test quality issues were triaged as deferred items for separate tracking.

### Documentation (11 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| D1 | Critical | README "Adding Draft Data" describes nonexistent CSV workflow | Rewritten with current `draft:create` / `sync` / `decklists` workflow |
| D2 | Critical | README says "Parses draft CSV files" | Updated to "Syncs draft data from Google Sheets via the Sheets API" |
| D3 | Critical | README opt-out section references `pnpm ingest` | Updated to `pnpm sync` |
| D4 | Important | README API table missing 9+ routes | Added `/api/cards/search`, `/api/decks/winning`, and full Live Draft Routes section |
| D5 | Important | README doesn't mention live drafts | Added live drafts feature bullet |
| D6 | Important | CLAUDE.md precommit description omits e2e | Updated to include `→ e2e` |
| D7 | Important | CLAUDE.md project structure omits 6 query modules, 5 hooks, `draft-board/` | Updated all lists |
| D8 | Important | CLAUDE.md missing 4 plan docs and 3 spec docs | Added all missing entries |
| D9 | Important | CLAUDE.md decklists path wrong | Corrected to `data/decklists.txt` |
| D10 | Important | No mention of e2e tests anywhere | Added `pnpm test:e2e` command |
| D11 | Important | `draft:delete` script undocumented | Added to Key Commands |

## Test Impact

- **Before:** 61 test files (769 tests passing, 7 skipped)
- **After:** 63 test files (791 tests passing, 7 skipped)
- **New test files:** `src/core/errors.test.ts`, `src/core/isLocal.test.ts`
- **Enhanced test files:** `src/core/db/sync/__tests__/domains.test.ts`, `src/core/db/queries/pickQueue.test.ts`, `src/app/api/sync/route.test.ts`, `src/app/api/drafts/[id]/queue/route.test.ts`, `src/app/api/drafts/[id]/pick/route.test.ts`, `src/app/api/drafts/[id]/match/route.test.ts`, `src/app/api/drafts/[id]/seat-settings/route.test.ts`

## New Modules

| File | Purpose |
|------|---------|
| `src/core/errors.ts` | Structured error classes with HTTP status codes |
| `src/core/isLocal.ts` | Localhost detection helpers (server + client) |
| `src/app/hooks/useScrollLock.ts` | Body scroll lock hook with ref-based cleanup |

## Not Addressed

Items considered but intentionally left for future work:

| # | Finding | Reason |
|---|---------|--------|
| A1 | `PageClient.tsx` is 768 lines | Large refactor — warrants its own dedicated plan |
| A2 | Live-draft routes use inline SQL bypassing query layer | Requires migrating 3 routes — significant scope |
| A3 | `getCards.ts` is 469-line monolith | Complex refactor — warrants its own plan |
| A4 | `core/sync.ts` imports from `build/scryfall.ts` | Moving functions would touch many files across sync pipeline |
| A7 | `stats.ts` is 814 lines | File split warrants its own plan |
| A8 | Inconsistent query param names (`drafts` vs `draft_ids`) | Breaking API change — needs migration strategy |
| S3 | Token via query param logged in access logs | Removing would break existing links |
| S5 | Localhost check via Host header is spoofable | Low-risk for personal tool |
| P4 | `resolveCardFuzzy` cascading 5 sequential queries | Complex optimization needs careful testing |
| P5 | `getCards` loads entire DB per SSR request | Needs caching strategy design |
| Q7 | CardTable uses 12 useRef wrappers | Pragmatic pattern for TanStack Table |
| T1 | Multiple production modules have no tests | Coverage expansion — tracked separately |
| T2 | `processPick` auto-pick cascade untested | Complex test setup required |
| T3 | `cubecobra.test.ts` missing HTTP fetch test | Requires network mocking |
| T4 | Tests use `setTimeout` instead of `waitFor` | Low-priority test cleanup |
| T5 | Tests assert on SQL strings (implementation coupling) | Acceptable for now |
| D13 | Three undocumented utility scripts | Low-priority maintenance scripts |
