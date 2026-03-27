# Stats Module Split Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 814-line stats.ts into 3 focused modules organized in a stats/ directory.

**Architecture:** Move one query family at a time into its own file under stats/, creating a barrel index.ts that re-exports everything. Existing imports continue to work unchanged.

**Tech Stack:** TypeScript, Turso/libsql, Vitest

---

## Current State

### Source file

`src/core/db/queries/stats.ts` (814 lines) contains 3 query families:

| Family | Lines | Function | Types |
|--------|-------|----------|-------|
| Pick Stats | 17-262 | `getCardPickStats` | `GetCardPickStatsParams`, `CardPickStatsResult` |
| Card Stats | 269-444 | `getCardStats` | `GetCardStatsParams`, `CardStatsResult` |
| Ranked Available | 450-814 | `rankAvailableCards` | `RankAvailableCardsParams`, `RankedCard`, `RankAvailableCardsResult` |

Shared constant: `MIN_SAMPLE_SIZE = 5` (used by cardStats and rankedAvailable)

### Imports used by stats.ts

```typescript
import { getClient } from "../client";
import { getSeatsMatchingColors, parseScryfallJson } from "./helpers";
import { resolveCard } from "./cards";
import { getAvailableCards } from "./picks";
import { getCardPlayStats, getCardWinStats } from "./decklists";
import { calculatePickWeight, round3, weightedGeometricMean } from "../../utils";
import { wilsonInterval } from "../../wilsonInterval";
import { DEFAULT_POOL_SIZE } from "../../types";
```

Per-module import needs:

| Module | Imports from stats.ts deps |
|--------|---------------------------|
| **pickStats** | `getClient`, `resolveCard`, `calculatePickWeight`, `round3`, `weightedGeometricMean`, `DEFAULT_POOL_SIZE` |
| **cardStats** | `resolveCard`, `parseScryfallJson`, `getCardPlayStats`, `getCardWinStats`, `wilsonInterval` + **pickStats** (`getCardPickStats`, `CardPickStatsResult`) |
| **rankedAvailable** | `getClient`, `getAvailableCards`, `getSeatsMatchingColors`, `calculatePickWeight`, `round3`, `weightedGeometricMean`, `wilsonInterval`, `DEFAULT_POOL_SIZE` |

### Consumers

All external consumers import via the queries barrel:

- `src/core/db/queries/index.ts` line 7: `export * from "./stats";`
- `src/app/api/cards/stats/route.ts`: `queries.getCardStats`
- `src/app/api/drafts/[id]/available/ranked/route.ts`: `queries.rankAvailableCards`
- `src/core/db/queries.test.ts` lines 25-27: `getCardPickStats`, `rankAvailableCards` imported from `"./queries"`

### Test file

`src/core/db/queries.test.ts` (1850 lines) contains:

- `describe("getCardPickStats")` at lines 1111-1347 (8 test cases)
- `describe("rankAvailableCards")` at lines 1521-1849 (7 test cases)
- No direct tests for `getCardStats` in this file (tested via API route test at `src/app/api/cards/stats/route.test.ts`)

Tests import from `"./queries"` (the barrel), so they will continue to work as long as the barrel re-exports correctly.

---

## Task 1: Create stats/ directory and move pickStats

**Files:**
- Create: `src/core/db/queries/stats/pickStats.ts`
- Create: `src/core/db/queries/stats/index.ts`
- Edit: `src/core/db/queries/index.ts` (update barrel)

- [ ] **Step 1: Create `src/core/db/queries/stats/pickStats.ts`**

```typescript
/**
 * Pick statistics query — aggregates pick data for a single card across drafts.
 */

import { getClient } from "../../client";
import { resolveCard } from "../cards";
import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";
import { DEFAULT_POOL_SIZE } from "../../../types";

export interface GetCardPickStatsParams {
  card_name: string;
  card_id?: number;
  date_from?: string;
  date_to?: string;
  draft_name?: string;
}

export interface CardPickStatsResult {
  card_name: string;
  drafts_seen: number;
  times_picked: number;
  avg_pick_n: number;
  median_pick_n: number;
  weighted_geomean: number;
  // Play rate fields — present when decklist data exists for this card
  play_rate?: number;
  times_maindecked?: number;
  times_in_pool_with_decklist?: number;
}

/**
 * Get aggregate pick statistics for a card across drafts.
 * Uses the weighted geometric mean formula from calculateStats.ts.
 */
export async function getCardPickStats(
  params: GetCardPickStatsParams
): Promise<CardPickStatsResult | null> {
  // ... (lines 45-262 from stats.ts, unchanged)
}
```

Copy the full function body from lines 45-261 of the current `stats.ts`. No logic changes.

- [ ] **Step 2: Create `src/core/db/queries/stats/index.ts`**

```typescript
export * from "./pickStats";
```

- [ ] **Step 3: Update `src/core/db/queries/index.ts`**

Change line 7 from:

```typescript
export * from "./stats";
```

to:

```typescript
export * from "./stats/index";
```

- [ ] **Step 4: Verify — typecheck + test**

```bash
pnpm typecheck
pnpm test -- src/core/db/queries.test.ts
```

The old `stats.ts` still exists and still exports `getCardStats` and `rankAvailableCards`. The barrel now re-exports from `stats/index.ts` which re-exports `pickStats`. At this point both old and new code coexist -- this is intentional to avoid a broken intermediate state.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/stats/pickStats.ts src/core/db/queries/stats/index.ts src/core/db/queries/index.ts
git commit -m "Extract pickStats into stats/ directory (step 1 of stats module split)"
```

---

## Task 2: Move cardStats (depends on pickStats)

**Files:**
- Create: `src/core/db/queries/stats/cardStats.ts`
- Edit: `src/core/db/queries/stats/index.ts`

- [ ] **Step 1: Create `src/core/db/queries/stats/cardStats.ts`**

```typescript
/**
 * Combined card statistics query — Scryfall data, pick stats, play rate, and win rate.
 */

import { parseScryfallJson } from "../helpers";
import { resolveCard } from "../cards";
import { getCardPlayStats, getCardWinStats } from "../decklists";
import { wilsonInterval } from "../../../wilsonInterval";
import { getCardPickStats } from "./pickStats";

/** Minimum number of match results needed for confident win rate statistics. */
const MIN_SAMPLE_SIZE = 5;

/** @public Used by API routes */
export interface GetCardStatsParams {
  card_name: string;
  draft_id?: string;
  date_from?: string;
  date_to?: string;
  draft_name?: string;
  deck_colors?: string;
}

export interface CardStatsResult {
  card_name: string;
  // Scryfall data
  oracle_text: string | null;
  type_line: string | null;
  mana_cost: string | null;
  color_identity: string[];
  // Pick equity
  pick: {
    drafts_in_pool: number;
    times_picked: number;
    avg_pick: number;
    median_pick: number;
    geomean_pick: number;
  };
  // Play rate (null when no decklist data)
  play: {
    pools_with_decklist: number;
    times_maindecked: number;
    play_rate: number;
    filtered: boolean;
  } | null;
  // Win rate (null when no win data)
  wins: {
    seats_maindecked: number;
    game_wins: number;
    game_losses: number;
    win_rate: number;
    win_rate_ci: { lower: number; center: number; upper: number };
    low_sample: boolean;
    drafts_with_data: number;
    filtered: boolean;
  } | null;
}

/**
 * Get comprehensive stats for a card: Scryfall data, pick stats, play rate, and win rate.
 * Combines lookupCard, getCardPickStats, and getCardWinStats into a single call.
 * @public Used by API routes
 */
export async function getCardStats(
  params: GetCardStatsParams
): Promise<CardStatsResult | null> {
  // ... (lines 321-444 from stats.ts, unchanged)
}
```

Copy the full function body from lines 321-443 of the current `stats.ts`. No logic changes. Note: `MIN_SAMPLE_SIZE` is duplicated here (also needed in rankedAvailable). This is intentional -- it's a small constant and co-locating it with the code that uses it is clearer than sharing it.

- [ ] **Step 2: Update `src/core/db/queries/stats/index.ts`**

```typescript
export * from "./pickStats";
export * from "./cardStats";
```

- [ ] **Step 3: Verify — typecheck + test**

```bash
pnpm typecheck
pnpm test -- src/core/db/queries.test.ts src/app/api/cards/stats/route.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/core/db/queries/stats/cardStats.ts src/core/db/queries/stats/index.ts
git commit -m "Extract cardStats into stats/ directory (step 2 of stats module split)"
```

---

## Task 3: Move rankedAvailable

**Files:**
- Create: `src/core/db/queries/stats/rankedAvailable.ts`
- Edit: `src/core/db/queries/stats/index.ts`

- [ ] **Step 1: Create `src/core/db/queries/stats/rankedAvailable.ts`**

```typescript
/**
 * Ranked available cards query — bulk-ranks available cards by historical performance.
 */

import { getClient } from "../../client";
import { getSeatsMatchingColors } from "../helpers";
import { getAvailableCards } from "../picks";
import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";
import { wilsonInterval } from "../../../wilsonInterval";
import { DEFAULT_POOL_SIZE } from "../../../types";

/** Minimum number of match results needed for confident win rate statistics. */
const MIN_SAMPLE_SIZE = 5;

export interface RankAvailableCardsParams {
  draft_id: string;
  before_pick_n: number;
  color?: string;
  type_contains?: string;
  deck_colors?: string;
  limit?: number;
  sort_by?: "geomean_pick" | "win_rate" | "play_rate";
}

/**
 * Flat shape for ranked card output (vs CardStatsResult which nests filtered inside play/wins).
 * play_rate_filtered / win_rate_filtered correspond to CardStatsResult's play.filtered / wins.filtered.
 */
export interface RankedCard {
  card_name: string;
  geomean_pick: number;
  drafts_in_pool: number;
  times_picked: number;
  play_rate: number | null;
  play_rate_filtered: boolean;
  win_rate: number | null;
  win_rate_ci: { lower: number; center: number; upper: number } | null;
  low_sample: boolean;
  win_rate_filtered: boolean;
}

export interface RankAvailableCardsResult {
  draft_id: string;
  before_pick_n: number;
  total_available: number;
  cards: RankedCard[];
}

/**
 * Get available cards before a pick, ranked by historical performance.
 * Combines getAvailableCards + batch pick/play/win stats in one efficient call.
 */
export async function rankAvailableCards(
  params: RankAvailableCardsParams
): Promise<RankAvailableCardsResult> {
  // ... (lines 491-814 from stats.ts, unchanged)
}
```

Copy the full function body from lines 491-813 of the current `stats.ts`. No logic changes.

- [ ] **Step 2: Update `src/core/db/queries/stats/index.ts`**

```typescript
export * from "./pickStats";
export * from "./cardStats";
export * from "./rankedAvailable";
```

- [ ] **Step 3: Verify — typecheck + test**

```bash
pnpm typecheck
pnpm test -- src/core/db/queries.test.ts src/app/api/drafts/\[id\]/available/ranked/route.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/core/db/queries/stats/rankedAvailable.ts src/core/db/queries/stats/index.ts
git commit -m "Extract rankedAvailable into stats/ directory (step 3 of stats module split)"
```

---

## Task 4: Remove original stats.ts and verify

**Files:**
- Delete: `src/core/db/queries/stats.ts`
- Verify: `src/core/db/queries/index.ts` (already updated in Task 1)

- [ ] **Step 1: Delete the original stats.ts**

```bash
rm src/core/db/queries/stats.ts
```

At this point `src/core/db/queries/index.ts` already points to `./stats/index` (updated in Task 1 Step 3), which re-exports all three modules. No barrel changes needed.

- [ ] **Step 2: Verify — full check**

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm knip
```

All four must pass. If knip reports unused exports, check that the barrel chain is correct:

```
src/core/db/queries/stats/pickStats.ts
  -> re-exported by src/core/db/queries/stats/index.ts
  -> re-exported by src/core/db/queries/index.ts
  -> consumed by API routes and tests
```

- [ ] **Step 3: Commit**

```bash
git rm src/core/db/queries/stats.ts
git add -A src/core/db/queries/stats/
git commit -m "Remove original stats.ts — module split complete

All three query families now live in focused modules under stats/:
- pickStats.ts (getCardPickStats)
- cardStats.ts (getCardStats)
- rankedAvailable.ts (rankAvailableCards)"
```

---

## Final File Structure

```
src/core/db/queries/
  stats/
    index.ts            # barrel: re-exports all three modules
    pickStats.ts        # getCardPickStats + GetCardPickStatsParams + CardPickStatsResult
    cardStats.ts        # getCardStats + GetCardStatsParams + CardStatsResult
    rankedAvailable.ts  # rankAvailableCards + RankAvailableCardsParams + RankedCard + RankAvailableCardsResult
  index.ts              # top-level barrel (line 7: export * from "./stats/index")
  ...other query modules unchanged...
```

## Import Resolution

No consumer code changes needed. All existing imports resolve through the barrel chain:

```
import { getCardStats } from "@/core/db/queries"
  -> src/core/db/queries/index.ts: export * from "./stats/index"
  -> src/core/db/queries/stats/index.ts: export * from "./cardStats"
  -> src/core/db/queries/stats/cardStats.ts: export async function getCardStats(...)
```

## Notes

- `MIN_SAMPLE_SIZE` is duplicated in `cardStats.ts` and `rankedAvailable.ts`. This is a conscious choice: it's a 1-line constant, and extracting it into a shared module would add coupling for no real benefit. If it ever diverges between the two use sites, that's a feature, not a bug.
- The test file (`src/core/db/queries.test.ts`) does not need changes. It imports from `"./queries"` which resolves to the top-level barrel. The barrel chain handles the rest.
- No new tests are needed. The existing tests cover the exact same functions with the exact same signatures.
