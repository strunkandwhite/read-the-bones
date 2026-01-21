# New Statistics Design

Add two new statistics to help drafters understand card value beyond average pick position.

## New Stats

| Stat | Purpose | Display |
|------|---------|---------|
| Pick distribution | Show the shape of where a card gets picked | Mini histogram in table row |
| Pick/win equity | Probability-weighted contribution to match wins | Numeric column (when match data available) |

## Non-Goals for v1

- Color-aware deck probability modeling
- Per-game card presence tracking
- Maindeck vs sideboard distinction

## Data Format

### matches.csv

Existing format from round robin tournament exports. Parser reads columns B-H:

- B: Player1 name
- C: Player1 games won
- D: "VS" (literal)
- E: Player2 games won
- F: Player2 name
- G: Player1 match win (1/0)
- H: Player2 match win (1/0)

Skip header rows 1-3. Ignore aggregated standings in columns J+.

Player names must match drafter names in `picks.csv`. Fix mismatches in the data files directly rather than building normalization logic.

## Pick/Win Equity Algorithm

### Step 1: Calculate play probability per card

```
For each card in a player's draft pool:
  if card is a land:
    playProbability = 1.0
  else:
    playProbability = positionDecay(pickPosition)

positionDecay(pos):
  if pos <= 15:  return 0.95
  if pos <= 23:  return 0.80
  if pos <= 30:  return 0.40
  else:          return 0.10
```

### Step 2: Calculate equity per card per draft

```
For each card C in player P's pool:
  weight = playProbability(C)
  totalWeight = sum of playProbability for all cards in P's pool

  cardEquity = (weight / totalWeight) * P.gamesWon
  cardLosses = (weight / totalWeight) * P.gamesLost
```

### Step 3: Aggregate across drafts

```
For each card:
  totalEquity = sum of cardEquity across all drafts
  totalLosses = sum of cardLosses across all drafts
  equityWinRate = totalEquity / (totalEquity + totalLosses)
```

## Pick Distribution Histogram

### Bucketing

```
Bucket 1: Picks 1-10   (early)
Bucket 2: Picks 11-20  (mid-early)
Bucket 3: Picks 21-30  (mid)
Bucket 4: Picks 31-40  (mid-late)
Bucket 5: Picks 41+    (late/unpicked)
```

### Display

5 thin vertical bars, height proportional to count in each bucket. Similar visual style to existing Sparkline component.

Example patterns:
- Bomb: tall first bar only
- Staple: bell curve in middle buckets
- Build-around: bimodal, bars on both ends

## UI Integration

### New table columns

| Column | Type | Sortable | Notes |
|--------|------|----------|-------|
| Distribution | Mini histogram | No | 5-bar visual, ~60px wide |
| Win Equity | Percentage | Yes | Shows "—" if no match data |

Column placement: After existing stats columns (Picks, Available, etc.), before the sparkline.

### Sorting

Win equity sorts by raw value. Cards with no match data sort to bottom.

### Hover behavior

- Distribution histogram: Tooltip showing exact counts per bucket
- Win equity: Tooltip showing wins/losses attributed

### Empty state

If zero drafts have matches.csv, hide the Win Equity column entirely.

## Implementation

### New types in src/core/types.ts

```ts
// Add to CardStats
pickDistribution: number[];  // 5 buckets
winEquity?: {
  wins: number;
  losses: number;
  winRate: number;
};
```

### New files

- `src/core/parseMatches.ts` - Parse matches.csv format
- `src/core/parseMatches.test.ts` - Tests
- `src/core/winEquity.ts` - Equity calculation
- `src/core/winEquity.test.ts` - Tests
- `src/app/components/DistributionHistogram.tsx` - Mini histogram component

### Modified files

- `src/core/calculateStats.ts` - Add pickDistribution calculation
- `src/core/dataLoader.ts` - Load matches.csv files
- `src/core/types.ts` - New fields
- `src/app/components/CardTable.tsx` - New columns
