# Deep Clean Audit Report — 2026-06-11

**Branch:** `deep-clean-fixes-2026-06-11` (42 commits, 171 files changed, +13,538 / −3,722 lines)

## Summary

Full-codebase health audit by 7 parallel review agents (architecture, security, performance, code quality, test quality, documentation, data flow), followed by a 40-task fix plan executed sequentially via subagent-driven development. All findings were triaged with the user and **everything was fixed** — including the full performance fix and the large structural refactors. The audit surfaced 12 critical findings; the most consequential were three data-loss bugs in the deck builder (cross-draft save bleed, shared-deck clobber, dropped first edit), a stale-data race in card fetching, an out-of-cube pick validation hole, a privacy-redaction bypass on the live board feed, and a Turso-egress profile that moved tens of MB of `scryfall_json` per poll/pick. Execution itself surfaced four additional real bugs not in the original findings (2-2 match results accepted client-side, auto-pick firing outside the drafting phase, the deck-builder restore being doubly dead, and a `setup`-phase stranding regression caught in review).

## Findings by Category

### Architecture (11 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| A1 | Critical | Two parallel sync pipelines (CLI vs cron route) duplicated matches-sync orchestration incl. the seat `+1` mapping | One orchestrator: `core/sync.ts` dissolved into `core/db/sync/` (`incremental.ts`, `lock.ts`, `syncActiveDraft.ts`); exactly one `buildMatchInserts` |
| A2 | Important | Auto-pick queue semantics implemented twice (client traversal + server cascade) | Single server implementation (`selectAutoPickCandidateForSeat`); pick route accepts `{ auto: true }`; client trigger is a thin call |
| A3 | Important | Routes bypassed the query layer with inline SQL; draft-meta lookup hand-rolled ×4 | `getDraftMeta()`; batch `addFloatedCards`/`removeFloatedCards`; all inline SQL removed from routes |
| A4 | Important | `liveStore.ts` at ~900 lines / 5 concerns with module-scoped mutable state | Split into `stores/live/{auth,queueFloat,picking,deckSave}.ts` + `wiring.ts` for explicit cross-store subscriptions; single Zustand store retained |
| A5 | Important | Two query-layer calling conventions plus a hybrid | Client-first everywhere; one test-mocking strategy |
| A6 | Important | Scryfall HTTP call living in the DB query layer; silent DB→network fallback | Moved to `scryfallApi.ts`; renamed `lookupCardWithApiFallback` so the fallback is explicit |
| A7 | Important | Four components fetched directly; `MatchMatrix` hand-built auth headers | All fetches moved to store actions; zero `fetch(`/`X-Seat-Token` in components (verified by grep) |
| A8 | Important | `core/sync.ts` vs `core/db/sync/` naming collision | Resolved by A1's merge; module docstrings state incremental-vs-full entry points |
| A9 | Important | Error-handling boilerplate copy-pasted into ~14 routes | `withApiErrors(handler, label)` wrapper applied to 26 handlers |
| A10 | Minor | `liveStore` ↔ `selectors` circular import | Broken via pure `computeMyDeckCardNames.ts`; selectors import stores, never the reverse |
| A11 | Minor | Three card-name→id resolution mechanisms, rules documented nowhere | Canonical taxonomy doc block; each mechanism documents its rules and intended use; all call sites verified correct |

### Security (11 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| S1 | Important | Picks of cards not in the draft's cube passed validation silently (zero rows ≠ error) | `getRemainingCopiesForPick` throws on zero cube rows — direct and cascade paths |
| S2 | Important | POST `/api/sync` "same-origin" auth forgeable (Origin vs Host header) | POST handler deleted (its "Sync Now" button no longer existed); cron GET is the sync mechanism |
| S3 | Important | `/api/drafts/[id]/live` bypassed privacy opt-out redaction, deanonymizing redacted seats | Redaction applied in the query layer, matching `/picks`/`/pool`/`/deck` |
| S4 | Minor | Seat tokens accepted as `?token=` on API routes (logs exposure) | API auth is header-only; page-route join links unaffected |
| S5 | Minor | Shared deck IDs had 32 bits of entropy on a year-cached route | 16 hex chars (64 bits); old IDs still resolve |
| S6 | Minor | `/api/deck` POST unauthenticated, unthrottled, accepted unknown draftIds | draftId existence check + per-IP rate limit |
| S7 | Minor | Win-stats gating trusted the client Host header | Env-based (`NODE_ENV`) gating; `isLocalHost` deleted |
| S8 | Minor | Non-constant-time `CRON_SECRET` comparison | `crypto.timingSafeEqual` |
| S9 | Minor | No CSP | `Content-Security-Policy-Report-Only` added |
| S10 | Minor | Floated card names unvalidated | 200-char cap + resolution against the cards table |
| S11 | Minor | Negative `limit` reached `slice(0, -5)` on ranked route | Clamped `Math.max(1, Math.min(n, 1000))` |

### Performance (10 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| P1 | Critical | `getCards` joined full `scryfall_json` onto every pick/cube row (tens of MB per call); every pick triggered a full `/api/cards` refetch in every client | Slim projections + one blob load per distinct card; pick state derived client-side from `board.picks`; `/api/cards` now long-cacheable keyed by `?v=<ingestionHash>` (no-store removed) |
| P2 | Critical | `/live` shipped full blobs for ~450 picks every 10s per client, no change detection | `json_extract` for the 3 needed fields; `?since`/`?sig` handshake returns `{unchanged:true}` without heavy queries |
| P3 | Critical | Deck-state PUT fired every poll cycle with unchanged content (identity churn → REBUILD `structuredClone` → dirty) | Deep-compare before `set()`; REBUILD returns previous state on no-op; `deckBuilderActive` reset on modal close |
| P4 | Important | New object identities every poll re-rendered the board subtree every 10s | Compare-before-set in `applyPollResults`; reference stability pinned by tests |
| P5 | Important | Polling never paused for hidden tabs | `visibilitychange`: stop when hidden, immediate refresh + restart when visible |
| P6 | Important | 3 HTTP requests per poll per authed client | Queue/float/settings folded into `/live` `me` payload for token-bearing requests |
| P7 | Minor | Card stats modal refetched on every open | Client cache keyed by name+excludeDraftId, invalidated on ingestion-hash change |
| P8 | Minor | `@dnd-kit`/board modal in the initial bundle | `next/dynamic` imports for `DeckBuilderPanel` and `DraftBoardModal` |
| P9 | Minor | `getAvailableCards` always selected `scryfall_json` | Conditional selection (only when color/type filters need parsing) |
| P10 | Minor | `/api/draft-stats` refetched per pick | Pick bumps no longer refetch draft stats (pickVersion/dataVersion split) |

### Code Quality (14 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| Q1 | Critical | Two definitions of "completed draft" — table vs stats modal disagreed during `playing` phase | Shared `draftPhases.ts` predicates (`complete` + `playing`); all four call sites aligned |
| Q2 | Critical | `syncDraft` clobbered admin-set phases on every sync | `isSyncPhaseTransitionLegal` guard; never demotes `playing`/`complete`; allows `setup → drafting` |
| Q3 | Critical | `getColorFromIdentity` sorted alphabetically (doc said otherwise) and mutated shared `scryfallDataMap` arrays in place | One non-mutating WUBRG `normalizeColorIdentity` in `manaColors.ts`; downstream consumers verified order-insensitive |
| Q4 | Important | `validateMatchResult(2,2)` accepted an impossible best-of-3 result | Fixed server-side and in `MatchMatrix`'s client-side validator |
| Q5 | Important | `trimExcessQueueEntries` over-trimmed entries holding duplicate refs of a multi-copy card | Removes exactly `toRemove` refs (failing test written first) |
| Q6 | Important | Privacy opt-out query reimplemented inline ×2 | Both use `fetchOptOuts` |
| Q7 | Important | `scryfall_json` serialization duplicated ×4; resolve-loop ×3 | `serializeScryfallEntry` + `resolveCardNamesToCache` in `ingest/serializeScryfall.ts` |
| Q8 | Important | 145-line `processPick` cascade body | Decomposed into `getRemainingCopiesForPick`/`insertPickEvent`/`advanceAutoPick` |
| Q9 | Important | liveStore internal duplication (queue parsing ×3, float ops, error-revert) | Single `parseServerQueue`, `mutateFloat`; revert replaced by refetch-on-failure |
| Q10 | Important | `parseUnpickedCards` production-dead, kept alive by tests | Deleted |
| Q11 | Important | Per-keystroke search analytics, never debounced, `result_count: -1` | Shared debounce; real result count |
| Q12 | Important | `slugify` (draft-ID generation) ×5 | One `scripts/lib/slugify.ts` |
| Q13 | Important | Filtered/overall stats fallback duplicated in `getCardStats` | `buildWinsResult` helper (rankedAvailable's variant left — different output shape, see Not Addressed) |
| Q14 | Minor | Bundle: localStorage `JSON.parse` unguarded ×3, unreachable `?? 10`s, unnamed magic values, `ciMarginPct` ×2, snake `/4` rule, stale headers, `/me` inline auth, script gaps | All addressed: guards, `DEFAULT_NUM_SEATS`, named constants (`QUEUE_CARD_CAP`, `DECK_SAVE_RETRY_DELAY_MS`, `ACTION_PENDING_MIN_MS`, `SEAT_MATCH_SCORE_THRESHOLD`, `DOUBLE_PICK_FINAL_FRACTION`, …), `ciMarginPct` in `wilsonInterval.ts`, `enterMatch` validates seats + records `reported_by_seat` |

### Data Flow (10 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| D1 | Critical | `fetchCardData` in-flight guard dropped triggers; stale responses committed against new selections — permanently stale UI | Request-identity counter + trailing re-run; stale responses discarded |
| D2 | Critical | Draft switch didn't reset deck-builder state; debounced saves flushed cross-draft; server stored mismatched bodies verbatim | Full reset on switch; save captures draftId at schedule time; server 400s on draftId/seat mismatch |
| D3 | Critical | Shared-deck flow: viewer's WIP could clobber the snapshot; edits saved through to the viewer's server deck | Atomic `enterSharedView` sequencing; `dispatchDeck` blocks dirty/save while viewing shared |
| D4 | Important | `refreshNow` vs interval race could regress board state and spuriously bump dataVersion | Fetch-generation counter; stale responses ignored; `prevPickN` never regresses |
| D5 | Important | `deckBuilderOpen` restore read pre-hydration state — dead branch (and the persist effect clobbered the stored value on mount) | Restore waits for hydration with a once-guard; persist skips first render |
| D6 | Important | Hydration refetched the SSR payload; `?v=` sent the hash the client already had | Set-equality skip on default hydration; server `ingestionHash` exposed via sync-status and used for `?v=` |
| D7 | Important | `justHydrated` flag survived no-op REBUILDs and ate the first real deck edit | Flag consumed deterministically; first user action always marks dirty |
| D8 | Important | Card status icons depended on incidental parent re-renders; modal hand-mirrored 7 selector deps | Reactive `useCardStatuses`/`useCardStatus` hooks — one dependency list in `selectors.ts` |
| D9 | Important | A display-name change triggered a full card-data refetch in every client | Seat-name changes no longer bump any version |
| D10 | Minor | Bundle: dead `triggerSync`/`consecutivePicks`, `liveDraftStatus`/`board` field overlap, snapshot rollbacks reverting concurrent ops, `PickAutocomplete` refetching client-held data, silent fetch failures, standings optimistic drift, deckState identity patching, union/selector duplication | All addressed: deletions, `liveDraftStatus` slimmed to unique fields, refetch-on-failure, store-derived autocomplete, `lastFetchFailed`/staleness flag + indicator, standings pending-state + refetch, identity set at load time, one `computeMyDeckCardNames` |

### Test Quality (8 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| T1 | Critical | `getDraftStats` tests verified a JS mock that reimplemented the production SQL | Rewritten against in-memory libsql — production CTE, `num_seats = 10` filter, and draftIds filtering actually execute |
| T2 | Critical | `/api/draft-stats` route test asserted a response shape production never produces | Asserts the real `{winRateBySeat, winRateByColor, ingestionHash}` shape |
| T3 | Critical | Queue-trim delegation test and PageClient smoke assertions could not fail | Behavioral assertions (batch UPDATE content; input-dependent `card-table` rendering) |
| T4 | Important | Auto-pick cascade had zero coverage at every level | Server cascade + on-demand endpoint + client trigger fully covered; **found a real bug** (no phase gate — fixed) |
| T5 | Important | Sync partial-failure, hash persistence, lock CAS, snapshot machinery, syncAll untested | All covered; lock CAS and snapshot logic run against real in-memory SQL |
| T6 | Important | Banned-card exclusion, tiebreakers, `getCardStats`, `getWinningDecksByColor` never executed in tests | All covered (in-memory DB; shared `testDb.ts` seeding helper extracted) |
| T7 | Important | getCards banned/multi-copy paths, REBUILD multi-copy, syncDeckWithPicks, pick-committing UI handlers, cubecobra, route validation branches, searchUtils branches untested | ~45 tests added across 8 modules |
| T8 | Minor | Misleading names, SQL-echo tests, isolation leaks, missing boundary pins | Renamed/rewritten/deleted; `fetch` spies restored, localStorage cleared, timers drained, real sleeps faked; boundaries pinned |

### Documentation (5 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| C1 | Critical | `/me` documented a removed `autoPickMode` field | Correct `{ seat, autoPick, displayName }` shape; `/live` `me` shape documented |
| C2 | Critical | Docs described a nonexistent "Sync Now" button; the real cron mechanism was undocumented | Cron documented; POST deletion reflected |
| C3 | Critical | Listed spec file never existed in git history | Index entry removed |
| C4 | Important | "dynamic SSR" contradiction; 4 specs + 6 plans missing from indexes; post-March features and required env vars undocumented | All corrected in CLAUDE.md and README |
| C5 | Minor | Subcommand/param/feature-list drift across both docs | All corrected; structure tree reflects the new modules |

## Test Impact

- **Before:** 1,062 tests (82 files), all passing
- **After:** 1,367 tests (93 files), all passing — +305 tests, +11 files
- **Final gate:** `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` green on every one of the 41 fix commits (sequential SDD, gate per commit)
- **E2e:** excluded from the per-task gate by user decision (sandbox), then run once at end of branch: 8 of 46 tests failed on stale spec assumptions (text selectors vs image-rendered cards; a timing race the branch eliminated). All were test-side issues, zero production regressions; specs updated — **46/46 passing**
- **New test infrastructure:** `src/core/db/__tests__/testDb.ts` (in-memory libsql + seed helpers) — `getDraftStats`, `cardStats`, `winningDecks`, lock CAS, and cube-snapshot tests now execute real SQL instead of mocks

## New Modules

| File | Purpose |
|------|---------|
| `src/core/draftPhases.ts` | Draft-phase lifecycle predicates + legal sync transitions |
| `src/core/db/ingest/serializeScryfall.ts` | Single source for scryfall_json serialization + cache-resolution loop |
| `src/core/db/sync/incremental.ts` / `lock.ts` / `syncActiveDraft.ts` | Unified sync pipeline (replaces deleted `core/sync.ts`) |
| `src/app/api/_lib/withApiErrors.ts` | Route error-handling wrapper |
| `src/app/stores/live/auth.ts` / `queueFloat.ts` / `picking.ts` / `deckSave.ts` | liveStore concern modules |
| `src/app/stores/wiring.ts` | Explicit cross-store subscription registration |
| `src/app/stores/computeMyDeckCardNames.ts` | Pure picks+floats+queue union (breaks the selectors cycle) |
| `scripts/lib/slugify.ts` | Canonical draft-ID slugify |
| `src/core/db/__tests__/testDb.ts` | In-memory libsql test database + seed helpers |

## Bugs Found During Execution (beyond the audit findings)

1. **2-2 match results** were also accepted by `MatchMatrix`'s client-side validator (audit only flagged the server).
2. **Auto-pick had no phase gate** — it could POST picks during `setup`/`complete`/`playing` whenever `nextSeat` was non-null (found writing T4 coverage).
3. **`deckBuilderOpen` restore was doubly dead** — besides reading pre-hydration nulls, the persist effect overwrote the stored value on mount before restore could read it.
4. **Task 1's phase guard initially stranded new Sheets drafts in `setup`** — caught in orchestrator review, fixed before it could ship (`setup → drafting` is legal).
5. **Seat win-rate CTE has no phase filter** — drafting-phase 10-seat drafts are included (harmless: they have no matches). Discovered when T1's mock was replaced by real SQL; pinned as documented behavior.

## Not Addressed

- **E2e in the per-task gate** — user decision (sandbox environment; Playwright chromium needs a platform override here). Chromium + system-TLS workaround were installed mid-session and the suite was run at end of branch instead (46/46 after spec updates — see Test Impact).
- **Three routes not wrapped by `withApiErrors`** (`cards`, `draft-stats`, `sync-status`) — their tests pin route-specific 500 messages; wrapping would change response shapes for no benefit.
- **`rankedAvailable`'s filtered/overall fallback variant** (Q13's third copy) — different output shape (flat accumulators, not the `CardStatsResult` object); extracting a shared helper would add abstraction without clarity.
- **Cross-device queue *reorders* and the `/live` short-circuit** — the per-seat freshness marker uses `LENGTH(queue_json)` + float count; a pure reorder (same cards) doesn't change either, so another device's reorder stays stale until the next real change. Adds/removes are caught exactly. Accepted tradeoff; fix would be an `updated_at` column on `pick_queues`.
- **In-memory rate limit on `/api/deck`** — per-serverless-instance, resets on cold start. Proportionate for this app; a durable limiter would need a DB table.
- **knip configuration hint** (`src/core/db/migrate.ts` "Remove from ignore") — pre-existing, cosmetic, out of scope.
