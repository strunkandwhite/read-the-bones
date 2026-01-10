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
- **Top player weighting:** Give 2x weight to picks from selected top players
- **Multiple copy handling:** First copy weighted more than subsequent copies
- **Unpicked card tracking:** Cards available but not drafted are penalized appropriately
- **Draft selection:** Compare stats across different draft subsets

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
4. Rebuild the site

## Tech Stack

- Next.js + React + TypeScript
- TanStack Table
- Scryfall API
