# Live Draft UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 live draft UX issues: exclude active drafts from stats, fix banned card count, show GPWR confidence interval, lock mobile viewport, fix pod view modal scroll, and show floated/queued cards in deck builder.

**Architecture:** Each fix is independent — touching different files with minimal overlap. Tasks 1-3 are backend/stats fixes. Tasks 4-6 are UI/layout fixes. No new dependencies required.

**Tech Stack:** Next.js (App Router), React, TypeScript, Turso (SQLite), Tailwind CSS

---

## Task 1: Exclude non-complete drafts from card stats queries

The main card table stats already filter to completed drafts (`getCards.ts:456-458`), but the CardStatsModal fetches via `/api/cards/stats` → `cardStats.ts` which calls `pickHistory.ts`, `pickStats.ts`, `colorPairBreakdown.ts`, and `decklists.ts`. These queries include in-progress drafts, causing noise like showing a card as "unpicked" in the current live draft.

**Files:**
- Modify: `src/core/db/queries/stats/pickHistory.ts:63`
- Modify: `src/core/db/queries/stats/pickStats.ts:85`
- Modify: `src/core/db/queries/stats/colorPairBreakdown.ts` (verify and add phase filter if missing)
- Modify: `src/core/db/queries/decklists.ts` (verify `getCardWinStats` has phase filter)

- [ ] **Step 1: Fix pickHistory.ts phase filter**

In `pickHistory.ts:63`, change:
```sql
WHERE d.phase != 'setup'
```
to:
```sql
WHERE d.phase = 'complete'
```

- [ ] **Step 2: Add phase filter to pickStats.ts**

In `pickStats.ts:85`, the drafts query has no phase filter. Add `AND d.phase = 'complete'`:
```sql
SELECT DISTINCT d.draft_id, d.cube_snapshot_id
FROM drafts d
JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
WHERE csc.card_id = ? AND d.phase = 'complete' ${draftWhere}
```

- [ ] **Step 3: Verify and fix colorPairBreakdown.ts**

Read `src/core/db/queries/stats/colorPairBreakdown.ts`. If the query joins drafts without filtering `d.phase = 'complete'`, add it. The query goes through `deck_cards` → `drafts`.

- [ ] **Step 4: Verify and fix decklists.ts win stats query**

Read `getCardWinStats` in `src/core/db/queries/decklists.ts`. Ensure it filters to `d.phase = 'complete'`. Win data should only come from completed drafts.

- [ ] **Step 5: Run tests**

Run: `pnpm test`

- [ ] **Step 6: Commit**

```
Exclude non-complete drafts from card stats queries

pickHistory, pickStats, and related queries now filter to
d.phase = 'complete' instead of d.phase != 'setup', preventing
in-progress drafts from appearing in stats modal data.
```

---

## Task 2: Fix banned card count bug

**Root cause (confirmed via database investigation):** `pickHistory.ts` counts bans by joining `drafts` → `cube_snapshot_cards` → `cards`. But cards can be banned in drafts where they aren't in the cube snapshot (because the Google Sheet may have the card removed from the cube list when it's banned). Example: Phelia is banned in both Terminate (cube_snapshot_id=10) and Maelstrom Pulse (cube_snapshot_id=9), but only exists in snapshot 10. The join never finds the Maelstrom Pulse row, so that ban goes uncounted.

**Affected cards:** Any card banned in Maelstrom Pulse that isn't in cube snapshot 9: Phelia, Ragavan, Pyrogoyf, Fury, Mother of Runes, Reanimate, Strip Mine.

**Additional issue:** `pickStats.ts` doesn't exclude banned drafts at all — drafts where a card is banned are counted in `drafts_seen` and treated as "not picked" (assigned pool_size pick position), which inflates the denominator and worsens the geomean.

**Files:**
- Modify: `src/core/db/queries/stats/pickHistory.ts`
- Modify: `src/core/db/queries/stats/pickStats.ts`

- [ ] **Step 1: Add supplementary ban count query in pickHistory.ts**

After the main query loop (line 104), run a second query to find drafts where this card is in `banned_cards` JSON but was NOT returned by the main query (because the card isn't in that draft's `cube_snapshot_cards`):

```typescript
// Count bans from drafts where card wasn't in the cube snapshot
// (These drafts were missed by the main query's JOIN through cube_snapshot_cards)
const draftIdsAlreadySeen = new Set(
  result.rows.map((r) => r.draft_id as string)
);

const allDraftsResult = await client.execute({
  sql: `SELECT d.draft_id, d.banned_cards
        FROM drafts d
        WHERE d.phase = 'complete'
          AND d.banned_cards IS NOT NULL
          ${draftFilter} ${excludeFilter}`,
  args,
});

for (const row of allDraftsResult.rows) {
  if (draftIdsAlreadySeen.has(row.draft_id as string)) continue;
  const bannedSet = parseBannedCards(row.banned_cards as string | null);
  if (bannedSet.has(cardNameLower)) {
    timesBanned++;
  }
}
```

Note: `args` needs to be rebuilt for this query since the first arg (card name) isn't needed here. Build the filter args separately:
```typescript
const filterArgs: string[] = [];
if (draftId) filterArgs.push(draftId);
if (excludeDraftId) filterArgs.push(excludeDraftId);
```

- [ ] **Step 2: Exclude banned drafts from pickStats.ts**

After getting `draftIds` (line 100 in `pickStats.ts`), load banned cards for those drafts and filter out any where this card is banned:

```typescript
import { parseBannedCards } from "../helpers";

// After line 100, before using draftIds:
const bannedResult = await client.execute({
  sql: `SELECT draft_id, banned_cards FROM drafts
        WHERE draft_id IN (${placeholders})
          AND banned_cards IS NOT NULL`,
  args: draftIds,
});

const bannedInDrafts = new Set<string>();
for (const row of bannedResult.rows) {
  const bannedSet = parseBannedCards(row.banned_cards as string | null);
  if (bannedSet.has(card_name.toLowerCase())) {
    bannedInDrafts.add(row.draft_id as string);
  }
}

const filteredDraftIds = draftIds.filter(id => !bannedInDrafts.has(id));
```

Then use `filteredDraftIds` instead of `draftIds` for the remainder of the function (picks query, cube sizes, opt-outs, and stats calculation). Update the placeholders accordingly.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Commit**

```
Fix banned card count: count bans from drafts where card isn't in cube

Cards can be banned in drafts where they aren't in the cube snapshot
(when removed from the Google Sheet as part of banning). The pickHistory
query joins through cube_snapshot_cards and missed these bans. Now runs
a supplementary query to catch bans from drafts the main query didn't
find. Also excludes banned drafts from pickStats to prevent them from
inflating drafts_seen and worsening the geomean.
```

---

## Task 3: Show GPWR confidence interval as ±margin

The Wilson CI is already computed in `cardStats.ts:159` and returned in the API response as `win_rate_ci: { lower, center, upper }`. The `useCardStats.ts` hook receives it. The UI in `CardStatsModal.tsx` just doesn't display it.

**Files:**
- Modify: `src/app/components/CardStatsModal.tsx:182-191`

- [ ] **Step 1: Update GPWR StatRow to show ±margin**

In `CardStatsModal.tsx`, replace lines 182-191:

```tsx
{isLocal && wins && (
  <StatRow
    label="GPWR"
    value={`${(wins.win_rate * 100).toFixed(0)}%${wins.low_sample ? '*' : ''}`}
    annotation={`\u00b1${Math.round((wins.win_rate_ci.upper - wins.win_rate_ci.lower) * 50)}%`}
  />
)}
```

The margin is `(upper - lower) / 2 * 100`, simplified as `(upper - lower) * 50`, rounded to nearest integer.

- [ ] **Step 2: Run tests**

Run: `pnpm test`

- [ ] **Step 3: Commit**

```
Show GPWR confidence interval as ±margin in stats modal
```

---

## Task 4: Lock mobile viewport globally

Prevent page-level scrolling and pinch-zoom. Only internal scroll containers (card table, modals) should scroll.

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/app/globals.css`

- [ ] **Step 1: Add viewport export to layout.tsx**

Import `Viewport` type and add the export. Place it near the existing `metadata` export (around line 19):

```typescript
import type { Metadata, Viewport } from "next";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};
```

- [ ] **Step 2: Add body overflow constraint in globals.css**

Add these rules (in the base layer or as standalone rules):

```css
html, body {
  overflow: hidden;
  height: 100dvh;
}
```

The card table already uses a dynamically-sized scroll container (`CardTable.tsx:195-204`) that fills remaining viewport height, so this won't break the analytics view.

- [ ] **Step 3: Run tests**

Run: `pnpm test`

- [ ] **Step 4: Commit**

```
Lock viewport: prevent mobile zoom and body-level scroll
```

---

## Task 5: Pod view modal — scroll only the draft matrix

Currently the modal body (`DraftBoardModal.tsx:185`) has `overflowY: "auto"`, making the entire content (DraftBoardMatrix + StandingsSection + QueuePanel) scroll as one unit. The matrix should scroll internally while standings and queue remain pinned at the bottom.

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx:184-231`
- Modify: `src/app/components/draft-board/DraftBoardMatrix.tsx:97`

- [ ] **Step 1: Restructure the modal body as a flex column**

In `DraftBoardModal.tsx`, change the body div (line 185) from:
```tsx
<div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
```
to:
```tsx
<div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", padding: "16px 20px", gap: "16px" }}>
```

- [ ] **Step 2: Wrap DraftBoardMatrix in a scrollable flex child**

Wrap `<DraftBoardMatrix>` in a div that fills remaining space and scrolls:
```tsx
<div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
  <DraftBoardMatrix ... />
</div>
```

- [ ] **Step 3: Pin standings and queue at the bottom**

Wrap `<StandingsSection>` and the conditional `<QueuePanel>` in a flex-shrink-0 container:
```tsx
<div style={{ flexShrink: 0 }}>
  <StandingsSection ... />
  {token !== null && (
    <QueuePanel ... />
  )}
</div>
```

- [ ] **Step 4: Remove DraftBoardMatrix internal maxHeight**

In `DraftBoardMatrix.tsx:97`, remove `maxHeight: "75vh"` — the parent now controls sizing. Keep overflow for both axes:
```tsx
<div style={{ overflowX: "auto", overflowY: "auto" }}>
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`

- [ ] **Step 6: Commit**

```
Pin standings/queue in pod view modal, scroll only the draft matrix
```

---

## Task 6: Show floated and queued cards in deck builder (with auto-remove)

The deck builder gets its card pool from `seatCardList` (`useCardFiltering.ts:36-42`), which comes from `pick_events` — only finalized picks. Floated and queued cards should also appear. When a card is unfloated/unqueued, it should be auto-removed from the deck builder.

**Files:**
- Modify: `src/core/deckBuilder.ts` (add `REMOVE_CARDS` action)
- Modify: `src/app/hooks/useDeckBuilderSync.ts` (accept and merge floated/queued cards, handle auto-remove)
- Modify: `src/app/components/PageClient.tsx` (pass floated/queued to sync hook)
- Test: `src/app/hooks/useDeckBuilderSync.test.ts`

- [ ] **Step 1: Add REMOVE_CARDS action to deckBuilder.ts**

Add new action type variant around line 172:
```typescript
| {
    type: "REMOVE_CARDS";
    cardNames: string[];
  }
```

Add handler in the reducer switch (after SYNC_PICKS):
```typescript
case "REMOVE_CARDS": {
  const toRemove = new Set(action.cardNames);
  const next = structuredClone(state);
  let changed = false;
  for (const zone of ["deck", "sideboard"] as const) {
    for (const [col, cards] of Object.entries(next.zones[zone])) {
      const filtered = cards.filter((name) => !toRemove.has(name));
      if (filtered.length !== cards.length) {
        next.zones[zone][col] = filtered;
        changed = true;
      }
    }
  }
  return changed ? next : state;
}
```

- [ ] **Step 2: Extend useDeckBuilderSync to accept floated and queued cards**

Add props to `UseDeckBuilderSyncProps`:
```typescript
interface UseDeckBuilderSyncProps {
  // ... existing props
  floatedCards: string[];
  queuedCardNames: string[];
}
```

Compute `allCardNames` by merging all three sources. Use this for INIT_FROM_PICKS and SYNC_PICKS:
```typescript
const allCardNames = useMemo(() => {
  const picks = seatCardList ?? [];
  return [...picks, ...floatedCards, ...queuedCardNames];
}, [seatCardList, floatedCards, queuedCardNames]);
```

Replace `seatCardList` with `allCardNames` in both the INIT_FROM_PICKS dispatch (line 44) and the SYNC_PICKS dispatch (line 62). Update the guards to check `allCardNames.length > 0` instead of `seatCardList.length > 0`.

- [ ] **Step 3: Implement auto-remove for unfloated/unqueued cards**

Add a ref to track the previous set of speculative (non-picked) cards. On each render, compute removed cards and dispatch REMOVE_CARDS:

```typescript
const prevSpeculativeRef = useRef<Set<string>>(new Set());

useEffect(() => {
  if (!deckBuilderActive || !ready) return;

  const pickedSet = new Set(seatCardList ?? []);
  const currentSpeculative = new Set([
    ...floatedCards.filter((c) => !pickedSet.has(c)),
    ...queuedCardNames.filter((c) => !pickedSet.has(c)),
  ]);

  // Cards that were speculative before but aren't anymore (and aren't picked)
  const removed: string[] = [];
  for (const card of prevSpeculativeRef.current) {
    if (!currentSpeculative.has(card) && !pickedSet.has(card)) {
      removed.push(card);
    }
  }

  if (removed.length > 0) {
    dispatch({ type: "REMOVE_CARDS", cardNames: removed });
  }

  prevSpeculativeRef.current = currentSpeculative;
}, [seatCardList, floatedCards, queuedCardNames, deckBuilderActive, ready, dispatch]);
```

- [ ] **Step 4: Pass floated/queued from PageClient.tsx**

In `PageClient.tsx`, find the `useDeckBuilderSync` call (around line 254) and add the new props. Check how `pickQueue` exposes queued card names — it's `pickQueue.queuedCards` (a `Map<string, number>`), so extract keys:

```typescript
const queuedCardNames = useMemo(
  () => Array.from(pickQueue.queuedCards.keys()),
  [pickQueue.queuedCards],
);

useDeckBuilderSync({
  // ... existing props
  floatedCards,
  queuedCardNames,
});
```

- [ ] **Step 5: Update tests**

In `useDeckBuilderSync.test.ts`, add `floatedCards: []` and `queuedCardNames: []` to `baseProps`. Add test cases:

1. Floated cards are included in SYNC_PICKS dispatch
2. Queued cards are included in SYNC_PICKS dispatch
3. Unfloating a card dispatches REMOVE_CARDS
4. Picked cards are NOT removed when unfloated (they're in seatCardList)

- [ ] **Step 6: Run tests**

Run: `pnpm test`

- [ ] **Step 7: Commit**

```
Include floated/queued cards in deck builder with auto-remove

The deck builder now shows floated and queued cards alongside picked
cards. When a card is unfloated or unqueued (and wasn't picked), it's
automatically removed from the deck builder via the new REMOVE_CARDS
reducer action.
```

---

## Verification

After all tasks are complete:

1. Run the full precommit suite: `pnpm precommit`
2. Deploy to preview and test:
   - Stats modal shows only completed draft data (no "unpicked" for current draft)
   - Phelia shows "banned 2x", Ragavan shows "banned 2x", etc.
   - GPWR shows "44% ±6%" format with confidence interval
   - Mobile viewport is locked (no zoom/body scroll)
   - Pod view modal: matrix scrolls, standings/queue pinned at bottom
   - Deck builder shows floated/queued cards; unfloating removes them
