# Read the Bones

MTG rotisserie draft analytics tool.

## Project Structure

```
src/
  core/           # Framework-agnostic logic (parsing, stats, Scryfall)
    db/           # Turso database client, migrations
      queries/    # Domain-based query modules (cards, drafts, picks, pool, decklists, stats)
      ingest/     # Ingestion helpers (Scryfall resolution, db-helpers, utils)
      sync/       # Unified sync pipeline (domain hashing, batch ops, card cache, orchestrator)
  build/          # Build-time utilities (Scryfall cache)
  app/            # Next.js web app
    components/   # React components
      deck-builder/ # Deck builder panel and card management
    hooks/        # Custom hooks (draft selection, card data, search, filtering, deck builder)
    api/          # API routes (internal + REST)
scripts/          # CLI tools (sync, draft:create, draft:reset, decklists)
```

## Key Commands

```bash
pnpm dev         # Start dev server
pnpm build       # Build for production (dynamic SSR, no prebuild step)
pnpm test        # Run tests
pnpm screenshot  # Take screenshot (requires dev server running)

# Quality checks
pnpm typecheck   # TypeScript type checking (tsc --noEmit)
pnpm lint        # ESLint (zero warnings allowed)
pnpm knip        # Detect unused files, exports, and dependencies
pnpm precommit   # Run all checks: typecheck → lint → knip → tests

# Database commands
pnpm db:migrate  # Run database migrations (creates tables in Turso)

# Sync pipeline
pnpm sync                      # Sync all active drafts from Google Sheets → Turso
pnpm sync tarkir               # Sync a specific draft
pnpm sync --dry-run            # Preview what would change without writing to DB

# Draft lifecycle
pnpm draft:create --name "Draft Name" --date 2026-01-15 --sheet-id <id>  # Create new draft
pnpm draft:reset <draft-name>  # Reset a draft (clear all data, re-sync from scratch)

# Decklists
pnpm decklists                 # Fetch decklists from sealeddeck.tech and write to Turso
pnpm decklists tarkir          # Fetch decklists for a specific draft
```

**Decklists:** Add sealeddeck.tech URLs to `decklists.txt` (grouped by draft name), then run `pnpm decklists`. The script fetches each deck, matches it to a seat by card overlap with pick data from Turso, and writes deck cards directly to the database.

**Sync:** `pnpm sync` fetches data from Google Sheets and writes it to Turso. Per-domain hashing (pool, picks, matches) means only changed data is replaced. Use `pnpm draft:reset <name>` followed by `pnpm sync <name>` to force a full reimport.

**Data flow:** The web app queries Turso at request time (SSR). To update draft data:
1. Run `pnpm sync` to pull latest from Google Sheets into Turso
2. Deploy or restart the dev server — data is fetched live from Turso

## REST API

The app exposes REST API routes under `/api/` for querying draft data. All routes are GET with query string parameters.

| Route | Description | Key Parameters |
|-------|-------------|----------------|
| `/api/drafts` | List all drafts | `date_from`, `date_to`, `draft_name` |
| `/api/drafts/[id]` | Get draft details (includes banned cards) | — |
| `/api/drafts/[id]/picks` | Get pick events | `seat`, `pick_n_min`, `pick_n_max`, `card_name` |
| `/api/drafts/[id]/available` | Cards available at a pick | `before_pick_n` (required), `color`, `type_contains` |
| `/api/drafts/[id]/available/ranked` | Ranked available cards | `before_pick_n` (required), `color`, `type_contains`, `deck_colors`, `limit`, `sort_by` |
| `/api/drafts/[id]/standings` | Match standings | — |
| `/api/drafts/[id]/pool` | Full draft pool | `include_draft_results`, `include_card_details`, `group_by`, `color`, `type_contains` |
| `/api/drafts/[id]/deck` | Decklist for a seat | `seat` (required) |
| `/api/cards/search` | Scryfall-style card search | `q` (required), `draft_id`, `available_only`, `before_pick_n` |
| `/api/cards/stats` | Card statistics | `card_name` (required), `draft_id`, `date_from`, `date_to`, `deck_colors` |
| `/api/stats` | Overall draft statistics | `draft_ids` (comma-separated) |
| `/api/decks/winning` | Top 4 winning decks for a color archetype | `color_pair` (required), `draft_ids` (comma-separated) |

**Internal routes** (used by the web app, not part of the public API):
- `/api/cards` — Card data for client-side rendering
- `/api/draft-stats` — Draft stats for client-side rendering
- `/api/deck` — Shared deck snapshots (create/retrieve)
- `/api/sync`, `/api/sync-status` — Active draft sync polling

## Deploying

Deploy to Vercel production with `vercel --prod`. The Vercel CLI must be installed globally (`npm i -g vercel`) and authenticated (`vercel login`). Web Analytics is enabled via `@vercel/analytics` in the root layout.

## Querying Turso

When you need to inspect the database directly, use the Turso CLI (`turso db shell`), not ad-hoc scripts. Log in first with `turso auth login` if needed.

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

Search is debounced (500ms) and runs locally against cached card data.

## Key Features

- **Active draft sync:** Drafts linked to a Google Sheet (`sheetId` in metadata) sync picks live via polling. The UI shows sync status and a "Sync Now" button.
- **Banned cards:** Drafts can specify banned cards in metadata. Banned cards are visually marked in the card table and excluded from available card queries.
- **Deck builder:** Per-seat deck building panel with drag-and-drop, maindeck/sideboard zones, and shareable deck snapshots via `/api/deck`.
- **Shared decks:** Immutable deck snapshots stored in the `shared_decks` table, accessible via short URLs.
- **Seat selection:** View picks and deck data for individual seats within a draft.
- **Decklist win rate:** Localhost-only column showing actual win rates of players who maindecked each card.

## Terminology: Picks vs Rounds

- **Pick position**: Absolute number (1-450). The order a card was selected in a draft.
- **Round**: Which pass through the drafters. Round = `ceil(pickPosition / numDrafters)`.
  - With 10 drafters: Round 1 = picks 1-10, Round 2 = picks 11-20, etc.
- **Unpicked penalty**: Cards not selected get pickPosition = poolSize (540), which converts to `ceil(540 / numDrafters)` rounds (e.g., round 54 with 10 drafters).

The UI displays "Pick Score" which is the weighted geometric mean of pick positions across drafts.

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
