# Deep Clean Audit Report — 2026-08-10

**Branch:** `deep-clean-fixes-2026-08-10` (16 commits, 49 files changed, +2396 / −382 lines)

**Window audited:** `01c2661~1..HEAD` as of `13f5cfe` — 97 commits over 2026-08-06 to 08-09, 127 files, +15209 / −1542. Re-verified against `16f1ac0` after the `autopick-cascade-parity` and `turso-read-reduction` branches merged mid-audit.

## Summary

Seven parallel reviewers audited four days of unusually dense work covering session-weighted pick scoring, the maindeck creature split, mobile viewport and queue UX, ingest-time privacy redaction, decklist recovery tooling, and the live-draft double-pick boundary fix. The quality gate passed before review began, so nothing reported here is something a linter would have caught.

39 findings emerged: 8 Critical, 17 Important, 14 Minor. They were not evenly distributed. Four of the eight Criticals were one story — **the privacy redesign moved enforcement from many read paths onto a single ingest path, and the single path had gaps the old redundancy used to cover.** The rest were a turn derivation that survived a unification, a store that reset one field and not its neighbour, and documentation that had drifted from the code it described.

15 of the 39 were fixed here. Two independent correctness bugs were closed, both of which could produce user-visible failures: a pick-count derivation that would permanently deadlock a live draft after an admin undo, and a draft switch that could write one draft's cards into another draft's saved deck. Eight findings were deliberately deferred with reasons recorded, and one (the retroactive opt-out gap) was resolved as a documentation correction at the user's direction rather than an enforcement change.

Every task shipped as one commit with a full `pnpm precommit` pass. The suite grew from 1866 to 1888 unit tests; all 53 Playwright e2e tests stayed green throughout.

## Findings by Category

### Security & Privacy (5 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| C1 | Critical | Retroactive opt-out does nothing for a completed draft. `insertOptOuts` has one caller (CLI `syncDraft`), and `pnpm sync` selects only `phase IN ('setup','drafting','playing')`, which completed drafts have left permanently. README promised the opposite. The backstop script shares the blind spot, and the read-time masks that used to catch this were removed in `c7b6247`. | Documentation corrected, per user decision: the behaviour is acceptable given opt-outs are handled before drafts complete and this has not arisen across 20+ drafts. README now states that syncs of drafts still in the window delete predating rows, that completed drafts have left it, and that naming a seat afterwards requires re-syncing those drafts individually. No enforcement change. |
| C2 | Critical | `loadOptOutNames` caught every error and returned an empty set, so a malformed `.opt-outs.json` was indistinguishable from "nobody opted out" — on the only input still enforcing the promise. | Throws on a file that exists but cannot be parsed as an array of strings. A missing file still returns empty, which is the legitimate state for a checkout without opt-outs and for the serverless environment the gitignored file never reaches. Verified the throw surfaces: the one caller is reached from `scripts/sync.ts`, whose `main()` logs and exits nonzero. |
| C3 | Critical | `scripts/redact-opted-out.ts` parsed `--dry-run` with `process.argv.includes`, so `--dryrun` ran a live delete against production. The shared guard written for exactly this hazard had been applied to the two *less* destructive sibling scripts. | Adopted `assertRecognizedFlags` via an exported `parseRedactArgs`. Also fixed a live hazard found while testing: `main()` ran unconditionally at module scope, so importing the module would have executed the migration. Added the `invokedDirectly` guard copied from `import-recovered-decks.ts`. |
| I5 | Important | The cron never records opt-outs, so a Sheets draft created with `draft:create` was ingested within a minute, writing an opted-out seat's picks unredacted until the operator's first CLI sync. The failing test confirmed this was live: 2 picks inserted and the phase advanced to `playing` by the cron alone. | `syncActiveDraft` skips any draft still in `setup` and returns `awaiting_cli_sync`. The plan's premise (gate on absent domain hashes) proved wrong and was replaced during implementation — see Plan Corrections. |
| I8 | Important | `scripts/decklists.ts` writes `deck_cards` and `deck_hashes` and never consulted `privacy_opt_outs`. Its protection was emergent — an opted-out seat has no picks, so it cannot clear the matcher's gates — which holds only while `pick_events` is already clean. | Added `assertSeatNotOptedOut`, called once per seat before the write batch is built. Placed upstream of the dry-run/real-write branch, so one call site covers both paths and a dry run surfaces the same refusal a real write would throw. |

### Correctness (2 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| C5 | Critical | A fourth turn derivation survived `34c21ea`'s unification. `processPick` derived the pick number from `COUNT(*)` while the board, `isMyTurn` and the live route used `MAX(pick_n)`. These agree only while `pick_n` is gap-free, and `draft:admin undo-pick` deletes any pick, not just the last. After one such deletion the board and server name different seats, and `insertPickEvent`'s uniqueness guard makes every subsequent pick throw `ConflictError` permanently. | All three sites (the merge had added a third) now use `getLatestPickNumber`. Locals renamed `currentCount` to `latestPickN`. Discriminating test confirmed: a count-derived turn names seat 2 where the real one names seat 3. |
| C4 | Critical | The `activeDraft` subscription reset standings but left `board` and `liveDraftStatus` holding the previous draft's payload. In that window `cardStore` derives taken cards from stale picks, which triggers a deck rebuild and PUTs the previous draft's cards to the new draft's `deck-state`. The route validates `draftId` and `seat` but not that the cards belong to that draft's cube. | Both fields cleared in the same reset. Consumer audit confirmed every reader already tolerates null, because the same window exists on initial page load. Also closes a second hazard: `syncLocalDeck` could previously pair the old draft's `isSheetDraft` with the new `activeDraft`. |

### Statistics Modelling (1 fix)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| I1 | Important | `sessionsAgoByDraft` assigns dense ordinals over the dates it is given, and `pickScore`'s weight depends only on differences — so a uniform shift cancels, but a set omitting an *interior* session closes that gap and re-weights every older observation while leaving newer ones untouched. Four call sites passed four different draft sets. `worth.ts` documented itself as avoiding exactly this; `pickStats.ts` did the opposite. | **Decision (settled with the user): a session's recency is a property of the world, not of the query.** How much drafting has happened since an observation does not depend on which drafts the current view selects. `pickStats`, `rankedAvailable` and `getCards` now number against all stats-phase drafts and then filter, matching `worth.ts`. `worth.ts` untouched; `pnpm worth:validate` measured pooled rho 0.1718 before and after, bit-for-bit identical. |

### Performance (2 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| I6 | Important | Every `/live` poll paid five serial round trips before it could short-circuit, including the idle polls the `?since=` short-circuit exists to make cheap. | `getLiveStateSig`'s four independent reads run in one `Promise.all` (4 serial hops to 1); `getOptedOutSeats` folded into the route's existing `Promise.all`. Full poll drops from 5+ serial hops to 3. Guarded by a characterization snapshot of the signature string recorded before the refactor and unchanged after. |
| I7 | Important | The cron re-queried the opt-out seat set `reconcileRedactedRows` had just fetched and discarded, then fired three unbatched DELETEs on every run — before the hash short-circuit, so idle minutes paid in full. | `reconcileRedactedRows` returns the seat set it filtered on; the cron uses it instead of re-querying. Three DELETEs collapsed into one `client.batch`, verified to expose per-statement `rowsAffected` in request order. The CLI path was deliberately left alone — see Not Addressed. |

### Code Quality (1 fix)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| I2 | Important | Four incompatible definitions of "is this a land", two rendered side by side in the deck-builder header. A transforming card with a land back face was filed in the Lands column and counted toward the land total while contributing zero mana sources. | New `src/core/cardTypes.ts` exports `isLand` (any face, word-boundary), `isFrontFaceLand`, `isCreature`, and gives `FACE_SEPARATOR` a single home (it was declared twice with the literal inline in three more places). All four call sites converted. **Scope note:** the header and column placement now agree, but `isLandSource` still deliberately excludes transforming DFCs, which is correct — such a card produces no mana until it flips and is cast as a spell. The distinction is now named and shared rather than accidental. |

### Documentation (3 fixes)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| C6 | Critical | README's `draft:create-live` example omitted `--double-pick-after` for a 45-pick draft, which stores NULL and falls back to a `floor(N/4)` heuristic giving round 23 instead of 25. That mismatch is the production incident `34c21ea` was written to fix, so the documented example reproduced it. | Flag added to the example with an explanation, cross-checked against CLAUDE.md's own version so the two agree. |
| C7 | Critical | Cron cadence documented three ways: `vercel.json` is every minute, CLAUDE.md said every minute, README and two code comments said every 10 minutes. | All three stale claims corrected; `grep` for "10 min" now returns nothing. |
| C8 | Critical | `13f5cfe` moved the recovered decklists out of the repo, rewriting paths but not the reasoning around them. The recovery spec claimed the parsed JSONs were "committed to git" at a gitignored path, and one decision's rationale argued against its own conclusion — contradicting CLAUDE.md's correct warning on the one dataset with no second copy. | D4 now records the real risk (one disk, no backup, `draft:reset` plus a lost `data/` destroys them permanently, mitigation is an out-of-repo backup). D6 retitled and rewritten: the status report is regenerated from the database with `pnpm decklists:integrity --write-report`. The corresponding plan document was left alone as a historical record. |
| — | Important | Reference drift: `scripts/` listed 8 of 17 files and omitted `scripts/lib/` while citing its contents as authoritative elsewhere; six `src/core` modules missing from the structure tree; four commands undocumented; the doc index missing 4 specs and 10 plans; six pieces of README feature drift; a `--pool` default that does not exist in code. | All corrected against `ls`, `package.json` and each script's own argv parsing. Also documents the new cron behaviour from I5: the selection query still includes `setup`, so the phase list is right about which drafts are considered and wrong about which are ingested. |
| I10/I16 | Important | Comments contradicting their code (the live route documented the two-field sig marker after `autoPick` was added; the Pick Score tooltip listed two weight factors of three) and five comments narrating an incident rather than stating an invariant, against an explicit project convention. | All corrected. The narrative comments keep their insight and drop the story. A dangling "see comment at that call site" pointer was replaced with the actual justification plus a consequence nobody had written down: because `redactedSeats` is excluded from the signature, an opt-out recorded mid-draft does not reach a polling client until an unrelated change breaks the short-circuit. |

## Plan Corrections Found During Execution

Three cases where the plan was wrong about the code and the implementer corrected it. Recorded because each is a reasoning error worth not repeating.

| Where | The plan said | What was true |
|---|---|---|
| Task 5 | Gate the cron on `getDomainHashes` returning null for a never-synced draft. | It returns null only when the `drafts` row is missing. For the target scenario it returns a real object with null hash fields, so the guard would have been dead code. Gating on all-hashes-null was also unsafe: an existing cross-path test uses that exact state to represent an *already-synced* draft. Implemented as `currentPhase === "setup"` instead. Verified safe: the CLI's phase write is unconditional and `setup → drafting` is legal, so any successful CLI sync releases the draft. |
| Task 8 | Two of the three discriminating tests, as specified, would have caught the bug. | Neither would. The `pickStats` test filtered on a `draft_name` matching all three synthetic drafts, so no interior session was ever omitted; the `rankedAvailable` case reused an existing test whose older draft had a universal cube, so it never dropped out of the ordinal set. Both were rebuilt and each proven to fail against pre-fix code. |
| Task 13 | `sync/index.ts` had the same duplicate-lookup shape as the cron path. | It does not. Its `getOptedOutSeats` runs *before* `reconcileRedactedRows` and feeds `filterRedactedPicks` for both hashing and insertion — a load-bearing ordering dependency, not a duplicate. Correctly left unchanged. |

## Test Impact

- **Before:** 1866 unit tests, 53 e2e
- **After:** 1888 unit tests, 53 e2e (all passing)
- **New test files:** `scripts/redact-opted-out.test.ts`, `src/core/cardTypes.test.ts`
- **Enhanced:** `optOuts.test.ts`, `redaction.test.ts`, `decklists.test.ts`, `syncActiveDraft.test.ts`, `processPick.test.ts`, `draftStore.test.ts`, `cardStats.test.ts`, `rankedAvailable.test.ts`, `getCards.test.ts`, `queries.test.ts`, `picks.liveDraft.test.ts`

Two pieces of collateral test work worth knowing about when reading the diff: 33 mocks in `processPick.test.ts` changed from `{ cnt: N }` to `{ latest: N }` (mechanical, same values), and 19 tests across the store suites had to split a combined `setState({ activeDraft, board })` into two calls once the subscription began clearing `board`. Neither indicates a production pattern — hydration sets `activeDraft` while `board` is still null.

## New Modules

| File | Purpose |
|------|---------|
| `src/core/cardTypes.ts` | `isLand`, `isFrontFaceLand`, `isCreature`, `FACE_SEPARATOR` — one face-aware, word-boundary definition shared by the deck builder, mana sources and the worth model |
| `scripts/redact-opted-out.test.ts` | Flag-parsing coverage for the one script whose only action is deletion |

Also added to `src/core/db/ingest/redaction.ts`: `REDACTED_TABLES` and `countRedactedRows`, so the deletes, the dry-run counts and the migration's verification query all derive from one list.

## Not Addressed

Deferred deliberately. Carry forward rather than treating the audit as discharged.

| Finding | Why |
|---|---|
| **C1 enforcement** (retroactive opt-out unreachable for completed drafts) | User decision: has not arisen across 20+ drafts, will be handled case-by-case if it does. Documented accurately instead. |
| **I3** `redactedSeats` excluded from the live signature | Real, but trades a stale display against a per-poll cost on the every-minute path. The consequence is now documented in the route. Wants its own decision. |
| **I4** worth-table cache not invalidated by match reports or decklist writes | Needs a cache key covering writes that move no domain hash, plus a matching client-side gate. `a724ca8` solved exactly this for win stats by memoizing on a `deck_hashes` + `match_events` fingerprint — copy that shape. |
| **I9** `calculateStats`'s "fail loudly" branch yields `NaN` rather than throwing | Unreachable today by a documented invariant. Pin it when the surrounding code is next touched. |
| **I11, I12, I13** decklist script structure: untested 215-line `main()`, integrity checker missing the flag guard and `invokedDirectly` guard, duplicated write pipeline | A coherent refactor of three sibling scripts, better done as its own work than split across tasks. Note `redact-opted-out.ts` gained both guards here, leaving `decklists-integrity.ts` as the remaining holdout. |
| **I15** float/queue auth gate implemented five times | Mechanical but touches four render paths. Sequence after `cardTypes.ts` proves the shared-predicate pattern. |
| **I17** test gaps: worth in-flight dedup, CardTable clipping floor, mobile `dvh` | Additive test work, no production risk while deferred. The mobile suite's own comment concedes headless Chrome renders `vh == dvh`, so its assertion cannot fail. |
| **Minor findings** (basic-land lists defined five times, win/loss SQL fragment repeated four times, `pollFailed` never cleared by an unchanged response, three names for one P# field, `viewportUnits` implemented as a filesystem-scanning test) | Batch opportunistically. `FACE_SEPARATOR` was resolved as a side effect of I2. The `computeIngestionHash` row-order finding was fixed independently by `29032d9` during the audit. |
| **rtb-mcp-server** still instructs the model to expect `"[REDACTED]"` in API responses | Different repository. `picks.ts` narrowed `seat` to `number` and dropped `redacted_seats`. |

## Deployment Note

This work is on `deep-clean-fixes-2026-08-10`, not `master`. Pushing `master` deploys to production automatically, so this branch must be merged before any deploy — and per CLAUDE.md, `vercel --prod` from a branch would publish a build that the next push to `master` silently overwrites.
