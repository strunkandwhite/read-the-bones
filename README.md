# Read the Bones

Analytics tool for Magic: the Gathering rotisserie drafts. Aggregates pick data across multiple drafts to produce crowd-sourced card rankings.

## What It Does

- Parses draft CSV files exported from Excel/Google Sheets
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

1. Create a folder in `data/` for each draft
2. Export the draft picks sheet as `picks.csv`
3. Export the card pool as `pool.csv`
4. Optionally export match results as `matches.csv`
5. Add `metadata.json` with draft name, date, and optional sheet ID
6. Run `pnpm ingest` to load into the database
7. Run `pnpm dev` or `pnpm build`

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
| `/api/cards/stats` | Card statistics across drafts |
| `/api/stats` | Overall draft statistics |

## Player Privacy

Players are identified only by seat number within each draft. There is no cross-draft player identity.

### Opting Out of Queries

Players can opt out of having their picks and match results included in API query responses. Create a `.opt-outs.json` file in the project root:

```json
["Player Name", "Another Player"]
```

Names are matched case-insensitively against CSV column headers. When you run `pnpm ingest`, opted-out players are recorded in the database. Their data is then redacted from query responses (seat numbers show as `[REDACTED]`), though their picks still affect game state calculations (e.g., available cards).

## Tech Stack

- Next.js + React + TypeScript
- Turso (SQLite) database
- TanStack Table
- Scryfall API
- Vercel Analytics
