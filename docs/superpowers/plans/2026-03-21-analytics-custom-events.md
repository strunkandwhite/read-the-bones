# Analytics Custom Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 15 custom analytics events to track feature engagement and client-side performance using Vercel's `track()` function.

**Architecture:** All events use `import { track } from '@vercel/analytics/react'` called from client components. Engagement events fire in event handlers; performance events use `useEffect` timing and sync hook instrumentation. A shared `useSlowRenderTracking` hook handles render performance measurement with throttling.

**Tech Stack:** `@vercel/analytics@2.0.1` (already installed), React hooks, Next.js App Router

**Spec:** `docs/superpowers/specs/2026-03-21-analytics-custom-events-design.md`

---

## Chunk 1: Shared Utilities and Search Events

### Task 1: Create analytics utility — `useSlowRenderTracking` hook

**Files:**
- Create: `src/app/hooks/useSlowRenderTracking.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useEffect, useRef } from "react";
import { track } from "@vercel/analytics/react";

export function useSlowRenderTracking(component: string, thresholdMs = 500) {
  const renderStart = performance.now();
  const lastTracked = useRef(0);

  useEffect(() => {
    const now = performance.now();
    const duration = now - renderStart;
    if (duration > thresholdMs && now - lastTracked.current > 30_000) {
      lastTracked.current = now;
      track("slow_render", { component, duration_ms: Math.round(duration) });
    }
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/hooks/useSlowRenderTracking.ts
git commit -m "feat: add useSlowRenderTracking analytics hook"
```

### Task 2: Add `search` event to useCardSearch hook

**Files:**
- Modify: `src/app/hooks/useCardSearch.ts:36-55` (debounced search effect)

The search hook has two code paths: plain text name searches (early return at line 44-47) and operator-based searches (setTimeout at line 49-52). We need to track both. Add a separate debounced tracking effect that fires for all non-empty queries.

- [ ] **Step 1: Add track import and query type classifier**

Add to the top of `src/app/hooks/useCardSearch.ts`:

```ts
import { track } from "@vercel/analytics/react";
```

Add a helper function before the `useCardSearch` export:

```ts
function classifyQueryType(query: string): string {
  const prefixes = [
    { prefix: "t:", type: "type" },
    { prefix: "o:", type: "oracle" },
    { prefix: "c:", type: "color" },
    { prefix: "cmc", type: "cmc" },
  ];
  const found = prefixes.filter((p) => query.includes(p.prefix));
  if (found.length > 1) return "multi";
  if (found.length === 1) return found[0].type;
  return "name";
}
```

- [ ] **Step 2: Add a debounced search tracking effect**

Add a new `useEffect` after the existing debounced search effect (after line 56). This fires for all non-empty queries, including plain text name searches that bypass the operator path:

```ts
// Track search events (debounced, fires for all query types)
useEffect(() => {
  const query = searchQuery.trim();
  if (!query) return;

  const timeoutId = setTimeout(() => {
    const queryType = classifyQueryType(query);
    // For operator queries, result_count comes from Scryfall search
    // For name queries, we don't have a result count (filtering is done downstream)
    if (hasScryfallOperators(query)) {
      const results = searchLocalCards(query, scryfallCards);
      track("search", { query_type: queryType, result_count: results.length });
    } else {
      track("search", { query_type: queryType, result_count: -1 });
    }
  }, 500);

  return () => clearTimeout(timeoutId);
}, [searchQuery, scryfallCards]);
```

Note: For plain text name searches, `result_count` is set to `-1` because the name filtering happens downstream in the card table (not in this hook). The `-1` distinguishes "not applicable" from "zero results."

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/hooks/useCardSearch.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/app/hooks/useCardSearch.ts
git commit -m "feat: track search events with query type classification"
```

### Task 3: Add `color_filter` event to ColorFilter component

**Files:**
- Modify: `src/app/components/ColorFilter.tsx:16-21` (toggleColor handler)

Track color filter changes when colors are toggled. Fire the event with the resulting color selection and current mode.

- [ ] **Step 1: Add track import**

Add to the top of `src/app/components/ColorFilter.tsx`:

```ts
import { track } from "@vercel/analytics/react";
```

- [ ] **Step 2: Add tracking to toggleColor handler**

Modify the `toggleColor` function (line 16-21):

```ts
const toggleColor = (code: string) => {
  const newColors = selected.includes(code)
    ? selected.filter((c) => c !== code)
    : [...selected, code];
  onChange(newColors);
  if (newColors.length > 0) {
    track("color_filter", { colors: newColors.join(""), mode });
  }
};
```

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/app/components/ColorFilter.tsx
git commit -m "feat: track color filter events"
```

## Chunk 2: CardTable and Settings Events

### Task 4: Add `sort_column` event to CardTable

**Files:**
- Modify: `src/app/components/CardTable.tsx:92,260` (sorting state and handler)

TanStack Table uses `onSortingChange: setSorting` at line 260. Wrap the setter to intercept sort changes and track them.

- [ ] **Step 1: Add track import**

Add to the imports in `src/app/components/CardTable.tsx`:

```ts
import { track } from "@vercel/analytics/react";
```

- [ ] **Step 2: Wrap the sorting state setter**

Replace the `onSortingChange: setSorting` at line 260 with a wrapper that tracks the event:

```ts
onSortingChange: (updater) => {
  setSorting((prev) => {
    const next = typeof updater === "function" ? updater(prev) : updater;
    if (next.length > 0) {
      track("sort_column", {
        column: next[0].id,
        direction: next[0].desc ? "desc" : "asc",
      });
    }
    return next;
  });
},
```

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/components/PageClient.test.tsx`

- [ ] **Step 4: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "feat: track column sort events"
```

### Task 5: Add `settings_open` event

**Files:**
- Modify: `src/app/components/Settings.tsx:81` (gear icon click handler)

- [ ] **Step 1: Add track import**

Add to the imports in `src/app/components/Settings.tsx`:

```ts
import { track } from "@vercel/analytics/react";
```

- [ ] **Step 2: Add tracking to gear icon click**

Modify the `onClick` handler at line 81:

```ts
onClick={() => {
  setIsOpen(true);
  track("settings_open");
}}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add src/app/components/Settings.tsx
git commit -m "feat: track settings open events"
```

### Task 6: Add `active_draft_set`, `seat_selected`, `pool_as_of_changed`, and `deck_builder_open` events to PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx:39,254,258,261,390` (state setters and toggle handler)

These events all fire from PageClient where state changes happen.

- [ ] **Step 1: Add track import**

Add to the imports in `src/app/components/PageClient.tsx`:

```ts
import { track } from "@vercel/analytics/react";
```

- [ ] **Step 2: Wrap `setPoolAsOfDraft` with tracking**

Replace the `useState` at line 39 with a tracking wrapper:

```ts
const [poolAsOfDraft, setPoolAsOfDraftRaw] = useState<string | null>(null);
const setPoolAsOfDraft = useCallback((draft: string | null) => {
  setPoolAsOfDraftRaw(draft);
  if (draft) {
    track("pool_as_of_changed", { draft });
  }
}, []);
```

- [ ] **Step 3: Add tracking wrappers for Settings callbacks**

Add these wrapper callbacks after the existing `onDraftsChange` function (around line 192):

```ts
const onActiveDraftChange = useCallback(
  (draftId: string | null) => {
    draftSelection.setActiveDraft(draftId);
    if (draftId) {
      track("active_draft_set", { draft: draftId });
    }
  },
  [draftSelection]
);

const onSeatChange = useCallback(
  (seat: number | null) => {
    draftSelection.setSelectedSeat(seat);
    if (seat !== null && draftSelection.activeDraft) {
      track("seat_selected", {
        draft: draftSelection.activeDraft,
        seat,
      });
    }
  },
  [draftSelection]
);
```

- [ ] **Step 4: Update Settings props to use wrappers**

In the `<Settings>` JSX (around line 247-263), change:
- `onActiveDraftChange={draftSelection.setActiveDraft}` → `onActiveDraftChange={onActiveDraftChange}`
- `onSelectedSeatChange={draftSelection.setSelectedSeat}` → `onSelectedSeatChange={onSeatChange}`

- [ ] **Step 5: Add deck builder open tracking**

Modify the deck builder toggle button `onClick` at line 390:

```ts
onClick={() => {
  setShowDeckBuilder((prev) => {
    if (!prev) {
      track("deck_builder_open", {
        draft: draftSelection.activeDraft!,
        seat: draftSelection.selectedSeat!,
      });
    }
    return !prev;
  });
}}
```

- [ ] **Step 6: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/components/PageClient.test.tsx`

- [ ] **Step 7: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "feat: track draft, seat, pool, and deck builder events"
```

## Chunk 3: Deck Builder and Sync Events

### Task 7: Add `deck_card_add` event

**Files:**
- Modify: `src/app/components/PageClient.tsx:159-169` (handleAddSpeculative callback)
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx:61-100` (handleDragEnd)

Cards can be added from the table (+ button) or via drag-and-drop. Track both sources.

- [ ] **Step 1: Track table adds in handleAddSpeculative**

Modify `handleAddSpeculative` in `PageClient.tsx` (line 159-169) to add tracking:

```ts
const handleAddSpeculative = useCallback(
  (cardName: string) => {
    deckBuilder.dispatch({
      type: "ADD_SPECULATIVE",
      cardName,
      scryfallData: scryfallDataMap,
      maxCopies: cardData.cubeCopies[cardName] || 1,
    });
    track("deck_card_add", { zone: "deck", source: "table" });
  },
  [deckBuilder, scryfallDataMap, cardData.cubeCopies]
);
```

- [ ] **Step 2: Track cross-zone drag moves in DeckBuilderPanel**

In `src/app/components/deck-builder/DeckBuilderPanel.tsx`, add the import:

```ts
import { track } from "@vercel/analytics/react";
```

In the `handleDragEnd` callback (line 61-119), after the `dispatch({ type: "MOVE_CARD" })` call at line 108-116, add tracking only when the card moves to a **different zone** (not column-to-column within the same zone):

```ts
dispatch({
  type: "MOVE_CARD",
  cardName: from.cardName,
  fromZone: from.zone,
  fromColumn: from.column,
  toZone,
  toColumn,
  toIndex,
});
if (from.zone !== toZone) {
  track("deck_card_add", { zone: toZone, source: "drag" });
}
```

This avoids firing the event for column-to-column reordering within the same zone.

- [ ] **Step 3: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/hooks/useDeckBuilder.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "feat: track deck card add events from table and drag"
```

### Task 8: Add `deck_shared` event to share handler

**Files:**
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx:123-145` (handleShareDeck callback)

The `handleShareDeck` handler at line 123-145 already exists and handles the full share flow (POST to API, copy URL to clipboard). Add tracking after the successful clipboard write.

- [ ] **Step 1: Add tracking after successful share**

In `handleShareDeck` (line 123-145), add the `track()` call after the successful clipboard write at line 137-138:

```ts
const { deckId } = await response.json();
const url = `${window.location.origin}/deck/${deckId}`;
await navigator.clipboard.writeText(url);
track("deck_shared", {
  draft: draftName,
  card_count: Object.values(state.zones.deck).flat().length,
});
setShareStatus("shared");
```

- [ ] **Step 2: Commit**

```bash
git add src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "feat: track deck shared events"
```

### Task 9: Add sync tracking events to useSyncStatus

**Files:**
- Modify: `src/app/hooks/useSyncStatus.ts:33-50,72-95` (fetchStatus and triggerSync)

The hook currently swallows errors with an empty `catch {}` at line 47. We need to surface errors for `sync_failed` tracking while keeping the polling resilient. Note: Adding a `catch` block to `triggerSync` intentionally swallows fetch errors (the original had no `catch`, only `finally`). This is acceptable — sync errors should not propagate to the UI, and the analytics event captures the failure.

- [ ] **Step 1: Add track import**

Add to the imports in `src/app/hooks/useSyncStatus.ts`:

```ts
import { track } from "@vercel/analytics/react";
```

- [ ] **Step 2: Add sync_failed tracking in fetchStatus error handler**

Replace the empty `catch` block at line 47-49:

```ts
} catch (err) {
  track("sync_failed", {
    error: String(err).slice(0, 255),
    draft: "polling",
  });
}
```

- [ ] **Step 3: Add sync_completed and sync_failed tracking in triggerSync**

Modify the `triggerSync` callback (line 72-95) to track timing and results:

```ts
const triggerSync = useCallback(async () => {
  pollPausedRef.current = true;
  setManualSyncInFlight(true);
  const startTime = performance.now();
  try {
    const res = await fetch("/api/sync", { method: "POST" });
    let syncCompleted = false;
    if (res.ok) {
      const data = await res.json();
      if (data.lastSyncedAt) {
        lastSyncedAtRef.current = data.lastSyncedAt;
      }
      syncCompleted = data.status === "completed";
      track("sync_completed", {
        duration_ms: Math.round(performance.now() - startTime),
        picks_found: data.newPicks ?? 0,
      });
    } else {
      track("sync_failed", {
        error: `HTTP ${res.status}`,
        draft: "manual",
      });
    }
    pollPausedRef.current = false;
    await fetchStatus();
    if (syncCompleted) {
      setDataChanged(true);
    }
  } catch (err) {
    track("sync_failed", {
      error: String(err).slice(0, 255),
      draft: "manual",
    });
  } finally {
    setManualSyncInFlight(false);
    pollPausedRef.current = false;
  }
}, [fetchStatus]);
```

- [ ] **Step 4: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/core/__tests__/sync.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useSyncStatus.ts
git commit -m "feat: track sync completed and failed events"
```

### Task 10: Add `sync_manual` event to ActiveDraftIndicator

**Files:**
- Modify: `src/app/components/ActiveDraftIndicator.tsx` (Sync Now button)

Track when users click the Sync Now button with the time since last sync.

- [ ] **Step 1: Add tracking to Sync Now button**

Add the import:

```ts
import { track } from "@vercel/analytics/react";
```

Find the Sync Now button's `onClick` handler and wrap it to track:

```ts
onClick={() => {
  const lastSync = new Date(lastSyncedAt).getTime();
  const secondsSince = Math.round((Date.now() - lastSync) / 1000);
  track("sync_manual", {
    draft: draftName,
    seconds_since_last: secondsSince,
  });
  onSyncNow();
}}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add src/app/components/ActiveDraftIndicator.tsx
git commit -m "feat: track manual sync button clicks"
```

## Chunk 4: Performance Events

### Task 11: Add `slow_render` tracking to key components

**Files:**
- Modify: `src/app/components/CardTable.tsx` (add hook call)
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx` (add hook call)
- Modify: `src/app/components/DraftStats.tsx` (add hook call)

- [ ] **Step 1: Add the hook to CardTable**

In `src/app/components/CardTable.tsx`, add import:

```ts
import { useSlowRenderTracking } from "../hooks/useSlowRenderTracking";
```

Inside the `CardTable` component function, add at the top (before other hooks):

```ts
useSlowRenderTracking("card_table");
```

- [ ] **Step 2: Add the hook to DeckBuilderPanel**

In `src/app/components/deck-builder/DeckBuilderPanel.tsx`, add import:

```ts
import { useSlowRenderTracking } from "../../hooks/useSlowRenderTracking";
```

Inside the `DeckBuilderPanel` component function, add at the top:

```ts
useSlowRenderTracking("deck_builder");
```

- [ ] **Step 3: Add the hook to DraftStats**

In `src/app/components/DraftStats.tsx`, add import:

```ts
import { useSlowRenderTracking } from "../hooks/useSlowRenderTracking";
```

Inside the `DraftStats` component function, add at the top:

```ts
useSlowRenderTracking("draft_stats");
```

- [ ] **Step 4: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/components/PageClient.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/app/components/CardTable.tsx src/app/components/deck-builder/DeckBuilderPanel.tsx src/app/components/DraftStats.tsx
git commit -m "feat: track slow renders on card table, deck builder, and draft stats"
```

### Task 12: Add `page_load` tracking to PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx` (add page load timing effect)

- [ ] **Step 1: Add page load timing effect**

In `PageClient.tsx`, add a `useEffect` near the other effects (after the `useCardData` call around line 70):

```ts
// Track page load performance
const pageLoadTracked = useRef(false);
useEffect(() => {
  if (!pageLoadTracked.current && cardData.cards.length > 0) {
    pageLoadTracked.current = true;
    const duration = performance.now();
    track("page_load", {
      duration_ms: Math.round(duration),
      card_count: cardData.cards.length,
    });
  }
}, [cardData.cards.length]);
```

`performance.now()` gives milliseconds since page navigation start, which is the total time-to-data.

- [ ] **Step 2: Run typecheck and tests**

Run: `pnpm typecheck && pnpm test -- --run src/app/components/PageClient.test.tsx`

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "feat: track page load duration and card count"
```

## Chunk 5: Final Validation

### Task 13: Run full precommit checks

- [ ] **Step 1: Run all checks**

Run: `pnpm precommit`

Expected: All checks pass (typecheck, lint, knip, tests).

- [ ] **Step 2: Fix any issues**

If knip reports the new hook as unused (it shouldn't since it's imported in 3 components), verify the imports are correct.

If lint warnings appear for `@vercel/analytics/react` imports, verify the package exports this path.

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`

Open the site, open browser DevTools Network tab, and verify:
- Searching for a card triggers a request to Vercel's analytics endpoint
- Clicking a column header triggers a sort event
- Opening settings triggers a settings_open event

Kill the dev server when done.
