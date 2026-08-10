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
- **Recency weighting:** Pick score also decays by drafting session, `0.5^(sessionsAgo/4)`, so recent sessions count more than old ones
- **Draft selection:** Compare stats across different draft subsets
- **Active draft sync:** Live pick updates from Google Sheets during an in-progress draft
- **Banned cards:** Per-draft card bans with visual indicators and filtered rankings
- **Deck builder:** Drag-and-drop deck building with maindeck/sideboard zones, server-side persistence, and shareable deck snapshots. The maindeck splits into a creature row and a non-creature row over the same mana-value columns, with a single full-height lands column beside them.
- **Seat selection:** View individual drafter picks, available cards, and decklists by seat
- **Win rate analysis:** Multiple win metrics including game-percent win rate and decklist-based win rates
- **Card stats modal:** Detailed per-card statistics across drafts with pick history and win rate data
- **Live drafts:** Run rotisserie drafts in-app with snake order, pick queues, auto-pick cascades, and match reporting
- **Hold-to-pick confirmation:** Prevents accidental picks with a hold-to-confirm interaction
- **Inline pick autocomplete:** Type-ahead card name search when submitting picks
- **Queue management panel:** Reorderable pick queue, with a dedicated grip handle on each entry as the sole drag activator so the buttons beside it stay reliably clickable on touch; grouping is buttons-only (group/ungroup buttons merge adjacent entries into alternatives for the auto-pick cascade)
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

For Sheets-based draft sync, set `GOOGLE_SHEETS_API_KEY` in `.env.local`. For the Vercel cron sync (runs every minute in production), also set `CRON_SECRET` — the cron endpoint (`GET /api/sync`) rejects requests without it.

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
3. Optionally add decklists: `data/decklists.txt` is an inbox, not an archive; it holds sealeddeck.tech URLs that have not been ingested yet, grouped by draft name. Add URLs under a draft-name heading, run `pnpm decklists --dry-run`, read the report, then run `pnpm decklists` to apply it. Once a submission is stored, remove its URL from the file. Follow up with `pnpm decklists:integrity` to check every stored decklist against its seat's picks.

Re-run `pnpm sync <draft-name>` to pull updated data as the draft progresses. Use `pnpm draft:reset <draft-name>` followed by `pnpm sync <draft-name>` to force a full reimport.

### Live drafts (in-app rotisserie drafts)

For drafts run directly in the app:

1. Create: `pnpm draft:create-live --name "Name" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:<id> --double-pick-after 25 [--banned-cards "Card A,Card B"]`
   - `--pool` accepts `cubecobra:<id>` or `file:<path>` (local card-list file)
   - `--double-pick-after` is the last single-pick round. Omitting it stores NULL and falls back to a floor(N/4) heuristic, which gives round 23 for a 45-pick draft and puts the board and the server on different seats.
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

### Opting Out

A player can opt out of having their card choices recorded. Create a `.opt-outs.json` file in the project root:

```json
["Player Name", "Another Player"]
```

Names are matched case-insensitively against the drafter names on the sheet. When you run `pnpm sync`, matching seats are recorded in `privacy_opt_outs`, and from then on **their picks and deck lists are never written to the database at all** — not hidden at read time, but absent. Every sync of a draft still in the sync window also deletes any such rows that predate the opt-out. Completed drafts have left that window, so add a name before the drafts it applies to complete; naming a seat afterwards requires re-syncing those drafts individually with `pnpm sync <draft-name>`.

Precisely what this does and does not cover:

- **Not stored.** Every card they picked, and their decklist: `pick_events`, `deck_cards`, and `deck_hashes` never get a row for that seat. Their choices are absent from the card table, from pick-score and win-rate statistics, and from every API response — there is nothing left to withhold.
- **Still stored.** Their match results, wins and losses. A W/L record names no cards, and every other player's OMW%/OGW% tiebreakers are computed from it, so dropping it would silently change other people's standings. Their seat therefore still appears in `/api/drafts/<id>/standings` with its record.
- **Still visible.** That the seat exists, and which picks it has taken. The pod sheet renders their column with `[REDACTED]` in each taken cell, reconstructed from the draft's shape rather than from stored picks.

One consequence worth knowing: because the picks are not recorded, the cards they took are indistinguishable from cards nobody took. Availability queries (`/api/drafts/<id>/available` and its ranked variant) will list those cards as still in the pool.

**Operational hazard:** `.opt-outs.json` is gitignored and never deployed, and `privacy_opt_outs` is the only thing the ingest filter consults. `pnpm draft:reset` clears that table, so running `pnpm draft:reset` followed by `pnpm sync` from a machine that does not have `.opt-outs.json` re-ingests the opted-out player's picks unredacted, with no read-time mask left to catch it. Confirm `.opt-outs.json` is present before re-syncing a draft that had opt-outs.

## Tech Stack

- Next.js + React + TypeScript
- Zustand (client-side state management)
- Turso (SQLite) database
- TanStack Table
- Scryfall API
- Vercel Analytics
