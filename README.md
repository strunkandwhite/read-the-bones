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
- **Deck builder:** Drag-and-drop deck building with maindeck/sideboard zones and shareable deck snapshots
- **Seat selection:** View individual drafter picks, available cards, and decklists by seat
- **Win rate analysis:** Multiple win metrics including game-percent win rate, win equity, and decklist-based win rates
- **Live drafts:** Run rotisserie drafts in-app with snake order, pick queues, auto-pick cascades, and match reporting

## Setup

```bash
pnpm install
pnpm dev
```

Requires a Turso database. Set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env.local`, then run `pnpm db:migrate` to create tables.

## Development

```bash
pnpm test        # Run tests
pnpm build       # Build for production (dynamic SSR)
pnpm precommit   # Run all checks: typecheck, lint, knip, tests
```

## Adding Draft Data

1. Create a draft: `pnpm draft:create --name "Draft Name" --date 2026-01-15 --sheet-id <google-sheet-id>`
2. Sync data: `pnpm sync` (fetches picks and matches from Google Sheets into Turso)
3. Optionally add decklists: add sealeddeck.tech URLs to `data/decklists.txt`, then run `pnpm decklists`

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
| `/api/drafts/[id]/pool` | Full draft pool (groupable by color or type) |
| `/api/drafts/[id]/deck` | Decklist for a specific seat |
| `/api/cards/search` | Scryfall-style card search (`q` required) |
| `/api/cards/stats` | Card statistics across drafts |
| `/api/stats` | Overall draft statistics |
| `/api/decks/winning` | Top winning decks by color archetype (`color_pair` required) |

### Live Draft Routes

These routes support in-app rotisserie drafting. Most require a seat token via `X-Seat-Token` header.

| Route | Method | Description |
|-------|--------|-------------|
| `/api/drafts/[id]/status` | GET | Draft state, next seat, recent picks |
| `/api/drafts/[id]/me` | GET | Resolve seat from token |
| `/api/drafts/[id]/pick` | POST | Submit a pick |
| `/api/drafts/[id]/queue` | GET/PUT | Manage pick queue |
| `/api/drafts/[id]/board` | GET | Full pick matrix data |
| `/api/drafts/[id]/match` | POST | Report a match result |
| `/api/drafts/[id]/seat-settings` | PUT | Update auto-pick, display name |

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
- Turso (SQLite) database
- TanStack Table
- Scryfall API
- Vercel Analytics
