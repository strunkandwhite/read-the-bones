# Read the Bones

Analytics tool for Magic: the Gathering rotisserie drafts. Aggregates pick data across multiple drafts to produce crowd-sourced card rankings.

## What It Does

- Syncs draft data from Google Sheets via the Sheets API
- Calculates card rankings using weighted geometric mean of pick position
- Displays results in a filterable, sortable web table
- Enriches cards with images and metadata from Scryfall
- Exposes draft data through a REST API

## Features

- **Scryfall-style search:** `t:creature`, `o:flying`, `c:r`, `mv<=2`, quoted phrases
- **Color filtering:** Filter by W/U/B/R/G/C (inclusive or exclusive matching)
- **Multiple copy handling:** First copy weighted more than subsequent copies
- **Unpicked card tracking:** Cards available but not drafted are penalized appropriately
- **Draft selection:** Compare stats across different draft subsets
- **Active draft sync:** Live pick updates from Google Sheets during an in-progress draft
- **Banned cards:** Per-draft card bans with visual indicators and filtered rankings
- **Deck builder:** Drag-and-drop deck building with maindeck/sideboard zones, server-side persistence, and shareable deck snapshots
- **Seat selection:** View individual drafter picks, available cards, and decklists by seat
- **Win rate analysis:** Multiple win metrics including game-percent win rate and decklist-based win rates
- **Card stats modal:** Detailed per-card statistics across drafts with pick history and win rate data
- **Live drafts:** Run rotisserie drafts in-app with snake order, pick queues, auto-pick cascades, and match reporting
- **Hold-to-pick confirmation:** Prevents accidental picks with a hold-to-confirm interaction
- **Inline pick autocomplete:** Type-ahead card name search when submitting picks
- **Queue management panel:** Reorderable pick queue — entries drag-and-drop to reorder priority; grouping is buttons-only (group/ungroup buttons merge adjacent entries into alternatives for the auto-pick cascade)
- **Queue groups with per-entry modes:** Grouped queue entries support pause mode (stops cascade at that group) or flow-through mode (cascade continues). Multi-copy cards tracked correctly through the cascade.
- **Float state:** Speculative card selections visible only to the player, persisted server-side
- **Server-side deck persistence:** WIP deck state saved to the server with save status indicator
- **Head-to-head match matrix:** Interactive grid in the draft board modal showing pairwise match results with inline editing. Standings include OMW%/OGW% tiebreaker columns.

## Setup

```bash
pnpm install
pnpm dev
```

Requires a Turso database. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env.local`, then run `pnpm db:migrate` to create tables.

For Sheets-based draft sync, set `GOOGLE_SHEETS_API_KEY` in `.env.local`. For the Vercel cron sync (runs every 10 minutes in production), also set `CRON_SECRET` — the cron endpoint (`GET /api/sync`) rejects requests without it.

## Development

```bash
pnpm test        # Run tests
pnpm build       # Build for production (statically prerendered)
pnpm precommit   # Run all checks: typecheck, lint, knip, tests, e2e
```

## Adding Draft Data

There are two ways to add drafts:

### Sheets-based drafts (importing external drafts)

For drafts run outside the app (e.g., via Google Sheets):

1. Create a draft record: `pnpm draft:create --name "Draft Name" --date 2026-01-15 --sheet-id <google-sheet-id>`
2. Sync data: `pnpm sync <draft-name>` (fetches pool, picks, and matches from Google Sheets into Turso)
3. Optionally add decklists: add sealeddeck.tech URLs to `data/decklists.txt`, then run `pnpm decklists`

Re-run `pnpm sync <draft-name>` to pull updated data as the draft progresses. Use `pnpm draft:reset <draft-name>` followed by `pnpm sync <draft-name>` to force a full reimport.

### Live drafts (in-app rotisserie drafts)

For drafts run directly in the app:

1. Create: `pnpm draft:create-live --name "Name" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:<id> [--banned-cards "Card A,Card B"]`
   - `--pool` accepts `cubecobra:<id>` or `file:<path>` (local card-list file)
2. Start: `pnpm draft:start <draft-name>`
3. Share seat URLs with players (printed by the create command)

## REST API

The app exposes GET endpoints under `/api/` for querying draft data programmatically:

| Route | Description |
|-------|-------------|
| `/api/drafts` | List all drafts (filterable by date and name) |
| `/api/drafts/[id]` | Get draft details including banned cards |
| `/api/drafts/[id]/picks` | Pick events (filterable by seat, pick range, card name) |
| `/api/drafts/[id]/available` | Cards available at a given pick number |
| `/api/drafts/[id]/available/ranked` | Available cards ranked by historical pick data |
| `/api/drafts/[id]/standings` | Match standings |
| `/api/drafts/[id]/pool` | Full draft pool (groupable by color or type; also accepts `name_contains` filter) |
| `/api/drafts/[id]/deck` | Decklist for a specific seat |
| `/api/cards/search` | Scryfall-style card search (`q` required) |
| `/api/cards/stats` | Card statistics across drafts (also accepts `exclude_draft_id`, `draft_name` filters) |
| `/api/stats` | Overall draft statistics |
| `/api/decks/winning` | Top winning decks by color archetype (`color_pair` required) |

### Live Draft Routes

These routes support in-app rotisserie drafting. Most require a seat token via `X-Seat-Token` header. Tokens are header-only — query-param tokens are not accepted on API routes.

| Route | Method | Description |
|-------|--------|-------------|
| `/api/drafts/[id]/live` | GET | Merged status + board data. Supports `?since=<pickN>&sig=<sig>` short-circuit. With a valid token, response includes `me: { seat, autoPick, displayName, queue, floatedCards }`. |
| `/api/drafts/[id]/me` | GET | Resolve seat from token: `{ seat, autoPick, displayName }` |
| `/api/drafts/[id]/pick` | POST | Submit a pick (`{ card_name }`) or trigger server-side auto-pick (`{ auto: true }`) |
| `/api/drafts/[id]/queue` | GET/PUT | Manage pick queue |
| `/api/drafts/[id]/match` | POST | Report a match result |
| `/api/drafts/[id]/seat-settings` | PUT | Update auto-pick, display name |
| `/api/drafts/[id]/float` | GET/PUT/DELETE | Manage floated (speculative) cards |
| `/api/drafts/[id]/deck-state` | GET/PUT | WIP deck state persistence. PUT body must include matching `draftId` and `seat`. |

## Player Privacy

Players are identified only by seat number within each draft. There is no cross-draft player identity.

### Opting Out of Queries

Players can opt out of having their picks and match results included in API query responses. Create a `.opt-outs.json` file in the project root:

```json
["Player Name", "Another Player"]
```

Names are matched case-insensitively against seat display names. When you run `pnpm sync`, opted-out players are recorded in the database. Their data is then redacted from query responses (seat numbers show as `[REDACTED]`), though their picks still affect game state calculations (e.g., available cards).

## Tech Stack

- Next.js + React + TypeScript
- Zustand (client-side state management)
- Turso (SQLite) database
- TanStack Table
- Scryfall API
- Vercel Analytics
