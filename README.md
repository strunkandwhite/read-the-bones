# Read the Bones

Analytics tool for Magic: the Gathering rotisserie drafts. Aggregates pick data across multiple drafts to produce crowd-sourced card rankings.

## What It Does

- Parses draft CSV files exported from Excel/Google Sheets
- Calculates card rankings using weighted geometric mean of pick position
- Displays results in a filterable, sortable web table
- Enriches cards with images and metadata from Scryfall

## Features

- **Scryfall-style search:** `t:creature`, `o:flying`, `c:r`, `cmc<=2`, quoted phrases
- **Color filtering:** Filter by W/U/B/R/G/C (inclusive matching)
- **Multiple copy handling:** First copy weighted more than subsequent copies
- **Unpicked card tracking:** Cards available but not drafted are penalized appropriately
- **Draft selection:** Compare stats across different draft subsets
- **LLM chat:** Ask natural language questions about draft history

## Setup

```bash
pnpm install
pnpm dev
```

## Development

```bash
pnpm test        # Run tests
pnpm build       # Build static site
```

## Adding Draft Data

1. Create a folder in `data/` for each draft
2. Export the draft picks sheet as `picks.csv`
3. Export the card pool as `pool.csv`
4. Add `metadata.json` with draft name, date, and sheet ID
5. Run `pnpm ingest` to load into the database
6. Run `pnpm dev` or `pnpm build`

## Player Privacy

Players are identified only by seat number within each draft. There is no cross-draft player identity.

### Opting Out of LLM Queries

Players can opt out of having their picks and match results included in LLM chat responses. Create a `.opt-outs.json` file in the project root:

```json
{
  "names": ["Player Name", "Another Player"]
}
```

Names are matched case-insensitively against CSV column headers. When you run `pnpm ingest`, opted-out players are recorded in the database. Their data is then redacted from LLM tool responses (seat numbers show as `[REDACTED]`), though their picks still affect game state calculations (e.g., available cards).

## Tech Stack

- Next.js + React + TypeScript
- Turso (SQLite) database
- TanStack Table
- Scryfall API

