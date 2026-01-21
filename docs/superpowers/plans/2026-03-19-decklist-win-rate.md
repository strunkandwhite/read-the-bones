# Decklist Win Rate Column Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a localhost-only "Deck WR" column to the card table showing actual win rates from decklist + match data.

**Architecture:** Build-time SQL query computes per-card win stats from `deck_cards` and `match_events` tables. Result stored as optional `decklistWinRate` field on `CardStats`. A `useIsLocalhost` hook gates column visibility client-side.

**Tech Stack:** TypeScript, Vitest, React (Next.js), TanStack Table, Turso (libSQL)

**Spec:** `docs/superpowers/specs/2026-03-19-decklist-win-rate-column-design.md`

---

## Chunk 1: Data Layer

### Task 1: Add `decklistWinRate` type to `CardStats`

**Files:**
- Modify: `src/core/types.ts:72-121`

- [ ] **Step 1: Add the type**

Add after `rawWinRate` (line 120), before the closing `}`:

```typescript
  /**
   * Win rate from actual decklist data.
   * Based on match results of seats that maindecked this card.
   * Only available for cards with decklist + match data.
   */
  decklistWinRate?: {
    /** Win rate: gameWins / (gameWins + gameLosses) */
    winRate: number;
    /** Total games won by seats that maindecked this card */
    gameWins: number;
    /** Total games lost by seats that maindecked this card */
    gameLosses: number;
    /** Number of distinct (draft, seat) pairs that maindecked this card */
    timesMaindecked: number;
    /** Number of distinct drafts where this card was maindecked */
    draftsWithData: number;
  };
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors (the field is optional, so no existing code breaks)

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "Add decklistWinRate type to CardStats"
```

### Task 2: Build-time bulk query for decklist win stats

**Files:**
- Modify: `src/build/tursoDataLoader.ts:299-392`

- [ ] **Step 1: Add the bulk query after match data loading (after line 338)**

Insert after the match stats aggregation block, before "7. Load current cube cards":

```typescript
  // 6b. Load decklist win stats (bulk query across all cards)
  const decklistWinResult = await client.execute({
    sql: `SELECT c.name as card_name,
                 COUNT(DISTINCT dc.draft_id || '-' || dc.seat) as times_maindecked,
                 COUNT(DISTINCT dc.draft_id) as drafts_with_data,
                 SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                          WHEN me.seat2 = dc.seat THEN me.seat2_wins
                          ELSE 0 END) as game_wins,
                 SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                          WHEN me.seat2 = dc.seat THEN me.seat1_wins
                          ELSE 0 END) as game_losses
          FROM deck_cards dc
          JOIN cards c ON dc.card_id = c.card_id
          JOIN match_events me ON me.draft_id = dc.draft_id
               AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
          WHERE dc.zone = 'deck'
          GROUP BY c.name`,
    args: [],
  });

  const decklistWinRates = new Map<string, {
    winRate: number;
    gameWins: number;
    gameLosses: number;
    timesMaindecked: number;
    draftsWithData: number;
  }>();

  for (const row of decklistWinResult.rows) {
    const cardName = row.card_name as string;
    const gameWins = row.game_wins as number;
    const gameLosses = row.game_losses as number;
    const total = gameWins + gameLosses;

    decklistWinRates.set(cardNameKey(cardName), {
      winRate: total > 0 ? Math.round((gameWins / total) * 1000) / 1000 : 0,
      gameWins,
      gameLosses,
      timesMaindecked: row.times_maindecked as number,
      draftsWithData: row.drafts_with_data as number,
    });
  }
```

- [ ] **Step 2: Attribute decklist win rates to stats (after line 392, alongside win equity attribution)**

Inside the existing `for (const stat of stats)` loop (lines 373-392), add after the `rawWinRate` block:

```typescript
    const decklistWR = decklistWinRates.get(key);
    if (decklistWR) {
      stat.decklistWinRate = decklistWR;
    }
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/build/tursoDataLoader.ts
git commit -m "Add bulk decklist win rate query to build-time data loader"
```

## Chunk 2: UI Layer

### Task 3: Create `useIsLocalhost` hook

**Files:**
- Create: `src/app/hooks/useIsLocalhost.ts`

- [ ] **Step 1: Create the hook**

```typescript
"use client";

import { useCallback, useSyncExternalStore } from "react";

const noopSubscribe = () => () => {};

/**
 * Hook to detect if the app is running on localhost.
 * Returns false during SSR, true on localhost after hydration.
 */
export function useIsLocalhost(): boolean {
  const getSnapshot = useCallback(
    () =>
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1",
    []
  );
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(noopSubscribe, getSnapshot, getServerSnapshot);
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/app/hooks/useIsLocalhost.ts
git commit -m "Add useIsLocalhost hook for localhost detection"
```

### Task 4: Add Deck WR column to `CardTable`

**Files:**
- Modify: `src/app/components/CardTable.tsx:21-28,87-94,108-291`

- [ ] **Step 1: Add `isLocalhost` prop**

Update `CardTableProps` (line 21):

```typescript
export interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
  showWinEquity: boolean;
  showRawWinRate: boolean;
  isLocalhost: boolean;
}
```

Update the destructuring (line 87):

```typescript
export function CardTable({
  cards,
  colorFilter,
  colorFilterMode,
  currentCubeCopies,
  showWinEquity,
  showRawWinRate,
  isLocalhost,
}: CardTableProps) {
```

- [ ] **Step 2: Add tooltip explanation constant**

Add after `RAW_WIN_RATE_EXPLANATION` (after line 85):

```typescript
const DECKLIST_WIN_RATE_EXPLANATION = `Deck Win Rate shows the actual win rate of players who maindecked this card.

Higher = better (players who played this card in their deck won more)

How it works:
• Uses real decklist submissions (not estimated from pick position)
• Only counts games where the card was in the player's main deck
• Aggregated across all drafts with both decklist and match data`;
```

- [ ] **Step 3: Add column definition**

After the `showRawWinRate` conditional column block (after line 232), add:

```typescript
      ...(isLocalhost
        ? [
            columnHelper.accessor((row) => row.decklistWinRate?.winRate ?? -1, {
              id: "decklistWinRate",
              header: () => (
                <span className="inline-flex items-center">
                  Deck WR
                  <InfoTooltip text={DECKLIST_WIN_RATE_EXPLANATION} />
                </span>
              ),
              cell: ({ row }) => {
                const wr = row.original.decklistWinRate;
                if (!wr) {
                  return <span className="text-sm text-zinc-400">—</span>;
                }
                const pct = (wr.winRate * 100).toFixed(1);
                return (
                  <div className="group relative">
                    <span className="font-mono text-sm font-medium text-zinc-700 dark:text-zinc-300">
                      {pct}%
                    </span>
                    <div className="absolute -top-10 left-0 z-50 hidden rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white group-hover:block">
                      {wr.gameWins}W / {wr.gameLosses}L across {wr.timesMaindecked} decks ({wr.draftsWithData} drafts)
                    </div>
                  </div>
                );
              },
              sortingFn: (a, b) => {
                const aVal = a.original.decklistWinRate?.winRate ?? -1;
                const bVal = b.original.decklistWinRate?.winRate ?? -1;
                return aVal - bVal;
              },
            }),
          ]
        : []),
```

- [ ] **Step 4: Add `isLocalhost` to columns useMemo dependency array**

Update the dependency array (line 290):

```typescript
    [currentCubeCopies, showWinEquity, showRawWinRate, isLocalhost, draftTimeline]
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit`
Expected: Errors about missing `isLocalhost` prop in `PageClient.tsx` (expected — we fix this next)

- [ ] **Step 6: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Add Deck WR column to CardTable, gated by isLocalhost prop"
```

### Task 5: Thread `isLocalhost` through `PageClient`

**Files:**
- Modify: `src/app/components/PageClient.tsx:1-7,426-433`

- [ ] **Step 1: Import the hook and pass prop**

Add import (after line 7):

```typescript
import { useIsLocalhost } from "../hooks/useIsLocalhost";
```

Inside `PageClient` function body, after the `isHydrated` line (after line 70):

```typescript
  const isLocalhost = useIsLocalhost();
```

Update the `<CardTable>` usage (around line 426-433) to add the prop:

```typescript
          <CardTable
            cards={searchFilteredCards}
            colorFilter={colorFilter}
            colorFilterMode={colorFilterMode}
            currentCubeCopies={displayedCubeCopies}
            showWinEquity={showWinEquity}
            showRawWinRate={showRawWinRate}
            isLocalhost={isLocalhost}
          />
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Thread isLocalhost to CardTable for Deck WR column visibility"
```

## Chunk 3: Verification

### Task 6: Manual verification

- [ ] **Step 1: Run dev server and check localhost**

Run: `pnpm dev`

Open `http://localhost:3000`. Verify:
- The "Deck WR" column appears after Win Rate (if visible) or after Distribution
- Cards with decklist data show a percentage
- Cards without decklist data show "—"
- Hovering shows tooltip with wins/losses/decks/drafts
- Column is sortable

- [ ] **Step 2: Verify build succeeds**

Run: `pnpm build`
Expected: Build completes without errors. The Deck WR column data is baked in.

- [ ] **Step 3: Commit any fixes if needed**

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "Decklist win rate column: localhost-only, build-time computed"
```
