# Read the Bones

MTG rotisserie draft analytics tool.

## Project Structure

```
src/
  core/           # Framework-agnostic logic (parsing, stats, Scryfall)
    db/           # Turso database client, migrations
      queries/    # Domain-based query modules (cards, decks, decklists, drafts, floatedCards, helpers, matches, pickQueue, picks, playStats, pool, search, seatTokens, stats/, winStats, winningDecks)
      ingest/     # Ingestion helpers (Scryfall resolution, db-helpers, utils)
      sync/       # Unified sync pipeline (incremental.ts, lock.ts, syncActiveDraft.ts, domain hashing, batch ops, card cache)
    draftPhases.ts      # Shared draft-phase predicates (isCompletedForStats, STATS_COMPLETE_PHASES)
    manaColors.ts       # WUBRG color-identity normalization (normalizeColorIdentity)
  build/          # Build-time utilities (Scryfall cache)
  app/            # Next.js web app
    api/
      _lib/
        withApiErrors.ts  # Shared route error handler (AppError → status, everything else → 500)
    components/   # React components
      deck-builder/ # Deck builder panel and card management
      draft-board/  # Draft board modal and related components
    hooks/        # Custom hooks (useHoldToConfirm, useModalManagement, useScrollLock, useSharedDeckLoader, useSlowRenderTracking)
    stores/       # Zustand stores (draftStore, cardStore, liveStore, selectors, hydration, wiring)
      live/       # liveStore action modules (auth, deckSave, picking, queueFloat)
      computeMyDeckCardNames.ts  # Shared "my deck cards" union (picks + floats + queue)
      wiring.ts   # Explicit cross-store subscription registration
    api/          # API routes (internal + REST)
scripts/          # CLI tools (sync, draft-create, draft-create-live, draft-start, draft-admin, draft-delete, decklists, backfill-scryfall)
```

## Key Commands

```bash
pnpm dev         # Start dev server
pnpm build       # Build for production (statically prerendered, no prebuild step)
pnpm test        # Run tests
pnpm test:e2e    # Run Playwright e2e tests (requires chromium: npx playwright install chromium)
pnpm screenshot  # Take screenshot (requires dev server running)

# Quality checks
pnpm typecheck   # TypeScript type checking (tsc --noEmit)
pnpm lint        # ESLint (zero warnings allowed)
pnpm knip        # Detect unused files, exports, and dependencies
pnpm precommit   # Run all checks: typecheck → lint → knip → tests → e2e
                 # (a husky pre-push hook enforces this on every push —
                 #  run it yourself before pushing to catch failures early)

# Database commands
pnpm db:migrate  # Run database migrations (creates tables in Turso)

# Draft lifecycle (Sheets-based — for importing completed or in-progress external drafts)
pnpm draft:create --name "Draft Name" --date 2026-01-15 --sheet-id <id>  # Create draft record linked to a Google Sheet
pnpm sync <draft-name>         # Sync picks, pool, and matches from Google Sheets → Turso
pnpm sync                      # Sync all Sheets-based drafts
pnpm draft:reset <draft-name>  # Reset a draft (clear all data, re-sync from scratch)
pnpm draft:delete <draft-id>   # Permanently delete a draft and all associated data

# Draft lifecycle (live — for running rotisserie drafts in-app)
pnpm draft:create-live --name "Name" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:<id> --double-pick-after 25 [--banned-cards "Card A,Card B"]
# --pool accepts cubecobra:<id> or file:<path>
# Default cube ID for new drafts: cubecobra:samp
# --double-pick-after is the last single-pick round; 45-pick drafts use 25.
# Omitting it stores NULL, which falls back to the floor(N/4) heuristic
# (round 23 for a 45-pick draft) — pass it explicitly for 45-pick drafts.
pnpm draft:start <name>              # Start drafting (setup → drafting)
pnpm draft:admin <subcommand>        # Admin tools (undo-pick, edit-pick, regen-token, set-phase, add-ban, remove-ban, enter-match, reorder-seats)

# Decklists
pnpm decklists                 # Fetch decklists from sealeddeck.tech and write to Turso
pnpm decklists tarkir          # Fetch decklists for a specific draft

# Scryfall data
pnpm scryfall:backfill         # Fetch missing Scryfall data for cards in Turso, update local cache
```

**Decklists:** Add sealeddeck.tech URLs to `data/decklists.txt` (grouped by draft name), then run `pnpm decklists`. The script fetches each deck, matches it to a seat by card overlap with pick data from Turso, and writes deck cards directly to the database.

**Sync:** `pnpm sync` fetches data from Google Sheets and writes it to Turso. Per-domain hashing (pool, picks, matches) means only changed data is replaced. Use `pnpm draft:reset <name>` followed by `pnpm sync <name>` to force a full reimport. The cron path only reconciles picks and matches; pool/cube changes always need the CLI sync.

**Scryfall backfill:** When a new draft uses cards not in the local Scryfall cache (`cache/scryfall.json`), those cards get inserted into Turso with `scryfall_json = NULL`. Run `pnpm scryfall:backfill` to fetch missing card data from the Scryfall API, update the local cache, and backfill the database. This is typically needed after creating a live draft with a new/updated cube.

**Data flow:** The main page (`/`) is statically prerendered at build time — Turso is queried during `vercel build`, not on each request. Client-side state is managed with Zustand stores (draftStore, cardStore, liveStore) that are hydrated from the SSR snapshot and updated via polling. On localhost, the dev server fetches live from Turso on each request.

**After importing a new draft** (creating a live draft or syncing a Sheets-based draft), the deployed site won't show the new draft until you redeploy:
1. Run `pnpm sync <draft-name>` (or `pnpm draft:create-live ...`) to write data to Turso
2. Run `vercel --prod` to rebuild and publish — this re-queries Turso and bakes the new draft into the static page

## REST API

The app exposes REST API routes under `/api/` for querying draft data. All routes are GET with query string parameters.

| Route | Description | Key Parameters |
|-------|-------------|----------------|
| `/api/drafts` | List all drafts | `date_from`, `date_to`, `draft_name` |
| `/api/drafts/[id]` | Get draft details (includes banned cards) | — |
| `/api/drafts/[id]/picks` | Get pick events | `seat`, `pick_n_min`, `pick_n_max`, `card_name` |
| `/api/drafts/[id]/available` | Cards available at a pick. Response: `{ cards: [{ card_name, remaining_qty }] }` | `before_pick_n` (required), `color`, `type_contains` |
| `/api/drafts/[id]/available/ranked` | Ranked available cards | `before_pick_n` (required), `color`, `type_contains`, `deck_colors`, `limit`, `sort_by` |
| `/api/drafts/[id]/standings` | Match standings | — |
| `/api/drafts/[id]/pool` | Full draft pool | `include_draft_results`, `include_card_details`, `group_by`, `color`, `type_contains`, `name_contains` |
| `/api/drafts/[id]/deck` | Decklist for a seat | `seat` (required) |
| `/api/cards/search` | Scryfall-style card search | `q` (required), `draft_id`, `available_only`, `before_pick_n` |
| `/api/cards/stats` | Card statistics | `card_name` (required), `draft_id`, `exclude_draft_id`, `draft_name`, `date_from`, `date_to`, `deck_colors` |
| `/api/stats` | Overall draft statistics | `draft_ids` (comma-separated) |
| `/api/decks/winning` | Top 4 winning decks for a color archetype | `color_pair` (required), `draft_ids` (comma-separated) |

**Live draft routes** (used for in-app rotisserie drafts):

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/drafts/[id]/live` | GET | None/Token | Merged status + board data (phase, picks, seatNames, bannedCards). Accepts `?since=<pickN>&sig=<sig>` for change short-circuit (`{ unchanged: true }`). With a valid `X-Seat-Token`, the response includes `me: { seat, autoPick, displayName, queue, floatedCards }`. |
| `/api/drafts/[id]/me` | GET | Token | Resolve seat from token: `{ seat, autoPick, displayName }` |
| `/api/drafts/[id]/pick` | POST | Token | Submit a pick. Body: `{ card_name: string }` or `{ auto: true }` to trigger server-side auto-pick cascade. |
| `/api/drafts/[id]/queue` | GET/PUT | Token | Manage player's pick queue |
| `/api/drafts/[id]/match` | POST | Token | Report a match result |
| `/api/drafts/[id]/seat-settings` | PUT | Token | Update auto-pick toggle, display name |
| `/api/drafts/[id]/float` | GET/PUT/DELETE | Token | Manage floated (speculative) cards |
| `/api/drafts/[id]/deck-state` | GET/PUT | Token | WIP deck state persistence. PUT body must include matching `draftId` and `seat` or the request is rejected (400). |

**Token auth:** All token-authenticated routes accept the seat token via the `X-Seat-Token` header only. Query-param tokens (`?token=`) are not accepted on API routes (URL tokens appear in logs).

**Internal routes** (used by the web app, not part of the public API):
- `/api/cards` — Card data for client-side rendering
- `/api/draft-stats` — Draft stats for client-side rendering
- `/api/deck` — Shared deck snapshots (create/retrieve)
- `/api/sync` — Vercel cron sync endpoint (GET only, authenticated via `CRON_SECRET`). Runs every 10 minutes via Vercel cron (`vercel.json`). No manual POST endpoint exists.
- `/api/sync-status` — Returns current sync lock state

## Deploying

Deploy to Vercel production with `vercel --prod`. The Vercel CLI must be installed globally (`npm i -g vercel`) and authenticated (`vercel login`). Web Analytics is enabled via `@vercel/analytics` in the root layout.

**Run `vercel --prod` any time you add or import a new draft.** The main page is statically prerendered at build time, so new Turso data is invisible on the deployed site until a redeploy.

## Querying Turso

Use the Turso CLI to inspect the database directly:

```bash
turso db shell read-the-bones
```

Log in first with `turso auth login` if needed. Prefer this over ad-hoc scripts — it's faster, avoids import/require issues, and works for both quick checks and multi-statement exploration. The database name is `read-the-bones`.

## Important: Process Management

Kill running dev processes as soon as they're no longer needed. Don't leave `pnpm dev` running in the background - it blocks the port and causes issues when trying to restart.

## Data Format

Draft data lives in Google Sheets with three tabs:
- **Draft** tab: Row 3 = drafter names, rows 4+ = picks. Pick number in column A, card names in drafter columns. Card colors in rightmost columns.
- **Cube** tab: List of all cards available in the cube for that draft.
- **Matches** tab: Round robin match results.

Draft metadata (name, date, sheetId, bannedCards) is stored in the `drafts` table in Turso, created via `pnpm draft:create`.

## Card Name Normalization

Strip numeric suffixes from duplicate cards: "Scalding Tarn 2" → "Scalding Tarn"

## Search Syntax

Local Scryfall-style search (searches only cards in the cube):

- `t:creature` - type search
- `o:flying` - oracle text search
- `o:"draw a card"` - quoted phrases
- `c:r` - color (w/u/b/r/g, c=colorless)
- `c:ub` - multicolor (blue AND black)
- `mv=3` - exact mana value
- `mv<=2` - comparison (<, >, <=, >=)
- `bolt` - name search (plain text)
- `t:instant c:u` - combine terms (AND logic)

Search is debounced (500ms) and runs locally against cached card data. Server-side search is also available via `/api/cards/search` (supports `draft_id` and `available_only` filters).

## Key Features

- **Active draft sync:** Drafts linked to a Google Sheet (`sheetId` in metadata) are synced by a Vercel cron job calling `GET /api/sync` every 10 minutes (authenticated via `CRON_SECRET`). The cron covers phases `setup`, `drafting`, and `playing`: it inserts missing picks, updates picks whose sheet cell was edited after the fact, and hash-syncs match results. When every pick cell is filled the draft moves `drafting → playing`; when the full round robin (n·(n−1)/2 matches) is recorded — or 60 days after the draft date — it moves `playing → complete` and leaves the sync window. `pnpm draft:admin set-phase` overrides at any time; there is no manual "Sync Now" button — use `pnpm sync <name>` from the CLI for on-demand full syncs.
- **Banned cards:** Drafts can specify banned cards in metadata. Banned cards are visually marked in the card table and excluded from available card queries.
- **Deck builder:** Per-seat deck building panel with drag-and-drop, maindeck/sideboard zones, save status indicator, and shareable deck snapshots via `/api/deck`. Live drafts persist WIP decks server-side (seat token auth); sheet drafts persist locally in the browser (localStorage, keyed by draft + seat) with an "Add to Deck Builder" button replacing Float. The maindeck splits into a creature row and a non-creature row over the same mana-value columns, with a single full-height lands column beside them; the row is stored in the column key (`nc-` prefix), so a card the user moves stays where they put it. The sideboard is not split.
- **Shared decks:** Immutable deck snapshots stored in the `decks` table (kind = 'snapshot'), accessible via short URLs.
- **Seat selection:** View picks and deck data for individual seats within a draft.
- **Decklist win rate:** Dev-only data (disabled in production via `NODE_ENV !== "production"`) showing actual win rates in the card stats modal.
- **Live drafts:** Run rotisserie drafts in-app with snake order, pick queues, and auto-pick cascades. Created via `pnpm draft:create-live`, managed via seat tokens for player identity. Draft board modal shows pick matrix, standings, and match reporting.
- **Head-to-head match matrix:** Interactive grid in the draft board showing all pairwise results with inline editing and OMW%/OGW% tiebreaker columns in standings. Standings sort by match wins → OMW% → OGW% → head-to-head (two-way ties only; larger tied groups can be cyclic and keep sorted order).
- **Queue groups with per-entry modes:** Queue entries can be grouped (buttons-only, not drag) so the auto-pick cascade treats grouped cards as interchangeable alternatives. Each entry supports pause mode (stops cascade at that entry) or flow-through mode (cascade continues past it).
- **Multi-copy queue support:** Queue entries reference cards by ID; multiple copies of the same card are tracked correctly through the cascade.

## Terminology: Picks vs Rounds

- **Pick position**: Absolute number (1-450). The order a card was selected in a draft.
- **Round**: Which pass through the drafters. Round = `ceil(pickPosition / numDrafters)`.
  - With 10 drafters: Round 1 = picks 1-10, Round 2 = picks 11-20, etc.
- **Unpicked penalty**: A draft in which *no* copy was taken contributes one
  half-weight observation at pickPosition = poolSize (540). A draft that took at
  least one copy contributes only the copies it took — a leftover copy of a
  qty-2 card means demand was not two deep, not that the card went unwanted.

The UI displays "Pick Score" (P#): the weighted geometric mean of pick positions
across drafts, computed by `src/core/pickScore.ts`. Three factors set an
observation's weight — copy number (`0.5^(copy-1)`), whether anyone took it
(`0.5` if not), and how many drafting sessions ago the draft ran
(`0.5^(sessionsAgo/4)`).

Drafts sharing a `draft_date` are one **session** — parallel pods are a single
drafting occasion. Recency decays over sessions rather than days because what
moves card evaluations is drafting and playing, not the calendar. Because the
geometric mean normalizes by total weight, P# is unchanged by time passing; it
moves only when a new session lands.

**Privacy:** Players are identified by seat number (1-N) within each draft only. No cross-draft player identity is tracked. Players can opt out of API query responses (see README).

## Design Documents

- `docs/plans/2026-01-08-card-rankings-design.md` - Architecture and algorithm details
- `docs/plans/2026-01-09-draft-selection-design.md` - Draft selection UI
- `docs/plans/2026-01-09-new-statistics-design.md` - Statistics calculations

### Superpowers Specs

- `docs/superpowers/specs/2026-03-19-active-draft-filtering-design.md` - Active draft filtering with serverless sync
- `docs/superpowers/specs/2026-03-19-banned-cards-design.md` - Banned cards support
- `docs/superpowers/specs/2026-03-19-decklist-win-rate-column-design.md` - Decklist win rate column
- `docs/superpowers/specs/2026-03-19-incremental-ingestion-design.md` - Incremental ingestion (picks, matches, decklists)
- `docs/superpowers/specs/2026-03-19-server-side-card-stats-design.md` - Server-side card stats API
- `docs/superpowers/specs/2026-03-20-seat-selection-design.md` - Seat selection UI
- `docs/superpowers/specs/2026-03-20-deck-builder-design.md` - Deck builder panel
- `docs/superpowers/specs/2026-03-21-deck-builder-modal-and-sharing-design.md` - Deck builder modal and sharing
- `docs/superpowers/specs/2026-03-21-analytics-custom-events-design.md` - Analytics custom events
- `docs/superpowers/specs/2026-03-22-unified-sync-pipeline-design.md` - Unified sync pipeline (Sheets → Turso)
- `docs/superpowers/specs/2026-03-23-live-draft-design.md` - Live draft system (pool, drafting, matches, standings)
- `docs/superpowers/specs/2026-03-21-deep-clean-design.md` - Deep clean design
- `docs/superpowers/specs/2026-03-21-winning-decks-by-color-design.md` - Winning decks by color design
- `docs/superpowers/specs/2026-03-23-server-side-oracle-search-design.md` - Server-side oracle search design
- `docs/superpowers/specs/2026-03-27-inline-name-editing-design.md` - Inline name editing in live draft pod view
- `docs/superpowers/specs/2026-03-27-card-table-and-live-draft-ux-design.md` - Card table rework, stats modal, hold-to-pick, float state, queue management
- `docs/superpowers/specs/2026-03-27-server-side-deck-persistence-design.md` - Server-side deck persistence design
- `docs/superpowers/specs/2026-03-29-data-flow-consolidation-design.md` - Data flow consolidation (Zustand stores, polling, SSR hydration)
- `docs/superpowers/specs/2026-03-29-multi-copy-card-picks-design.md` - Multi-copy card picks design
- `docs/superpowers/specs/2026-03-31-multi-copy-queue-design.md` - Multi-copy queue support design
- `docs/superpowers/specs/2026-03-31-queue-groups-and-per-entry-modes-design.md` - Queue groups with per-entry pause/flow-through modes
- `docs/superpowers/specs/2026-04-03-e2e-test-suite-design.md` - End-to-end test suite design
- `docs/superpowers/specs/2026-04-13-head-to-head-match-matrix-design.md` - Head-to-head match matrix with inline editing and OMW%/OGW% tiebreakers
- `docs/superpowers/specs/2026-05-28-queue-panel-ux-design.md` - Queue panel UX: how-to section + buttons-only grouping
- `docs/superpowers/specs/2026-07-19-sheet-draft-deck-builder-design.md` - Sheet-draft deck builder (local mode) design
- `docs/superpowers/specs/2026-08-07-maindeck-creature-split-design.md` - Maindeck creature / non-creature split design

### Superpowers Plans

- `docs/superpowers/plans/2026-03-19-active-draft-filtering.md` - Active draft filtering implementation
- `docs/superpowers/plans/2026-03-19-banned-cards.md` - Banned cards implementation
- `docs/superpowers/plans/2026-03-19-decklist-win-rate.md` - Decklist win rate implementation
- `docs/superpowers/plans/2026-03-19-incremental-ingestion.md` - Incremental ingestion implementation
- `docs/superpowers/plans/2026-03-19-server-side-card-stats.md` - Server-side card stats implementation
- `docs/superpowers/plans/2026-03-20-seat-selection.md` - Seat selection implementation
- `docs/superpowers/plans/2026-03-20-deck-builder.md` - Deck builder implementation
- `docs/superpowers/plans/2026-03-21-deck-builder-modal-and-sharing.md` - Deck builder modal and sharing implementation
- `docs/superpowers/plans/2026-03-21-analytics-custom-events.md` - Analytics custom events implementation
- `docs/superpowers/plans/2026-03-20-codebase-cleanup.md` - Codebase cleanup (dead code, file splits, test quality)
- `docs/superpowers/plans/2026-03-22-unified-sync-pipeline.md` - Unified sync pipeline implementation
- `docs/superpowers/plans/2026-03-23-live-draft.md` - Live draft implementation
- `docs/superpowers/plans/2026-03-21-deep-clean-fixes.md` - Deep clean fixes (prior audit)
- `docs/superpowers/plans/2026-03-23-server-side-oracle-search.md` - Server-side oracle search implementation
- `docs/superpowers/plans/2026-03-26-live-draft-e2e-feedback.md` - Live draft e2e feedback fixes
- `docs/superpowers/plans/2026-03-26-live-draft-gap-closure.md` - Live draft gap closure
- `docs/superpowers/plans/2026-03-27-deep-clean-fixes.md` - Deep clean fixes (2026-03-27 audit)
- `docs/superpowers/plans/2026-03-27-inline-name-editing.md` - Inline name editing implementation
- `docs/superpowers/plans/2026-03-27-card-table-and-live-draft-ux.md` - Card table and live draft UX implementation
- `docs/superpowers/plans/2026-03-26-live-draft-ux-fixes.md` - Live draft UX fixes
- `docs/superpowers/plans/2026-03-27-getcards-decomposition.md` - getCards decomposition
- `docs/superpowers/plans/2026-03-27-live-draft-query-layer.md` - Live draft query layer
- `docs/superpowers/plans/2026-03-27-pageclient-decomposition.md` - PageClient decomposition
- `docs/superpowers/plans/2026-03-27-scryfall-module-reorganization.md` - Scryfall module reorganization
- `docs/superpowers/plans/2026-03-27-server-side-deck-persistence.md` - Server-side deck persistence
- `docs/superpowers/plans/2026-03-27-stats-module-split.md` - Stats module split
- `docs/superpowers/plans/2026-03-29-data-flow-consolidation.md` - Data flow consolidation implementation
- `docs/superpowers/plans/2026-03-29-live-draft-ux-fixes.md` - Live draft UX fixes
- `docs/superpowers/plans/2026-03-29-spectator-auth-gating.md` - Spectator auth gating
- `docs/superpowers/plans/2026-03-30-deep-clean-fixes.md` - Deep clean fixes (2026-03-30 audit)
- `docs/superpowers/plans/2026-03-31-multi-copy-queue.md` - Multi-copy queue support implementation
- `docs/superpowers/plans/2026-03-31-queue-groups-and-per-entry-modes.md` - Queue groups and per-entry pause/flow-through modes implementation
- `docs/superpowers/plans/2026-04-03-e2e-test-suite.md` - End-to-end test suite implementation
- `docs/superpowers/plans/2026-04-13-head-to-head-match-matrix.md` - Head-to-head match matrix implementation
- `docs/superpowers/plans/2026-06-11-deep-clean-fixes.md` - Deep clean fixes (2026-06-11 audit, this plan)
- `docs/superpowers/plans/2026-07-19-sheet-draft-deck-builder.md` - Sheet-draft deck builder implementation
- `docs/superpowers/plans/2026-07-20-sheet-draft-pick-reconciliation.md` - Sheet-draft pick reconciliation (float upgrade/removal on synced picks)
- `docs/superpowers/plans/2026-08-07-maindeck-creature-split.md` - Maindeck creature / non-creature split implementation
