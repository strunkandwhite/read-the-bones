# Deep Clean Fixes — 2026-06-11

> **For agentic workers:** Execute tasks sequentially in the main repo (no worktree isolation). One commit per task. Run the quality gate after every task: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` (e2e excluded by user decision for this audit). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all findings from the 2026-06-11 deep-clean audit: 12 critical, ~35 important, and the minor bundles across architecture, security, performance, correctness, data flow, test quality, and documentation.

**Branch:** `deep-clean-fixes-2026-06-11`

**Triage outcome (user):** Fix everything. Full performance fix (not just cheap wins). Structural refactors (liveStore split, query-layer convention, sync unification) included. All test gaps closed. POST `/api/sync` deleted (dead "Sync Now" path with forgeable origin auth).

---

## Root-cause themes

1. **`scryfall_json` blob joined onto hot queries + "fetch" conflated with "changed"** → P1, P2, P3, P4, P6, D6, D9. Fix: slim SQL projections, change detection before `set()`, refetch `/api/cards` only when ingestion data changes (picks derived client-side from `board.picks`).
2. **Draft-phase lifecycle rules scattered** → Q1, Q2. Fix: shared `draftPhases.ts` predicates.
3. **`activeDraft` transition resets incomplete** → D1, D2, D3, D7. Real data-loss bugs in deck builder.
4. **Dual implementations kept in sync by hand** → A1 (sync pipelines), A2 (auto-pick), Q7 (serialization), Q12 (slugify). Fix: single sources of truth; client auto-pick delegates to server.

---

## Chunk 1: Shared foundations

### Task 1: Draft-phase predicates (Q1, Q2 — Critical)

**Files:** Create `src/core/draftPhases.ts` (+ test). Modify `src/core/db/queries/stats/pickStats.ts:86`, `src/core/db/queries/stats/pickHistory.ts:77,125`, `src/core/getCards.ts:134`, `src/core/getDraftStats.ts:177`, `src/core/db/sync/index.ts:227-232`.

- [ ] Create `draftPhases.ts` with named predicates/constants, e.g. `STATS_COMPLETE_PHASES = ['complete', 'playing']` and `isCompletedForStats(phase)`, plus a SQL fragment helper for `phase IN (...)` use.
- [ ] Align all four stats call sites on the same predicate. Intended rule: drafts in `complete` **or** `playing` count toward stats (the `getCards`/`getDraftStats` behavior is the intended one; the modal paths filtering on `complete` only are the bug).
- [ ] Fix `syncDraft` (`db/sync/index.ts:227`): only update phase when the computed phase differs AND the transition is legal — never demote `playing`/`complete` to `drafting`, never clobber an admin-set `playing`. Guard the UPDATE behind a change check.
- [ ] Tests: predicate unit tests; sync test pinning that a `playing` draft is not demoted on re-sync.

### Task 2: `withApiErrors` route wrapper (A9 — Important)

**Files:** Create `src/core/apiErrors.ts` or `src/app/api/_lib/withApiErrors.ts` (+ test). Modify all ~14 token-auth routes plus older REST routes with hand-rolled catch blocks.

- [ ] Wrapper takes `(handler, label)`; maps `AppError` → its status/message, everything else → `console.error(label, err)` + generic 500. Preserve each route's current success behavior exactly.
- [ ] Apply to every route currently containing the copy-pasted block (`pick`, `float` ×3, `queue`, `deck-state`, `me`, `seat-settings`, `match`, `cards/stats`, etc.).
- [ ] Route tests should stay green unchanged (error shapes preserved) — treat any needed test edit as a red flag to investigate.

### Task 3: Query-layer calling convention (A5 — Important; A3-partial, Q14-partial)

**Files:** Modify `src/core/db/queries/drafts.ts`, `picks.ts`, `cards.ts`, `pool.ts`, `search.ts`, `winStats.ts` (and their callers + tests). Create `getDraftMeta` in `queries/drafts.ts`.

- [ ] Convert internal-client query functions (`drafts.ts:28`, `picks.ts:37`, `cards.ts:39`, `pool.ts:140`, `search.ts:35`) to take `client: Client` as first param, matching the live-draft modules. Remove the `client ?? await getClient()` hybrid in `winStats.ts:142`. Callers fetch the client once.
- [ ] Add `getDraftMeta(client, draftId)` returning `{ phase, numSeats, picksPerPlayer, ... }`; replace the four hand-rolled inline variants (`api/.../match/route.ts:36`, `api/.../live/route.ts:18`, `core/processPick.ts:27`, `queries/drafts.ts:118`).
- [ ] Adopt the `placeholders()` helper at the sites that rebuild `.map(() => "?").join(", ")` manually (`helpers.ts` itself, `stats/pickStats.ts:105,107,158`, `winningDecks.ts:104,113`, `cards.ts:157`, `core/sync.ts:148`, `getDraftStats.ts`).
- [ ] Update tests to the single mocking strategy this enables.

### Task 4: Scryfall + scripts shared helpers (A6, Q7, Q12 — Important)

**Files:** Modify `src/core/scryfallApi.ts`, `src/core/db/queries/helpers.ts:271`, `src/core/db/queries/cards.ts:124`. Create `src/core/db/ingest/serializeScryfall.ts` (or extend `ingest/scryfall.ts`) and `scripts/lib/slugify.ts`. Modify `src/core/db/sync/index.ts:273-300`, `src/core/db/ingest/scryfall.ts:57-66`, `scripts/draft-create-live.ts:96-121`, `scripts/draft-admin.ts:94-121`, `scripts/draft-create.ts`, `scripts/draft-start.ts`, `scripts/decklists.ts:212-215`.

- [ ] Move `fetchFromScryfallApi` from `queries/helpers.ts` into `scryfallApi.ts`. Make `lookupCard`'s DB→network fallback explicit at the call site (rename or split so the network fallback is visible to callers).
- [ ] Extract the 10-line `JSON.stringify({name, color_identity, ...})` serialization into one shared function; replace all 4 copies. Extract the duplicated "resolve via cardCache → scryfallCache → markMissing" loop into one helper; replace its 3 copies.
- [ ] Extract `slugify` into one module; replace the 4 script copies + the inline copy in `decklists.ts`.
- [ ] Also fix the stale/orphaned doc comments noted by review: `parseSheetRows.ts:1-8` (references deleted `parseCsv.ts`), `helpers.ts:233-237` (docstring attached to wrong function).

---

## Chunk 2: Correctness & security

### Task 5: processPick — out-of-cube validation + decomposition + cascade tests (S1, Q8 — Important; T4-server, T5-partial)

**Files:** Modify `src/core/processPick.ts`, `src/core/processPick.test.ts`.

- [ ] S1: in the availability check (`processPick.ts:60-75`), zero rows from `cube_snapshot_cards` must **throw** (card not in this draft's cube), mirroring the queue route's `getRemainingCopies`-defaults-to-0 behavior. Same check inside the cascade (`cascadeDepth > 0` branch).
- [ ] Q8: decompose the 145-line while body into named helpers (`insertPickEvent`, `getRemainingCopiesForPick`, `advanceAutoPick` or similar) without behavior change.
- [ ] Tests: out-of-cube pick rejected (direct + cascaded); ConflictError on `rowsAffected === 0`; draft-not-found; all-picks-made guard; a full cascade where a second INSERT happens; the `maxCascade` bound; pause-mode exhaustion auto-disabling autoPick; group-member demotion to float.

### Task 6: Match validation + queue trim bugs (Q4, Q5 — likely production bugs)

**Files:** Modify `src/core/match-validation.ts`, `src/core/db/queries/pickQueue.ts:129-195`, + tests.

- [ ] Q4: `validateMatchResult(2, 2)` must be invalid — exactly one side reaches 2 wins, the other 0–1. Pin with tests (2-2, 3-x, negative, 2-1, 1-2, 0-2 cases).
- [ ] Q5: in `trimExcessQueueEntries`, when an entry contains the same card ref twice, remove only `toRemove` refs, not all matching refs. Write the failing test first (duplicate refs in one entry, multi-copy card), then fix.
- [ ] Strengthen the delegation test that currently can't fail (`pickQueue.test.ts:351`) to assert the actual delete behavior.

### Task 7: Color identity normalization (Q3 — Critical)

**Files:** Modify `src/core/getCards.ts:75-82`, `src/core/db/queries/pool.ts:44-52` (+ tests).

- [ ] Replace `getColorFromIdentity` with the existing WUBRG-order `normalizeColorIdentity` from `pool.ts` — hoist it to a shared module (e.g. `src/core/manaColors.ts` if appropriate, else `draftPhases`-style small module).
- [ ] Must NOT mutate its input (no in-place `.sort()` on `ScryCard.colorIdentity` held in `scryfallDataMap`).
- [ ] Check downstream consumers for ordering assumptions (anything keyed on the old alphabetical string, e.g. stored values, color-pair lookups like `/api/decks/winning` `color_pair`) and reconcile; add tests pinning WUBRG output ("UB" stays "UB", "BU" input → "UB").

### Task 8: `/live` privacy redaction (S3 — Important)

**Files:** Modify `src/app/api/drafts/[id]/live/route.ts:33-58` and/or `src/core/db/queries/picks.ts:388-444` (+ tests).

- [ ] Apply the same opt-out redaction used by `/picks`/`/pool`/`/deck` (see `getPicks` in `picks.ts:35-106`) to `getRecentPicks`/`getPicksWithCardDetails` output on this route. Redact opted-out seats' card names the same way (`[REDACTED]` convention).
- [ ] Note: live drafts in progress likely have no opt-outs — but the route also serves historical live drafts; enforce uniformly. Test with a mocked opt-out.

### Task 9: Delete POST /api/sync + dead manual-sync client path (S2, S8 — Important; part of D10/C2)

**Files:** Modify `src/app/api/sync/route.ts`, `src/app/stores/draftStore.ts:344-392`, their tests.

- [ ] Delete the POST handler (forgeable Origin-vs-Host auth; the "Sync Now" button it served no longer exists).
- [ ] Delete `triggerSync`, `manualSyncInFlight`, and now-unused `syncStatus` fields (keep `syncStatus.activeDrafts`, used by `Settings.tsx:34`); delete their tests; remove `isRateLimited` if it loses its last caller.
- [ ] S8: switch the GET cron-secret comparison to `crypto.timingSafeEqual` (constant-time).
- [ ] Remove the stale "Sync Now" comment at `route.ts:159`.

### Task 10: Security minors (S4, S5, S6, S7, S9, S10, S11)

**Files:** `src/core/tokenAuth.ts`, `src/core/deckBuilder.ts:129`, `src/app/api/deck/route.ts`, `src/core/isLocal.ts` + `src/app/api/cards/route.ts:21-27`, `next.config.ts`, `src/app/api/drafts/[id]/float/route.ts:36`, `src/app/api/drafts/[id]/available/ranked/route.ts:25` (+ tests).

- [ ] S4: stop accepting `?token=` on API routes — `extractToken` header-only for API usage; the page-route join-link flow (localStorage + `replaceState`) keeps working. Verify `liveStore.ts:289-301` flow unaffected.
- [ ] S5: `generateDeckId` → 16+ chars (full UUID without dashes or 16-hex slice). Existing short IDs must still resolve.
- [ ] S6: `/api/deck` POST — validate `draftId` exists in DB before insert; add a simple rate limit consistent with codebase patterns.
- [ ] S7: replace `isLocalHost(host-header)` gating with an env-based flag (e.g. `process.env.NODE_ENV !== 'production'` or explicit `WIN_STATS_ENABLED`); keep behavior on localhost dev identical.
- [ ] S9: add a report-only CSP to `next.config.ts` headers.
- [ ] S10: float route — cap `card_name` length (e.g. 200) and resolve against the pool like the queue route does.
- [ ] S11: clamp ranked `limit` with `Math.max(1, Math.min(n, 1000))`.

---

## Chunk 3: Sync pipeline unification

### Task 11: One sync orchestrator (A1 — Critical; A8 — Important)

**Files:** Modify `src/core/sync.ts`, `src/core/db/sync/index.ts`, `src/app/api/sync/route.ts`, `scripts/sync.ts` (+ tests).

- [ ] Extract the serverless route's per-draft body (`runSync` lines 53–115: fetch tabs → `incrementalIngest` → hash-compare matches → replace) into a single core function, e.g. `syncActiveDraft(client, draft, apiKey)` living in `core/db/sync/`. The matches block must be the SAME code the CLI path uses (one copy of the `seat1 + 1` mapping).
- [ ] Re-home `core/sync.ts`'s contents to kill the naming collision: lock/rate-limit/status helpers and `incrementalIngest` move under `core/db/sync/` (e.g. `incremental.ts`, `lock.ts`) or get unambiguous names. `core/sync.ts` should cease to exist or become a thin re-export shim scheduled for deletion (prefer deletion; update all imports).
- [ ] `resolveCardNameToId` (currently in `core/sync.ts:57`) moves with the ingestion code (see also Task 30).
- [ ] Route handler shrinks to: auth → lock → loop `syncActiveDraft` → release. CLI `syncAll` continues using `syncDraft` for full-domain syncs — document in module docstrings which entry point is for incremental (cron) vs full (CLI) and why both exist.
- [ ] Tests follow the moved code; add one test that the route path and CLI path produce identical match rows from the same parsed input.

---

## Chunk 4: Data-flow correctness

### Task 12: fetchCardData identity + re-run (D1 — Critical)

**Files:** Modify `src/app/stores/cardStore.ts:52-53,299-343` (+ tests).

- [ ] Replace the boolean in-flight guard with a request identity scheme: capture a monotonically increasing `requestId` (or the selection snapshot) at fetch start; on resolve, commit only if still-current. If a trigger arrives mid-flight, either start the new fetch immediately (abort/ignore the old) or queue exactly one trailing re-run.
- [ ] Test: change `selectedDrafts` while a fetch is in flight; the committed state must reflect the new selection (mock two overlapping fetches resolving out of order).

### Task 13: Draft-switch deck-state reset + server cross-check (D2 — Critical)

**Files:** Modify `src/app/stores/liveStore.ts:741-781`, `src/app/api/drafts/[id]/deck-state/route.ts:34-61`, `src/core/validateDeckState.ts` (+ tests).

- [ ] Client: the `activeDraft` subscription's non-null branch must also reset deck state (`deckState`, `deckReady`, `deckSaveStatus`, `viewingSharedDeck`, pending debounced save — cancel the timer and clear `deckDirty`/`deckPendingSave`) — same as the null branch's `_resetDeckState()`.
- [ ] Client: `flushDeckSave` must capture the draftId at schedule time and abort if `activeDraft` changed by flush time.
- [ ] Server: deck-state PUT rejects when `body.draftId` ≠ route draftId or `body.seat` ≠ authed seat (400). This closes the cross-draft overwrite hole even if a future client regresses.
- [ ] Tests: switching drafts cancels pending saves; mismatched body rejected server-side; no-token draft B doesn't show draft A's zones.

### Task 14: Shared-deck flow (D3 — Critical)

**Files:** Modify `src/app/hooks/useSharedDeckLoader.ts:37-48`, `src/app/stores/liveStore.ts:614-661` (+ tests).

- [ ] Set `viewingSharedDeck = true` BEFORE `setActiveDraft(deckState.draftId)` so `fetchDeckState` sees it at entry (or pass it through the subscription). Eliminate the race where the viewer's own WIP deck response clobbers the shared snapshot.
- [ ] `dispatchDeck` must be read-only while `viewingSharedDeck` (ignore edits, or allow local edits but never set `deckDirty`/schedule saves — choose simplest: block dirty/save).
- [ ] Clear `viewingSharedDeck` on `activeDraft` change (covered by Task 13's reset — verify) and when leaving the shared-deck view, so the next draft's `fetchDeckState`/`syncDeckWithPicks` aren't blocked.
- [ ] Tests: shared deck not replaced by viewer's WIP fetch; editing a shared view never PUTs; switching away restores normal deck behavior.

### Task 15: justHydrated first-edit loss (D7 — Important)

**Files:** Modify `src/app/stores/liveStore.ts:617-631`, maybe `src/core/deckBuilder.ts:213-214` (+ tests).

- [ ] Consume/clear `justHydrated` even when the post-INIT rebuild is a no-op (same-reference return). Simplest: clear the flag on the INIT_FROM_SNAPSHOT dispatch itself plus the first subsequent REBUILD, regardless of reference equality — the first USER action must always set `deckDirty`.
- [ ] Test: hydrate deck → REBUILD no-op → user moves one card → save fires.

### Task 16: Poll sequencing (D4 — Important)

**Files:** Modify `src/app/stores/draftStore.ts:153-210,302-341` (+ tests).

- [ ] Add a fetch-generation counter to the polling machinery; `applyPollResults` ignores responses from a generation older than the latest applied. `refreshNow()` bumps the generation. Module-scoped `prevPickN` must not regress.
- [ ] Test: interval response resolving after a newer `refreshNow` response is discarded (no state regression, no spurious `dataVersion` bump).

### Task 17: deckBuilderOpen restore (D5 — Important)

**Files:** Modify `src/app/hooks/useModalManagement.ts:27-33`, possibly `src/app/components/PageClient.tsx` (+ test).

- [ ] The restore effect must run AFTER store hydration populates `activeDraft`/`selectedSeat` (depend on those values, gate on a `hydrated` flag, or move the restore into the hydration flow). Currently the `[]`-deps effect reads pre-hydration nulls — dead branch.
- [ ] Test: with localStorage `deckBuilderOpen=true` + stored draft/seat, the deck builder reopens after mount.

### Task 18: Card-status subscriptions (D8 — Important)

**Files:** Modify `src/app/components/CardTable.tsx:88-99`, `src/app/components/CardStatsModal.tsx:50-65`, `src/app/stores/selectors.ts` (+ tests).

- [ ] Make CardTable's status rendering subscribe to its actual inputs (queue/float/taken state) rather than relying on PageClient's incidental re-renders — e.g. a `useCardStatuses` hook in selectors that returns a memoized status map keyed by the selector's real dependencies.
- [ ] CardStatsModal uses the same hook instead of hand-mirroring 7 dependencies.
- [ ] Remove the pointless `getCardStatusRef` indirection (Q14 item).
- [ ] Test: queue/float change updates an on-screen status without a PageClient re-render (component test with the table rendered alone).

### Task 19: dataVersion semantics + hydration refetch (D6, D9, P10 — Important)

**Files:** Modify `src/app/stores/draftStore.ts:160-196,275-298`, `src/app/stores/cardStore.ts:299-345,434-455`, `src/app/api/cards/route.ts:29-33` (+ tests). Coordinates with Task 21/23.

- [ ] D9: seat-name-only changes must NOT bump `dataVersion` (board consumers already get names from the poll response).
- [ ] P10: `dataVersion` bumps caused by live picks must not refetch `/api/draft-stats` (stats cover completed drafts only). Distinguish "pick happened" from "ingestion/sync changed" — only the latter refetches draft-stats.
- [ ] D6: skip the hydration-triggered `fetchCardData` when the hydrated selection equals the SSR default (the data is byte-identical to the snapshot). Fix the `?v=` cache-buster semantics: the version param must represent the data the client WANTS (server-known current hash), not the hash it already has — simplest coherent rule: keep `?v=` for edge-cache keying but have the server include its current `ingestionHash` in poll responses so the client busts toward NEW data. Align with the `/api/cards` caching decision in Task 21.
- [ ] Tests: rename → no card refetch; default hydration → no duplicate fetch; pick → no draft-stats refetch.

### Task 20: Data-flow minors bundle (D10, A7-partial)

**Files:** `src/app/stores/draftStore.ts`, `src/app/stores/liveStore.ts`, `src/app/components/draft-board/PickAutocomplete.tsx`, `src/app/components/draft-board/StandingsSection.tsx`, `src/app/components/PageClient.tsx` (+ tests).

- [ ] Delete `consecutivePicks` (stale + never rendered) or fix its trigger and render it — delete unless a consumer is planned.
- [ ] De-duplicate `liveDraftStatus`/`board` overlapping fields (single canonical home; `patchSeatName` patches the one copy).
- [ ] Optimistic float/queue rollbacks: restore against current server truth (refetch on failure) instead of wholesale `previous` snapshots that can revert concurrent ops.
- [ ] `PickAutocomplete` uses the client-side available set from `cardStore` (cube minus taken minus banned) instead of fetching `/available` per open.
- [ ] Surface fetch errors: a minimal `lastError`/`isStale` flag in draftStore/cardStore + a small staleness indicator in the UI (don't build a whole error system; one visible signal).
- [ ] StandingsSection: drop the private optimistic standings math that leaves OMW%/OGW% stale; on match report, refetch standings (cheap) and show pending state meanwhile.
- [ ] `deckState` denormalized `draftId`/`seat`: with Task 13's server cross-check, simplify the client identity-patch in `syncDeckWithPicks` (`liveStore.ts:846-853`) to set identity at creation/load time only.
- [ ] `effectivePoolAsOfDraft` fallback: derive in one place (draftStore selector), consume in both `Settings.tsx:39` and `cardStore.ts:305`.
- [ ] "My deck cards" union (picks+floats+queue): extract one selector; use in `PageClient.tsx:148-156`, `liveStore.ts:824-838`, `DeckBuilderPanel.tsx:67-68` with explicit, shared dedup/auth rules.

---

## Chunk 5: Performance (full fix)

### Task 21: Slim getCards + per-pick refetch elimination (P1 — Critical; with D-F takenCards dedup)

**Files:** Modify `src/core/getCards.ts:190-215,255-261`, `src/app/api/cards/route.ts`, `src/app/stores/cardStore.ts:440-443`, `src/app/stores/draftStore.ts:185-188` (+ tests).

- [ ] `loadPickEvents`: select only `draft_id, pick_n, seat, card_id, name` (no `scryfall_json`). `loadCubeCards`: same. Load Scryfall data once per distinct `card_id` in a separate query; keep `transformScryfallJson` output identical.
- [ ] Client: derive pick-driven state (`takenCardNamesSet`, `seatCardList`, per-seat counts) from `board.picks` (already in every poll response) instead of refetching `/api/cards` per pick. `dataVersion` pick-bumps stop triggering `fetchCardData`; only ingestion/cube changes (hash change from Task 19's server-included hash) do.
- [ ] `/api/cards` caching: with per-pick refetches gone, the active-draft `no-store` can become cacheable keyed by `?v=<ingestionHash>` like the static path. Verify the cube/banned/stats payload truly only changes with ingestion.
- [ ] Tests: getCards output unchanged (snapshot the transformed shape before/after); store tests for pick-derived state from `board.picks`.

### Task 22: `/live` payload + change short-circuit (P2 — Critical)

**Files:** Modify `src/core/db/queries/picks.ts:426-444`, `src/app/api/drafts/[id]/live/route.ts`, `src/app/stores/draftStore.ts` polling (+ tests).

- [ ] `getPicksWithCardDetails`: select `json_extract(c.scryfall_json, '$.oracle_id')`, `'$.color_identity'`, `'$.mana_cost'` instead of the full blob.
- [ ] Add client-sent `?since=<latestPickN>&names=<seatNamesHash>` (or one combined etag-ish param): route checks `getLatestPickNumber` (+ cheap seat-name/phase/match-count check) first and returns `{ unchanged: true }` without running the heavy queries when nothing moved. Client treats `unchanged` as a no-op.
- [ ] Tests: route returns slim fields identically; unchanged short-circuit verified; client no-ops on `unchanged`.

### Task 23: Poll identity churn (P3 — Critical; P4 — Important)

**Files:** Modify `src/app/stores/draftStore.ts:160-196`, `src/app/stores/liveStore.ts:419-427,509,878-887`, `src/core/deckBuilder.ts:172-214` (+ tests).

- [ ] P4: `applyPollResults` compares payload (it already computes the change signals) and skips `setState`/reuses previous references when `latestPickN`, `seatNames`, `matchCount`, `phase` are all unchanged.
- [ ] P3: `fetchQueue`/`fetchFloatedCards` deep-compare fetched data with current state before `set()` — identical content keeps identical references.
- [ ] P3: `deckReducer` REBUILD returns the previous state object when the rebuild is deep-equal (kills the `structuredClone`-always-new behavior that defeats the `next === prev` guard and PUTs deck-state every 10s).
- [ ] Also: reset `deckBuilderActive` when the deck-builder modal closes, not only on draft/seat deselection (`useModalManagement.ts:43-48`).
- [ ] Tests: 3 idle poll cycles → zero deck-state PUTs, zero board re-renders (assert via reference equality on store state).

### Task 24: Fold queue/float into `/live` (P6 — Important)

**Files:** Modify `src/app/api/drafts/[id]/live/route.ts`, `src/app/stores/draftStore.ts`/`liveStore.ts:786-795` (+ tests).

- [ ] When the request carries a valid `X-Seat-Token`, `/live` includes `{ me: { queue, floatedCards, autoPick, displayName } }`. Client polling consumes it; the separate per-poll `fetchQueue`/`fetchFloatedCards`/`refreshSettings` calls are removed (the endpoints stay for mutations' refresh paths).
- [ ] Keep `/live` unauthenticated behavior identical when no token present.
- [ ] Tests: token request gets `me`; tokenless doesn't; poll cycle = 1 request.

### Task 25: Pause polling when hidden (P5 — Important)

**Files:** Modify `src/app/stores/draftStore.ts:302-322` (+ test).

- [ ] `visibilitychange` listener: stop the interval when hidden, on visible run `refreshNow()` and restart. Guard for SSR (no `document`).

### Task 26: Perf minors (P7, P8, P9)

**Files:** `src/app/stores/cardStore.ts:410-423`, `src/app/components/PageClient.tsx:15-17`, `src/core/db/queries/picks.ts:162-167` (+ tests).

- [ ] P7: cache card-stats responses in a Map keyed by `name+excludeDraftId`, invalidated on ingestion-hash change.
- [ ] P8: `next/dynamic` imports for `DeckBuilderPanel` (with `@dnd-kit`) and `DraftBoardModal`.
- [ ] P9: `getAvailableCards` selects `scryfall_json` only when `color`/`type_contains` filters require parsing.

---

## Chunk 6: Structural refactors

### Task 27: Auto-pick single source of truth (A2 — Important)

**Files:** Modify `src/app/stores/liveStore.ts:671-705`, `src/core/processPick.ts`/`src/core/db/queries/pickQueue.ts`, add route or extend `src/app/api/drafts/[id]/pick/route.ts` (+ tests).

- [ ] Replace the client-side `triggerAutoPick` queue-traversal with a server call: a token-authed endpoint (e.g. POST `pick` body `{ auto: true }`) that runs the SAME server-side candidate selection (`getAutoPickCandidate`/`fulfillGroupEntry`) and submits the pick — one implementation of pause/flow-through/group semantics.
- [ ] Client keeps only the trigger condition (my turn + autoPick enabled + not in flight) and the `autoPickInFlight` guard.
- [ ] Tests: endpoint picks the same card the cascade would; pause-exhaustion behavior identical via either path; client trigger test simplifies to "calls endpoint when it's my turn".

### Task 28: liveStore split (A4 — Important; Q9, A10)

**Files:** Split `src/app/stores/liveStore.ts` into e.g. `liveAuthStore`/`liveAuth.ts` (token, seat, settings), `queueStore`/`queueFloat.ts` (queue + floats + optimistic ops), `deckBuilderStore`/`deckSave.ts` (reducer dispatch + debounced save machine). Update `selectors.ts`, all component imports, tests.

- [ ] Mechanical split AFTER the chunk-4 fixes land (move fixed code, don't re-fix). Keep one Zustand store if simpler, but separate modules per concern with the module-scoped save-machine state encapsulated in its module.
- [ ] Q9 dedup in the process: single `parseServerQueue` (also drop the dead dual-shape `cardId/cardName` tolerance — server sends `{id,name}` only), single `mutateFloat(cardName, method)`, single error-revert helper.
- [ ] A10: break the `liveStore` ↔ `selectors` cycle (selectors import stores, never the reverse; move `getIsAuthed` usage accordingly).
- [ ] Import-time cross-store subscriptions get one documented registration point (e.g. `stores/wiring.ts`) so initialization order is explicit.

### Task 29: Component fetch consolidation (A7 — Important)

**Files:** Modify `src/app/components/draft-board/MatchMatrix.tsx:127`, `StandingsSection.tsx:126`, `src/app/components/deck-builder/DeckBuilderPanel.tsx:150`, stores (+ tests). (`PickAutocomplete` handled in Task 20.)

- [ ] Move match-report POST into a store action (single home for `X-Seat-Token` plumbing); MatchMatrix calls the action.
- [ ] Standings fetch moves to draftStore (or a board-scoped store slice) keyed on `matchCount`; StandingsSection subscribes.
- [ ] DeckBuilderPanel's fetch moves into the deck-builder store module (post-split).

### Task 30: Card-name resolution consolidation (A11 — Minor)

**Files:** `src/core/db/sync/` (post Task 11), `src/core/db/queries/cards.ts:136-148`, `src/core/db/sync/card-cache.ts`.

- [ ] Co-locate the three resolution mechanisms in one module with explicit names: `resolveFuzzy` (sheets ingestion: case-insensitive + DFC + alias + Scryfall fallback), `resolveExact` (live picks), `CardCache` (bulk ingestion). Document when each applies. No behavior change.

### Task 31: Query-boundary stragglers (A3-rest, Q14 `/me`)

**Files:** Modify `src/app/api/drafts/[id]/queue/route.ts:113-135`, `src/app/api/drafts/[id]/me/route.ts:14-24`, `src/core/tokenAuth.ts` (+ tests).

- [ ] Queue route's inline `INSERT OR IGNORE INTO floated_cards`/`DELETE FROM floated_cards` → use `addFloatedCard`/`removeFloatedCard` (batch variants if needed in `floatedCards.ts`).
- [ ] Extend `authenticateSeat` to return `displayName` (and whatever `/me` needs); `/me` uses it instead of its inline reimplementation.

---

## Chunk 7: Code-quality leftovers

### Task 32: Quality bundle (Q6, Q10, Q11, Q13, Q14-rest)

**Files:** `src/core/db/queries/stats/rankedAvailable.ts:191-201`, `stats/pickStats.ts:167-182`, `stats/cardStats.ts:119-191`, `src/core/parseSheetRows.ts:96-122`, `src/app/stores/cardStore.ts:361-368`, `src/app/stores/draftStore.ts:119,261,285`, `src/core/getCards.ts:528`, `src/app/components/CardTable.tsx:206`, `CardStatsModal.tsx:295`, `src/core/snakeDraft.ts:16`, `scripts/decklists.ts`, `scripts/draft-admin.ts` (+ tests).

- [ ] Q6: both inline opt-out fetches → `fetchOptOuts`.
- [ ] Q13: extract the filtered/overall fallback shape used twice in `getCardStats` (and once in `rankedAvailable`) into one helper.
- [ ] Q10: delete `parseUnpickedCards` + its tests.
- [ ] Q11: name-search analytics uses the existing `searchTimeout` debounce (one event per settled query, no `result_count: -1` placeholder if cheaply fixable; otherwise drop the field).
- [ ] Q14: guard the three localStorage `JSON.parse` sites with try/catch; remove unreachable `?? 10` fallbacks in favor of `DEFAULT_NUM_SEATS` (incl. `cardStore.ts:241`, document the SQL-baked one in `getDraftStats`); name the CI-margin helper (`ciMarginPct`) and use at both sites; name the snake-draft `/4` rule (`DOUBLE_PICK_FINAL_FRACTION` or comment); name magic values (queue cap 500, deck-save retry 5000, action-pending 600, decklists 0.5/200).
- [ ] Scripts: parameterize the decklists deck/sideboard zone loop; `draft-admin enterMatch` validates seat bounds + `seat1 !== seat2` + records `reported_by_seat` like the app path; fix the `draft-admin.ts:6-13` header to list `reorder-seats`.

---

## Chunk 8: Test quality

### Task 33: False-confidence tests (T1, T2, T3 — Critical)

**Files:** `src/core/getDraftStats.test.ts`, `src/app/api/draft-stats/route.test.ts`, `src/core/db/queries/pickQueue.test.ts:351` (done in Task 6 — verify), `src/app/components/PageClient.test.tsx:149,154,270`.

- [ ] Rewrite `getDraftStats` tests against an in-memory libsql database (the `decks.test.ts` pattern) so the production SQL (CTE, `num_seats = 10` filter, draftIds filtering) actually executes. Delete the mock that reimplements the aggregation.
- [ ] Fix the draft-stats route test to assert the REAL shape (`winRateBySeat`, `winRateByColor`, `ingestionHash`).
- [ ] Replace PageClient's `getByText(/Read the Bones/)` smoke assertions with assertions on content that varies with input (or un-mock CardTable enough to show data).

### Task 34: Auto-pick client coverage (T4 — Important)

**Files:** `src/app/stores/liveStore.test.ts` (+ the Task 27 endpoint's route test).

- [ ] Post-Task-27 the client trigger is thin — test: fires on my-turn+enabled, respects `autoPickInFlight`, retries on "already been picked", handles server pause-exhaustion response. Server-side traversal semantics covered in Tasks 5/27.

### Task 35: Sync failure-path tests (T5 — Important)

**Files:** `src/core/db/sync/__tests__/sync.test.ts`, `src/core/__tests__/sync.test.ts` (post-Task-11 locations), `src/app/api/sync/route.test.ts`.

- [ ] Partial failure: `deleteDomainData` succeeds, batch insert throws → domain hashes NOT updated (next sync re-replaces).
- [ ] Hash persistence: after a replace, `updateDomainHashes` called with the new hash (regression guard against perpetual full-replace).
- [ ] Lock CAS: stale-lock takeover via an in-memory libsql db (real SQL, not mocked `rowsAffected`); contention returns `in_progress`; `releaseSyncLock` runs on throw (`finally`).
- [ ] `syncPool`/`ensureCubeSnapshot`: consistency check, qty backfill, stale-snapshot recreation, `flushMissing`; `syncAll` happy path. Use in-memory db + stubbed Scryfall fetches.
- [ ] Route: missing `GOOGLE_SHEETS_API_KEY` → 500; cron auth (valid/invalid).

### Task 36: Query coverage gaps (T6 — Important)

**Files:** `src/core/db/queries.test.ts`, `stats/pickHistory.test.ts`, new `stats/cardStats.test.ts`, new `winningDecks.test.ts`.

- [ ] Feed `banned_cards` through existing mocks: `getAvailableCards` exclusion incl. DFC front-face matching; `pickHistory` banned-draft skip + `timesBanned`.
- [ ] Standings: OMW%/OGW% 1/3 floor; `numSeats` padding for matchless seats; direct `aggregateMatchRecords` tests (orientation, draws).
- [ ] `getCardStats`: deck-colors fallback, Wilson CI, low-sample flag — in-memory db, no query-module mocking.
- [ ] `getWinningDecksByColor`: opt-out exclusion, two-key ranking, top-4 cut, overlap computation.

### Task 37: Remaining coverage (T7 — Important)

**Files:** `src/core/getCards.test.ts`, `src/core/deckBuilder.test.ts`, `src/app/stores/liveStore.test.ts`, `src/app/components/HoldToPickButton.test.tsx`, `CardStatsModal.test.tsx`, `src/core/cubecobra.test.ts`.

- [ ] getCards: banned cards skipped in unpicked pool entries; `copyNumber`; `unpickedQty` with qty>1; new-card `weightedGeomean: Infinity` path.
- [ ] deckBuilder REBUILD multi-copy: `canonicalCounts`/`keptCounts` machinery against the multi-copy design doc scenarios.
- [ ] liveStore `syncDeckWithPicks`: speculative dedup, auth gating, identity handling (post Task 13/20 shape).
- [ ] HoldToPickButton: handler-stripping when `disabled || confirmed`. CardStatsModal: click queue/float/pick handlers, `actionPending` debounce, Escape/backdrop close.
- [ ] `fetchCubeCobraList` + `loadCardPool` cubecobra branch (stubbed fetch).
- [ ] Route validation branches: seat-settings 400s ×3; deck-state PUT 413 + malformed JSON; deck POST 413 + malformed JSON.
- [ ] searchUtils: inputs that isolate the negation/OR/parentheses branches (no `t:`/`c:` shortcut satisfying the regex).

### Task 38: Test hygiene minors (T8)

**Files:** various test files per the audit list.

- [ ] Fix misleading test names (useHoldToConfirm:52, InlineEditableName:192, parseSheetRows:990, getCards:312, calculateStats:335 — make each assert what its name says).
- [ ] Delete SQL-string echo tests (matches.test.ts:40, floatedCards.test.ts:36, seatTokens.test.ts:107, queries.test.ts:100).
- [ ] Isolation: restore `global.fetch`/`window.location` and clear localStorage in PageClient/liveStore tests; settle the fake-timer flush leak (liveStore:1437); fake the 75ms Scryfall sleep (core sync test:166); fix the draft-switch test wiped by its own setup (liveStore:1683); remove stale `queuedCards` mock field (CardStatsModal:30).
- [ ] Add boundary pins: validateDeckState 100-card accept; inferDeckColor 30% threshold; tokenAuth header-over-query precedence (post Task 10: header-only — pin THAT); snake-draft reverse double-pick order; isLocalHost lookalikes (if isLocal survives Task 10, else drop).
- [ ] localSearch: assert recovery RESULTS for unmatched parens/dangling `or`; cover `c<`/`c>`.

---

## Chunk 9: Documentation

### Task 39: CLAUDE.md + README refresh (C1–C5)

**Files:** `CLAUDE.md`, `README.md`.

Wait until code tasks are done — several findings change the facts (POST /api/sync deleted, `/me` shape, auto-pick endpoint, deck-state validation).

- [ ] C1: `/me` response → `{ seat, autoPick, displayName }` (+ any Task 31 changes).
- [ ] C2: remove "Sync Now" claims; document the Vercel cron (every 10 min, `CRON_SECRET`) as THE sync mechanism for active Sheets drafts.
- [ ] C3: remove the nonexistent `inline-pick-autocomplete-design.md` spec entry (or recover the file if it exists in git history — check `git log --all --diff-filter=D`).
- [ ] C4: fix "dynamic SSR" annotations (build is static prerender); add the 4 missing specs + 5 missing plans to the indexes (plus this plan); document head-to-head match matrix, queue groups/per-entry modes, multi-copy queue in feature lists; README queue bullet → entries drag-reorder, grouping is buttons-only; document `GOOGLE_SHEETS_API_KEY` and `CRON_SECRET` in setup.
- [ ] C5: add `reorder-seats` to the admin subcommand list; README precommit line includes e2e; add `name_contains` (pool) and `exclude_draft_id`/`draft_name` (cards/stats) to API tables; drop "win equity" from README features; document `--pool file:<path>` + `--banned-cards`; expand the scripts line in the structure tree; fix stale "(this audit)" label; reflect new modules from this plan (draftPhases, withApiErrors, etc.) in the structure tree.
- [ ] Sweep both docs against the final diff of this branch for anything else stale.

---

## Chunk 10: Audit report

### Task 40: Final report

- [ ] Re-run full gate (`pnpm typecheck && pnpm lint && pnpm knip && pnpm test`); optionally attempt `pnpm test:e2e` once (chromium + TLS workaround are now installed in the sandbox) — failures there are informational, not blocking.
- [ ] Write `docs/audits/2026-06-11-deep-clean.md` per the deep-clean skill template (findings-by-category tables with fixes, test impact before/after, new modules, not-addressed).
- [ ] Commit the report.

---

## Execution notes

- **Sequential SDD in the main repo** — no worktrees. Executor agents use `model: sonnet`. Each task: read this plan section + the named files, implement, run the gate, commit (`git -C` always, never `cd`).
- **Gate per task:** `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`. E2e excluded (user decision; sandbox).
- **Dependencies:** Chunk 1 before everything (foundations). Task 13 before 14/20-deckState. Task 11 before 30/35. Task 27 before 28/34. Chunk 4 before 28 (fix, then move). Task 21/22 coordinate with 19/23 on dataVersion/hash semantics — read each other's diffs.
- **Commit messages:** why-focused, 1–2 sentences, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
