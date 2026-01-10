# Draft Selection Design

Allow web app users to select which drafts contribute to card rankings.

## Problem

Currently, all drafts are included in stats calculations. Users may want to:
- Focus on recent drafts only
- Exclude outlier drafts
- See how rankings evolved over time

## Scope

**In scope:**
- Multi-select checkboxes for draft selection in Settings panel
- Recalculate pick score and sparkline based on selected drafts
- Card list filtered to latest selected draft's pool
- Lazy-load draft data only when selection changes

**Out of scope:**
- Persisting draft selection across sessions
- CLI tool changes
- Date range picker or timeline UI

## Architecture

### Data Flow

```
BUILD TIME (unchanged for default case):
[CSV files] → parse → calculate stats → enrich with Scryfall → [static props]

BUILD TIME (new):
[CSV files] → parse → [/public/api/draft-data.json]

RUNTIME (when user changes draft selection):
[fetch draft-data.json] → filter picks by selected drafts
→ recalculate stats → determine cube from latest selected draft
→ re-render table
```

The default experience (all drafts selected) works exactly as today. Draft selection is a progressive enhancement that loads additional data only when used.

### Payload Size

Current (7 drafts):
- Picks: ~682 KB uncompressed, ~170 KB gzipped
- Pools: ~103 KB uncompressed, ~26 KB gzipped
- Total: ~200 KB gzipped

Projected (50 drafts): ~1.4 MB gzipped

## Data Structures

### Static File `/public/api/draft-data.json`

```typescript
type DraftDataFile = {
  picks: CardPick[];
  pools: Record<string, string[]>;  // draftId → card names
  metadata: Record<string, {
    name: string;
    date: string;
  }>;
}
```

### New Props for PageClient

```typescript
// Existing (unchanged)
initialCards: EnrichedCardStats[];
initialPlayers: string[];
draftCount: number;
currentCubeCopies: Record<string, number>;

// New
draftIds: string[];
draftMetadata: Record<string, { name: string; date: string }>;
scryfallData: Record<string, ScryCard>;
```

### Client State

```typescript
const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(allDraftIds);
const [draftData, setDraftData] = useState<DraftDataFile | null>(null);
const [isLoadingDraftData, setIsLoadingDraftData] = useState(false);
```

## UI Design

### Header

Gear icon in top-right opens Settings modal:

```
┌────────────────────────────────────────────────────────┐
│ Read the Bones                                    ⚙️   │
│ samp cube roto draft analysis                          │
│ 450 cards from 7 drafts                                │
└────────────────────────────────────────────────────────┘
```

### Settings Modal

```
┌─ Settings ─────────────────────────────────────┐
│                                                │
│ Drafts                                         │
│ ┌────────────────────────────────────────────┐ │
│ │ ☑ 2025-12-15: Winter Cube                  │ │
│ │ ☑ 2025-09-20: Fall Draft                   │ │
│ │ ☑ 2025-06-10: Summer Cube                  │ │
│ │ ☑ 2025-03-15: Spring Draft                 │ │
│ └────────────────────────────────────────────┘ │
│ [Select All] [Select None]                     │
│                                                │
│ Top Players                                    │
│ (existing multi-select dropdown)               │
│                                                │
│ ☐ Weight top player picks more heavily         │
└────────────────────────────────────────────────┘
```

Draft list:
- Sorted by date descending (most recent first)
- Format: "YYYY-MM-DD: Draft Name"
- All checked by default
- Select All / Select None buttons

### Loading State

- Spinner overlay on table during fetch/recalculation
- Subsequent changes use cached data (instant)

### Empty State

When no drafts selected: "No drafts selected" message, empty table.

## Client-Side Flow

```typescript
async function handleDraftSelectionChange(newSelection: Set<string>) {
  setSelectedDrafts(newSelection);

  // Empty selection → show empty state
  if (newSelection.size === 0) {
    setDisplayedCards([]);
    return;
  }

  // All drafts selected → use precomputed data
  if (newSelection.size === allDraftIds.length) {
    setDisplayedCards(initialCards);
    return;
  }

  // Custom selection → need draft data
  let data = draftData;
  if (!data) {
    setIsLoadingDraftData(true);
    data = await fetch('/api/draft-data.json').then(r => r.json());
    setDraftData(data);
    setIsLoadingDraftData(false);
  }

  // Filter picks to selected drafts
  const filteredPicks = data.picks.filter(p => newSelection.has(p.draftId));

  // Recalculate stats
  const stats = calculateCardStats(filteredPicks, topPlayers, data.metadata);

  // Determine latest selected draft's pool
  const latestDraftId = getLatestDraft(newSelection, data.metadata);
  const cubeCards = new Set(data.pools[latestDraftId]);

  // Filter and enrich
  const enriched = stats
    .filter(s => cubeCards.has(s.cardName))
    .map(s => ({ ...s, scryfall: scryfallData[s.cardName] }));

  setDisplayedCards(enriched);
}
```

Performance: `calculateCardStats` on ~5,000 picks takes <50ms. No web worker needed.

## Recalculation Details

**Recalculated when draft selection changes:**
- Pick score (weightedGeomean / topPlayerGeomean)
- Sparkline (scoreHistory) - only shows selected drafts
- Card list - filtered to latest selected draft's pool
- Header text - "X cards from Y drafts"

**Unchanged:**
- Scryfall data (images, mana cost, type)
- Top player selection and weighting toggle

**Latest selected draft logic:**
- Sort selected drafts by date descending
- First one determines which pool defines the card list

## File Changes

### Modify

| File | Changes |
|------|---------|
| `src/core/dataLoader.ts` | Add function to generate draft-data.json content |
| `src/app/page.tsx` | Pass new props (draftIds, draftMetadata, scryfallData) |
| `src/app/components/PageClient.tsx` | Add draft selection state, fetch logic, recalculation |
| `src/app/components/PlayerSettings.tsx` | Rename to `Settings.tsx`, add draft selector section |

### Create

| File | Purpose |
|------|---------|
| `src/app/components/DraftSelector.tsx` | Checkbox list with select all/none buttons |
| `scripts/generate-draft-data.ts` | Build script to output draft-data.json |

### Build Process

Add to `package.json`:
```json
"prebuild": "tsx scripts/generate-draft-data.ts"
```

## Behavior Summary

| Scenario | Behavior |
|----------|----------|
| Page load | All drafts selected, precomputed stats (no extra fetch) |
| First selection change | Fetch draft-data.json (~200KB), cache it |
| Subsequent changes | Use cached data, recalculate instantly |
| All drafts re-selected | Switch back to precomputed stats |
| No drafts selected | Empty state message |
