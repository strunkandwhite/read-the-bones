# Card Rankings Design

A web app for tracking and displaying MTG rotisserie draft card rankings.

## Problem

Rotisserie drafts generate valuable data about card evaluation, but it lives scattered across Excel sheets. This tool aggregates pick data across multiple drafts to produce crowd-sourced card rankings.

## Scope

**In scope:**
- Parse draft CSV files to extract pick position data
- Calculate card rankings using weighted geometric mean
- Display results in a filterable, sortable web table
- Enrich cards with Scryfall images and metadata

**Out of scope:**
- Upload UI for draft files (manual folder management)

**Later added:**
- Win equity / match data analysis (optional columns, toggled via Settings)

## Data Model

### Input Structure

```
data/
  draft-1/
    picks.csv       # draft picks (drafter columns, pick rows)
    pool.csv        # all cards available in this cube
  draft-2/
    picks.csv
    pool.csv
```

### Core Types

```typescript
type CardPick = {
  cardName: string       // normalized (numeric suffix stripped)
  pickPosition: number   // 1-N, or poolSize if unpicked
  copyNumber: number     // 1st, 2nd, etc. copy in this draft
  wasPicked: boolean     // false if assigned pool-size position
  draftId: string
  drafterName: string
  color: string
}

type CardStats = {
  cardName: string
  weightedGeomean: number
  topPlayerGeomean: number   // when toggle enabled
  totalPicks: number
  timesAvailable: number
  timesUnpicked: number
  maxCopiesInDraft: number   // for annotation
  colors: string[]
}

type PlayerConfig = {
  knownPlayers: string[]     // all unique player names
  topPlayers: string[]       // user-selected, persisted
}

type ScryCard = {
  name: string
  imageUri: string
  manaCost: string
  typeLine: string
  colors: string[]
  colorIdentity: string[]
}
```

## Ranking Algorithm

### Weighted Geometric Mean

For each card, across all drafts where it was available:

1. Collect all pick positions with weights:
   ```
   weight = copyWeight × unpickedWeight × topPlayerMultiplier

   where:
     copyWeight = 0.5^(copyNumber - 1)    # 1st=1, 2nd=0.5, 3rd=0.25
     unpickedWeight = 0.5 if not picked, else 1
     topPlayerMultiplier = 2 if drafter is top player AND toggle on, else 1
   ```

2. Compute weighted geometric mean:
   ```
   geomean = exp(Σ(weight × ln(pickPosition)) / Σ(weight))
   ```

### Rationale

- **Copy weighting:** Multiple copies reduce urgency; first pick best captures true demand
- **Unpicked weighting:** 50% because unpicked cards may be archetype-specific, not universally bad
- **Top player weighting:** Better drafters' picks are more informative signals

### Example

- Draft A: Picked 5th (1st copy, top player) → weight = 1 × 1 × 2 = 2
- Draft B: Picked 12th (1st copy, regular player) → weight = 1 × 1 × 1 = 1
- Draft C: Unpicked, pool size 450 → weight = 1 × 0.5 × 1 = 0.5

```
geomean = exp((2×ln(5) + 1×ln(12) + 0.5×ln(450)) / 3.5)
        ≈ 12.2
```

Lower score = picked earlier = "better" card.

## Web App UI

### Main View

Single-page app with a data table.

**Table columns:**
| Column | Description |
|--------|-------------|
| Card | Image thumbnail + name (hover for full card) |
| Mana Cost | From Scryfall |
| Type | Creature, Instant, etc. |
| Colors | Color identity pills (W/U/B/R/G/C) |
| Pick Score | Weighted geomean (lower = better) |
| Times Picked | X of Y available drafts |
| Notes | "2+ copies in some drafts" annotation if applicable |

**Controls:**
- Color filter: Toggles for W/U/B/R/G/C (inclusive matching)
- Top players toggle: Switch between all players / top players weighted
- Sort: Click column headers (default: Pick Score ascending)
- Search: Text filter for card name

**Top player configuration:**
- Multi-select dropdown of all known players
- Selection persisted to localStorage
- Accessible via Settings button

**Card interaction:**
- Hover: Show full Scryfall card image
- Click: Could show per-draft breakdown (stretch goal)

## Scryfall Integration

**API:** `/cards/named` endpoint for exact name lookup

**Rate limiting:** 50-100ms delay between requests

**Caching:**
- Cache responses to `cache/scryfall.json`
- On build: load cache, fetch only missing cards
- Store: name, image URI, mana cost, type line, colors

**Handling misses:**
- Display card name without image, flag for review
- Future: manual override mapping (`card-aliases.json`)

## Architecture

### Build-time Static Generation

- CSV parsing and Scryfall fetching at build time
- No runtime server needed
- Rebuild when new draft data added

### Data Flow

```
[CSV files]
    ↓ parse
[CardPick[]]
    ↓ aggregate + calculate geomean
[CardStats[]]
    ↓ enrich with Scryfall
[EnrichedCardStats[]]
    ↓ Next.js static props
[React table component]
```

### File Structure

```
read-the-bones/
  data/
    draft-1/
      picks.csv
      pool.csv
    draft-2/
      ...
  cache/
    scryfall.json
  config/
    players.json          # default top player selections
  src/
    core/                 # shared, no framework dependencies
      parseCsv.ts
      calculateStats.ts
      scryfall.ts
      types.ts
    app/                  # Next.js web app
      page.tsx
      components/
        CardTable.tsx
        ColorFilter.tsx
        PlayerSettings.tsx
```

### Why This Structure

The `core/` module is framework-agnostic and can be imported by other tools that need access to the same parsing and calculation logic.

## Tech Stack

- **Framework:** Next.js (static site generation)
- **Language:** TypeScript
- **Table:** TanStack Table
- **Card data:** Scryfall API
- **Persistence:** localStorage for player config

## Data Handling Notes

### Card Name Normalization

Strip numeric suffixes: "Scalding Tarn 2" → "Scalding Tarn"

Regex: `/\s*\d+$/`

### Player Name Deduplication

Collect all unique player names across drafts. Flag potential duplicates (typos, name variations) for manual resolution.

### Color Filtering

Inclusive matching: filtering "Red" shows all cards containing red, including multicolor (BR, UR, etc.).
