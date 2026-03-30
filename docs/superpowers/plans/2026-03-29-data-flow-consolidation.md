# Data Flow Consolidation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 17 fragmented React hooks with 3 Zustand stores, unify polling, merge overlapping API endpoints, and consolidate server-side queries — producing a data flow that's easy to trace and maintain.

**Architecture:** Three Zustand stores (`useDraftStore`, `useCardStore`, `useLiveStore`) each own a domain (draft selection/polling, card data/search/filtering, auth/queue/float/picking/deck). Cross-store communication uses Zustand's `subscribe` API with a `dataVersion` counter. A new `/api/drafts/[id]/live` endpoint replaces `/status` and `/board`.

**Tech Stack:** Zustand 5.x, Vitest, @testing-library/react, Next.js App Router, Turso (libsql)

**Spec:** `docs/superpowers/specs/2026-03-29-data-flow-consolidation-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/app/stores/draftStore.ts` | Draft selection, unified 10s polling, live draft status, board data, sync status |
| `src/app/stores/draftStore.test.ts` | Tests for draftStore |
| `src/app/stores/cardStore.ts` | Card data, search, filtering, derived maps, card stats modal |
| `src/app/stores/cardStore.test.ts` | Tests for cardStore |
| `src/app/stores/liveStore.ts` | Auth/token, queue, float, picking, deck builder, deck sync |
| `src/app/stores/liveStore.test.ts` | Tests for liveStore |
| `src/app/stores/selectors.ts` | Cross-store selectors (getCardStatus, getImageUrl) |
| `src/app/stores/selectors.test.ts` | Tests for selectors |
| `src/app/stores/hydration.ts` | `useHydration` hook — one-time SSR → store bridge |
| `src/app/api/drafts/[id]/live/route.ts` | Merged status+board endpoint |
| `src/app/api/drafts/[id]/live/route.test.ts` | Tests for live endpoint |
| `src/core/db/queries/seatTokens.ts` | Add `getAllSeatSettings` (batch query) |

### Modified Files

| File | Change |
|------|--------|
| `src/app/components/PageClient.tsx` | Strip 17 hooks, replace with store imports + `useHydration` |
| `src/app/components/CardTable.tsx` | Import `useCardStore` + `useLiveStore` directly instead of receiving props |
| `src/app/components/Settings.tsx` | Import `useDraftStore` + `useLiveStore` directly |
| `src/app/components/CardStatsModal.tsx` | Import `useCardStore` directly |
| `src/app/components/draft-board/DraftBoardModal.tsx` | Import `useDraftStore` directly |
| `src/app/components/deck-builder/DeckBuilderPanel.tsx` | Import `useLiveStore` directly |
| `src/app/components/ColorFilter.tsx` | Import `useCardStore` for color filter state |
| `src/core/db/queries/helpers.ts` | No change to `getOptedOutSeats` signature — threading happens at route handler level |
| `src/core/db/queries/picks.ts` | Add optional `optedOutSeats` param to `getPicks`, `getStandings` |
| `src/core/db/queries/pool.ts` | Add optional `optedOutSeats` param to `getDraftPool` |
| `src/core/db/queries/decklists.ts` | Add optional `optedOutSeats` param to `getCardPlayStats`, `getCardWinStats`, `getWinningDecksByColor` |
| `src/core/db/queries/stats/cardStats.ts` | Cache card resolution, consolidate sub-queries |
| `src/core/processPick.ts` | Batch seat settings query |
| `src/app/hooks/useSharedDeckLoader.ts` | Update to use store actions instead of receiving setters as props |

### Deleted Files

| File | Reason |
|------|--------|
| `src/app/hooks/useDraftSelection.ts` | Absorbed into `draftStore` |
| `src/app/hooks/useDraftSelection.test.ts` | Replaced by `draftStore.test.ts` |
| `src/app/hooks/useSyncStatus.ts` | Absorbed into `draftStore` |
| `src/app/hooks/useLiveDraftStatus.ts` | Absorbed into `draftStore` |
| `src/app/hooks/useCardData.ts` | Absorbed into `cardStore` |
| `src/app/hooks/useCardSearch.ts` | Absorbed into `cardStore` |
| `src/app/hooks/useCardSearch.test.ts` | Replaced by `cardStore.test.ts` |
| `src/app/hooks/useCardFiltering.ts` | Absorbed into `cardStore` |
| `src/app/hooks/useCardFiltering.test.ts` | Replaced by `cardStore.test.ts` |
| `src/app/hooks/useCardStats.ts` | Absorbed into `cardStore` |
| `src/app/hooks/useCardStats.test.ts` | Replaced by `cardStore.test.ts` |
| `src/app/hooks/useSeatToken.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useSeatToken.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/useMySeat.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useMySeat.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/usePickQueue.ts` | Absorbed into `liveStore` |
| `src/app/hooks/usePickQueue.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/useFloatedCards.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useFloatedCards.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/useLiveDraftPicking.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useLiveDraftPicking.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/useDeckBuilder.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useDeckBuilder.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/hooks/useDeckBuilderSync.ts` | Absorbed into `liveStore` |
| `src/app/hooks/useDeckBuilderSync.test.ts` | Replaced by `liveStore.test.ts` |
| `src/app/api/drafts/[id]/status/route.ts` | Replaced by `/live` |
| `src/app/api/drafts/[id]/status/route.test.ts` | Replaced by `live/route.test.ts` |
| `src/app/api/drafts/[id]/board/route.ts` | Replaced by `/live` |
| `src/app/api/drafts/[id]/board/route.test.ts` | Replaced by `live/route.test.ts` |

---

## Chunk 1: Foundation + Draft Store

### Task 1: Install Zustand

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install zustand**

```bash
pnpm add zustand
```

- [ ] **Step 2: Verify installation**

```bash
pnpm typecheck
```

Expected: PASS — zustand types resolve.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "Add zustand dependency for store-based state management"
```

---

### Task 2: Create the `/api/drafts/[id]/live` endpoint

This merges the existing `/status` and `/board` endpoints. Build it first so the draft store can consume it.

**Files:**
- Create: `src/app/api/drafts/[id]/live/route.ts`
- Create: `src/app/api/drafts/[id]/live/route.test.ts`
- Reference: `src/app/api/drafts/[id]/status/route.ts` (existing logic to merge)
- Reference: `src/app/api/drafts/[id]/board/route.ts` (existing logic to merge)

- [ ] **Step 1: Write the test file**

The test should verify the merged response shape contains fields from both old endpoints. Pattern: use vitest with mocked DB client (see existing `src/app/api/drafts/[id]/status/route.test.ts` for the project's API test pattern).

```typescript
// src/app/api/drafts/[id]/live/route.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Follow the same mocking pattern as the existing status/route.test.ts
// Mock getClient, getLatestPickNumber, getRecentPicks, getPicksWithCardDetails,
// getSeatDisplayNames, getMatchCount, parseBannedCardNames, getNextPick

describe("GET /api/drafts/[id]/live", () => {
  it("returns merged status + board data", async () => {
    // Setup mocks for a draft with picks
    // Call the GET handler
    // Assert response includes both status fields (phase, nextSeat, recentPicks)
    // AND board fields (picks with card details, bannedCards)
  });

  it("returns 404 for unknown draft", async () => {
    // Mock empty draft query
    // Assert 404 response
  });

  it("sets no-cache header", async () => {
    // Assert Cache-Control: no-cache
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm test src/app/api/drafts/[id]/live/route.test.ts
```

Expected: FAIL — route file doesn't exist yet.

- [ ] **Step 3: Implement the route**

```typescript
// src/app/api/drafts/[id]/live/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { AppError } from "@/core/errors";
import { getNextPick } from "@/core/snakeDraft";
import { getLatestPickNumber, getRecentPicks, getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";
import { parseBannedCardNames } from "@/core/db/queries/helpers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    const draft = await client.execute({
      sql: "SELECT phase, num_seats, picks_per_player, banned_cards FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, num_seats: numSeats, picks_per_player: picksPerPlayer, banned_cards } = draft.rows[0];

    const [latestPickN, recentPicks, picksWithDetails, seatNames, matchCount] = await Promise.all([
      getLatestPickNumber(client, draftId),
      getRecentPicks(client, draftId, 10),
      getPicksWithCardDetails(client, draftId),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
    ]);

    const ns = numSeats as number;
    const pp = picksPerPlayer as number;
    const next = pp ? getNextPick(latestPickN, ns, pp) : null;
    const totalMatches = (ns * (ns - 1)) / 2;
    const bannedCards = parseBannedCardNames(banned_cards as string | null);

    return NextResponse.json({
      phase,
      numSeats,
      picksPerPlayer,
      latestPickN,
      nextSeat: next?.seat ?? null,
      recentPicks,
      seatNames,
      matchCount,
      totalMatches,
      picks: picksWithDetails,
      bannedCards,
    }, {
      headers: { "Cache-Control": "no-cache" },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/live] Error:", error);
    return NextResponse.json({ error: "Failed to load live data" }, { status: 500 });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm test src/app/api/drafts/[id]/live/route.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/drafts/\[id\]/live/
git commit -m "Add /api/drafts/[id]/live endpoint merging status + board"
```

---

### Task 3: Build `useDraftStore`

**Files:**
- Create: `src/app/stores/draftStore.ts`
- Create: `src/app/stores/draftStore.test.ts`
- Reference: `src/app/hooks/useDraftSelection.ts` (selection logic to port)
- Reference: `src/app/hooks/useSyncStatus.ts` (sync polling to port)
- Reference: `src/app/hooks/useLiveDraftStatus.ts` (live polling + board to port)

- [ ] **Step 1: Write tests for selection state**

```typescript
// src/app/stores/draftStore.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

// Test: initial state has empty selectedDrafts, null activeDraft, etc.
// Test: setSelectedDrafts updates selectedDrafts
// Test: setActiveDraft updates activeDraft, resets selectedSeat, reads from localStorage selectedSeats map
// Test: setSelectedSeat persists to localStorage selectedSeats map
// Test: setHideTaken persists to localStorage
// Test: hydrate restores from localStorage, falls back to SSR props
// Test: hydrate with initialDraftId takes priority over localStorage
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/app/stores/draftStore.test.ts
```

Expected: FAIL — store doesn't exist.

- [ ] **Step 3: Implement selection state**

Create `src/app/stores/draftStore.ts` with Zustand `create` using the `subscribeWithSelector` middleware. Port selection logic from `useDraftSelection.ts`:

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { LiveDraftStatus, BoardData } from "@/app/hooks/useLiveDraftStatus";
import type { ActiveDraftInfo } from "@/app/hooks/useSyncStatus";

// Types moved here (will be moved out of hooks later when hooks are deleted):
// LiveDraftStatus, BoardData are imported for now, will be defined here after hook deletion

interface DraftStoreState {
  // Selection
  selectedDrafts: Set<string>;
  activeDraft: string | null;
  selectedSeat: number | null;
  hideTaken: boolean;
  poolAsOfDraft: string | null;
  completedDraftIds: string[];
  hydrated: boolean;

  // Polling output
  dataVersion: number;
  liveDraftStatus: LiveDraftStatus | null;
  board: BoardData | null;
  syncStatus: {
    lastSyncedAt: string;
    syncInProgress: boolean;
    activeDrafts: ActiveDraftInfo[];
  };
  manualSyncInFlight: boolean;

  // Actions
  setSelectedDrafts: (drafts: Set<string>) => void;
  setActiveDraft: (draftId: string | null) => void;
  setSelectedSeat: (seat: number | null) => void;
  setHideTaken: (hide: boolean) => void;
  setPoolAsOfDraft: (draftId: string | null) => void;
  hydrate: (props: { completedDraftIds: string[]; initialDraftId?: string }) => void;
  startPolling: () => void;
  stopPolling: () => void;
  refreshNow: () => Promise<void>;
  triggerSync: () => Promise<void>;
  patchSeatName: (seat: number, name: string) => void;
}

// Port localStorage helpers from useDraftSelection.ts
function getStoredSeat(draftId: string | null): number | null { /* ... */ }
function persistSeat(activeDraft: string, seat: number | null): void { /* ... */ }

export const useDraftStore = create<DraftStoreState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    selectedDrafts: new Set(),
    activeDraft: null,
    selectedSeat: null,
    hideTaken: true,
    poolAsOfDraft: null,
    completedDraftIds: [],
    hydrated: false,
    dataVersion: 0,
    liveDraftStatus: null,
    board: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
    manualSyncInFlight: false,

    // Selection actions — port from useDraftSelection.ts
    setSelectedDrafts: (drafts) => set({ selectedDrafts: drafts }),
    setActiveDraft: (draftId) => {
      set({
        activeDraft: draftId,
        selectedSeat: getStoredSeat(draftId),
        liveDraftStatus: null,
        board: null,
      });
      if (draftId) localStorage.setItem("activeDraft", draftId);
      else localStorage.removeItem("activeDraft");
    },
    setSelectedSeat: (seat) => {
      set({ selectedSeat: seat });
      const { activeDraft } = get();
      if (activeDraft) persistSeat(activeDraft, seat);
    },
    setHideTaken: (hide) => {
      set({ hideTaken: hide });
      localStorage.setItem("hideTaken", String(hide));
    },
    setPoolAsOfDraft: (draftId) => set({ poolAsOfDraft: draftId }),

    hydrate: ({ completedDraftIds, initialDraftId }) => {
      const draftId = initialDraftId ?? localStorage.getItem("activeDraft");
      const storedHideTaken = localStorage.getItem("hideTaken");
      const storedSeats = localStorage.getItem("selectedSeats");
      let seat: number | null = null;
      if (draftId && storedSeats) {
        const seatsMap = JSON.parse(storedSeats) as Record<string, number>;
        if (draftId in seatsMap) seat = seatsMap[draftId];
      }
      set({
        completedDraftIds,
        selectedDrafts: new Set(completedDraftIds),
        activeDraft: draftId ?? null,
        selectedSeat: seat,
        hideTaken: storedHideTaken !== null ? storedHideTaken !== "false" : true,
        hydrated: true,
      });
    },

    // Polling — implemented in next step
    startPolling: () => { /* Task 3 Step 5 */ },
    stopPolling: () => { /* Task 3 Step 5 */ },
    refreshNow: async () => { /* Task 3 Step 5 */ },
    triggerSync: async () => { /* Task 3 Step 7 */ },
    patchSeatName: (seat, name) => {
      set((state) => state.board ? {
        board: { ...state.board, seatNames: { ...state.board.seatNames, [String(seat)]: name } }
      } : {});
    },
  }))
);
```

- [ ] **Step 4: Run selection tests**

```bash
pnpm test src/app/stores/draftStore.test.ts
```

Expected: PASS for selection tests.

- [ ] **Step 5: Write tests for polling logic**

Add tests for:
- `startPolling` triggers fetch of `/api/drafts/{id}/live` and `/api/sync-status`
- `stopPolling` clears interval
- `refreshNow` fetches immediately
- `dataVersion` increments when `latestPickN` changes
- `dataVersion` increments when `seatNames` changes
- `dataVersion` increments when `lastSyncedAt` changes
- `dataVersion` does NOT increment when poll returns same data

Use `vi.useFakeTimers()` and `vi.spyOn(globalThis, 'fetch')`.

- [ ] **Step 6: Implement polling logic**

Port logic from `useLiveDraftStatus.ts` (lines 35-51) and `useSyncStatus.ts` (lines 36-53). Key changes:
- Single 10s interval (was 3s/15s for status, 10s for sync)
- Fetch `/api/drafts/{id}/live` instead of separate `/status` and `/board`
- Compare `latestPickN`, `seatNames`, `lastSyncedAt` against refs
- Increment `dataVersion` only when data actually changes

```typescript
// Module-scoped polling state
let pollInterval: ReturnType<typeof setInterval> | null = null;
let prevPickN = 0;
let prevSeatNamesKey = "";
let prevSyncedAt = "0";

// Extracted as module-scoped function so both startPolling and refreshNow can call it
async function executePollCycle() {
  const { activeDraft: draftId } = useDraftStore.getState();
  if (!draftId) return;
  try {
    const [liveRes, syncRes] = await Promise.all([
      fetch(`/api/drafts/${draftId}/live`),
      fetch("/api/sync-status"),
    ]);
    let changed = false;
    if (liveRes.ok) {
      const data = await liveRes.json();
      // The /live response is flat — extract status and board views from it
      const status: LiveDraftStatus = {
        phase: data.phase, latestPickN: data.latestPickN, nextSeat: data.nextSeat,
        recentPicks: data.recentPicks, seatNames: data.seatNames, numSeats: data.numSeats,
        picksPerPlayer: data.picksPerPlayer, matchCount: data.matchCount, totalMatches: data.totalMatches,
      };
      const board: BoardData = {
        picks: data.picks, numSeats: data.numSeats, picksPerPlayer: data.picksPerPlayer,
        phase: data.phase, seatNames: data.seatNames, bannedCards: data.bannedCards,
      };
      useDraftStore.setState({ liveDraftStatus: status, board });
      if (data.latestPickN > prevPickN) { prevPickN = data.latestPickN; changed = true; }
      const seatKey = JSON.stringify(data.seatNames ?? {});
      if (prevSeatNamesKey && seatKey !== prevSeatNamesKey) changed = true;
      prevSeatNamesKey = seatKey;
    }
    if (syncRes.ok) {
      const syncData = await syncRes.json();
      if (syncData.lastSyncedAt !== prevSyncedAt && prevSyncedAt !== "0") changed = true;
      prevSyncedAt = syncData.lastSyncedAt;
      useDraftStore.setState({ syncStatus: syncData });
    }
    if (changed) useDraftStore.setState((s) => ({ dataVersion: s.dataVersion + 1 }));
  } catch { /* ignore transient errors */ }
}

// Inside the store actions:
startPolling: () => {
  const { activeDraft } = get();
  if (!activeDraft || pollInterval) return;
  executePollCycle(); // Immediate first poll
  pollInterval = setInterval(executePollCycle, 10_000);
},
stopPolling: () => {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
},
refreshNow: async () => {
  // Called on-demand (e.g., after pick submission). Reuses the same poll logic.
  await executePollCycle();
},
```

- [ ] **Step 7: Write tests for triggerSync**

Test that `triggerSync`:
- POSTs to `/api/sync`
- Sets `manualSyncInFlight` during operation
- Clears `manualSyncInFlight` on completion
- Sets `dataVersion` after successful sync
- Fires `track("sync_completed")` on success
- Fires `track("sync_failed")` on error

- [ ] **Step 8: Implement triggerSync**

Port from `useSyncStatus.ts` lines 75-111. Replace `setDataChanged(true)` with `set(s => ({ dataVersion: s.dataVersion + 1 }))`.

- [ ] **Step 9: Run all draftStore tests**

```bash
pnpm test src/app/stores/draftStore.test.ts
```

Expected: All PASS.

- [ ] **Step 10: Commit**

```bash
git add src/app/stores/draftStore.ts src/app/stores/draftStore.test.ts
git commit -m "Add useDraftStore — unified selection, polling, and sync"
```

---

### Task 4: Auto-start/stop polling on activeDraft changes

The store should self-manage polling: start when `activeDraft` is set, stop when cleared.

**Files:**
- Modify: `src/app/stores/draftStore.ts`
- Modify: `src/app/stores/draftStore.test.ts`

- [ ] **Step 1: Write test**

```typescript
it("starts polling when activeDraft is set via setActiveDraft", () => {
  useDraftStore.getState().setActiveDraft("draft-1");
  // Verify fetch was called for /api/drafts/draft-1/live
});

it("stops polling when activeDraft is cleared", () => {
  useDraftStore.getState().setActiveDraft("draft-1");
  useDraftStore.getState().setActiveDraft(null);
  // Advance timers, verify no more fetches
});
```

- [ ] **Step 2: Implement**

Add a `subscribe` call at module scope that watches `activeDraft`:

```typescript
useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    useDraftStore.getState().stopPolling();
    prevPickN = 0;
    prevSeatNamesKey = "";
    if (activeDraft) useDraftStore.getState().startPolling();
  }
);
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/draftStore.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/draftStore.ts src/app/stores/draftStore.test.ts
git commit -m "Auto-manage polling lifecycle on activeDraft changes"
```

---

## Chunk 2: Card Store

### Task 5: Build `useCardStore` — core data + fetch

**Files:**
- Create: `src/app/stores/cardStore.ts`
- Create: `src/app/stores/cardStore.test.ts`
- Reference: `src/app/hooks/useCardData.ts` (fetch logic to port)

- [ ] **Step 1: Write tests for hydration and fetch**

```typescript
// Test: hydrate sets cardData and draftStats from SSR props
// Test: fetchCardData calls /api/cards and /api/draft-stats with correct params
// Test: fetchCardData reads selectedDrafts, activeDraft, poolAsOfDraft from draftStore
// Test: fetchCardData sets isLoading during fetch
// Test: fetchCardData handles empty selectedDrafts (clears cards)
// Test: effectivePoolAsOfDraft = activeDraft ?? poolAsOfDraft
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/app/stores/cardStore.test.ts
```

- [ ] **Step 3: Implement core state + fetch**

Port fetch logic from `useCardData.ts` lines 39-85. The store reads draft selection from `useDraftStore.getState()` instead of receiving it as props:

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { isLocalClient } from "@/core/isLocal";

interface CardStoreState {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;
  // ... search, filtering, stats modal state (added in later tasks)

  fetchCardData: () => Promise<void>;
  hydrate: (initial: CardStatsResponse, draftStats: DraftStatsResponse) => void;
}

const EMPTY_CARD_DATA: CardStatsResponse = {
  cards: [], draftCount: 0, cubeCopies: {},
  draftMetadata: {}, draftIds: [], completedDraftIds: [],
  ingestionHash: "",
};

const EMPTY_DRAFT_STATS: DraftStatsResponse = {
  winRateBySeat: [], winRateByColor: [], ingestionHash: "",
};

export const useCardStore = create<CardStoreState>()(
  subscribeWithSelector((set, get) => ({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,

    hydrate: (initial, draftStats) => set({ cardData: initial, draftStats }),

    fetchCardData: async () => {
      const { selectedDrafts, activeDraft, poolAsOfDraft } = useDraftStore.getState();
      const effectivePool = activeDraft ?? poolAsOfDraft;

      if (selectedDrafts.size === 0) {
        set((s) => ({ cardData: { ...s.cardData, cards: [], draftCount: 0, cubeCopies: {} } }));
        return;
      }

      set({ isLoading: true });
      try {
        const params = new URLSearchParams();
        params.set("drafts", [...selectedDrafts].join(","));
        params.set("v", get().cardData.ingestionHash);
        if (isLocalClient()) params.set("local", "1");
        if (activeDraft) params.set("activeDraft", activeDraft);
        if (effectivePool) params.set("poolAsOfDraft", effectivePool);

        const statsParams = new URLSearchParams();
        statsParams.set("drafts", [...selectedDrafts].join(","));
        statsParams.set("v", get().cardData.ingestionHash);

        const [cardsRes, statsRes] = await Promise.all([
          fetch(`/api/cards?${params}`),
          fetch(`/api/draft-stats?${statsParams}`),
        ]);

        if (cardsRes.ok) set({ cardData: await cardsRes.json() });
        if (statsRes.ok) set({ draftStats: await statsRes.json() });
      } catch (error) {
        console.error("Failed to fetch card data:", error);
      } finally {
        set({ isLoading: false });
      }
    },
  }))
);

// Subscribe to dataVersion changes from draftStore
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => useCardStore.getState().fetchCardData()
);

// Refetch when poolAsOfDraft changes (activeDraft changes already trigger via
// dataVersion subscription — polling restarts and increments dataVersion)
useDraftStore.subscribe(
  (state) => state.poolAsOfDraft,
  () => useCardStore.getState().fetchCardData()
);
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/app/stores/cardStore.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/cardStore.ts src/app/stores/cardStore.test.ts
git commit -m "Add useCardStore — card data fetching with draftStore subscription"
```

---

### Task 6: Add search and filtering to `useCardStore`

**Files:**
- Modify: `src/app/stores/cardStore.ts`
- Modify: `src/app/stores/cardStore.test.ts`
- Reference: `src/app/hooks/useCardSearch.ts` (search logic to port)
- Reference: `src/app/hooks/useCardFiltering.ts` (filtering logic to port)
- Reference: `src/core/colorFilter.ts` (ColorFilterMode type)

- [ ] **Step 1: Write tests for search**

```typescript
// Test: setSearchQuery updates searchQuery immediately
// Test: search results computed after 500ms debounce
// Test: clearSearch resets searchQuery, colorFilter, colorFilterMode
// Test: setColorFilter updates colorFilter
// Test: setColorFilterMode updates colorFilterMode
```

- [ ] **Step 2: Write tests for derived state**

```typescript
// Test: scryfallDataMap computed from cardData.cards
// Test: cardStatsMap computed from cardData.cards
// Test: takenCardNamesSet computed from cardData.takenCards
// Test: takenCardCounts computed from cardData.takenCards
// Test: seatCardNames computed from cardData.takenCards filtered by selectedSeat
// Test: seatCardList computed from cardData.takenCards filtered by selectedSeat (ordered)
// Test: displayCards filters out banned and taken cards when hideTaken is true
// Test: displayCards includes current seat's picks even when hideTaken is true
// Test: searchFilteredCards applies search filter on top of displayCards
// Test: availableCount excludes banned and taken cards (with front-face DFC check)
// Test: drafts array built from cardData.draftIds + draftMetadata
```

- [ ] **Step 3: Implement search state and derived selectors**

Port search from `useCardSearch.ts` and filtering from `useCardFiltering.ts`.

**Memoization strategy:** Store derived state as regular state fields, recomputed via an internal `recompute()` function called at the end of every action that changes inputs (cardData, search, color filter). This is the same pattern as calling `useMemo` dependencies — but explicit. The `recompute` function replaces the `useMemo` calls that were scattered across `useCardFiltering` and PageClient.

```typescript
// Internal — not exported. Called after any state change that affects derived values.
function recompute() {
  const state = useCardStore.getState();
  const { cardData, searchQuery, colorFilter, colorFilterMode } = state;
  const { activeDraft, hideTaken, selectedSeat } = useDraftStore.getState();

  // 1. Build lookup maps (port from PageClient useMemo at lines 136-153)
  const scryfallDataMap = new Map<string, ScryCard>();
  const cardStatsMap = new Map<string, CardStats>();
  for (const card of cardData.cards) {
    if (card.scryfall) scryfallDataMap.set(card.cardName, card.scryfall);
    cardStatsMap.set(card.cardName, card);
  }

  // 2. Compute taken/seat sets (port from useCardFiltering.ts)
  const takenCardNamesSet = new Set(cardData.takenCards?.map(c => c.name) ?? []);
  const takenCardCounts = new Map<string, number>();
  for (const c of cardData.takenCards ?? []) {
    takenCardCounts.set(c.name, (takenCardCounts.get(c.name) ?? 0) + 1);
  }
  const seatPicks = cardData.takenCards?.filter(c => c.seat === selectedSeat) ?? [];
  const seatCardNames = new Set(seatPicks.map(c => c.name));
  const seatCardList = seatPicks.map(c => c.name);

  // 3. Filter display cards (port from useCardFiltering.ts displayCards logic)
  // 4. Apply search filter (port from useCardSearch.ts scryfallMatchNames logic)
  // 5. Compute availableCount, drafts array, bannedCardNamesSet

  useCardStore.setState({
    scryfallDataMap, cardStatsMap, takenCardNamesSet, takenCardCounts,
    seatCardNames, seatCardList, displayCards, searchFilteredCards,
    availableCount, drafts, bannedCardNamesSet,
  });
}

// Call recompute() at the end of: fetchCardData success, setSearchQuery debounce,
// setColorFilter, setColorFilterMode, clearSearch.
// Also subscribe to draftStore changes that affect filtering:
useDraftStore.subscribe(
  (state) => [state.activeDraft, state.hideTaken, state.selectedSeat] as const,
  () => recompute(),
  { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] }
);
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/app/stores/cardStore.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/cardStore.ts src/app/stores/cardStore.test.ts
git commit -m "Add search, filtering, and derived state to useCardStore"
```

---

### Task 7: Add card stats modal to `useCardStore`

**Files:**
- Modify: `src/app/stores/cardStore.ts`
- Modify: `src/app/stores/cardStore.test.ts`
- Reference: `src/app/hooks/useCardStats.ts` (modal fetch logic to port)

- [ ] **Step 1: Write tests**

```typescript
// Test: selectCard sets selectedCard and fetches /api/cards/stats
// Test: selectCard passes excludeDraftId when provided
// Test: clearSelectedCard resets selectedCard and cardStatsDetail
// Test: cardStatsLoading is true during fetch
```

- [ ] **Step 2: Implement**

Port fetch logic from `useCardStats.ts`. The `selectCard` action:
1. Sets `selectedCard` to the card name
2. Sets `cardStatsLoading` to true
3. Fetches `/api/cards/stats?card_name={name}&exclude_draft_id={excludeDraftId}`
4. Sets `cardStatsDetail` with the response
5. Clears `cardStatsLoading`

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/cardStore.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/cardStore.ts src/app/stores/cardStore.test.ts
git commit -m "Add card stats modal state to useCardStore"
```

---

## Chunk 3: Live Store

### Task 8: Build `useLiveStore` — auth + token

**Files:**
- Create: `src/app/stores/liveStore.ts`
- Create: `src/app/stores/liveStore.test.ts`
- Reference: `src/app/hooks/useSeatToken.ts` (token logic to port)
- Reference: `src/app/hooks/useMySeat.ts` (auth logic to port)

- [ ] **Step 1: Write tests for auth**

```typescript
// Test: initAuth reads token from localStorage (seatToken:{draftId})
// Test: initAuth reads token from URL search params
// Test: initAuth fetches /api/drafts/{id}/me with token header
// Test: initAuth sets mySeat, autoPick, displayName, autoPickMode
// Test: reset clears all state
// Test: toggleAutoPick PUTs to /api/drafts/{id}/seat-settings
// Test: updateDisplayName PUTs to /api/drafts/{id}/seat-settings
// Test: updateAutoPickMode PUTs to /api/drafts/{id}/seat-settings
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm test src/app/stores/liveStore.test.ts
```

- [ ] **Step 3: Implement auth state**

Port token logic from `useSeatToken.ts` and auth from `useMySeat.ts`:

```typescript
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";

interface LiveStoreState {
  // Auth
  token: string | null;
  mySeat: number | null;
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  displayName: string | null;
  // ... queue, float, picking, deck builder (added in later tasks)

  initAuth: (draftId: string) => Promise<void>;
  reset: () => void;
  toggleAutoPick: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  updateAutoPickMode: (mode: "resilient" | "cautious") => Promise<void>;
  refreshSettings: () => Promise<void>;
}
```

Wire up the cross-store subscription for `activeDraft` changes:

```typescript
useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    useLiveStore.getState().reset();
    if (activeDraft) useLiveStore.getState().initAuth(activeDraft);
  }
);
```

- [ ] **Step 4: Run tests**

```bash
pnpm test src/app/stores/liveStore.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Add useLiveStore — auth and token management"
```

---

### Task 9: Add queue + float to `useLiveStore`

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Modify: `src/app/stores/liveStore.test.ts`
- Reference: `src/app/hooks/usePickQueue.ts`
- Reference: `src/app/hooks/useFloatedCards.ts`

- [ ] **Step 1: Write tests**

```typescript
// Queue tests:
// Test: addToQueue PUTs to /api/drafts/{id}/queue
// Test: removeFromQueue PUTs to /api/drafts/{id}/queue
// Test: reorderQueue PUTs to /api/drafts/{id}/queue
// Test: queuedCards Map is derived from queue array
// Test: queue refetches on dataVersion change

// Float tests:
// Test: addFloat PUTs to /api/drafts/{id}/float
// Test: removeFloat DELETEs to /api/drafts/{id}/float
// Test: floatedCardsSet derived from floatedCards array
```

- [ ] **Step 2: Implement queue + float**

Port from `usePickQueue.ts` and `useFloatedCards.ts`. Add the `dataVersion` subscription for queue refetch:

```typescript
// fetchQueue is an internal store action (not in the public spec interface,
// but needed by this subscription). Add it to the store alongside addToQueue/removeFromQueue.
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => {
    const { activeDraft } = useDraftStore.getState();
    const { token } = useLiveStore.getState();
    if (activeDraft && token) {
      useLiveStore.getState().fetchQueue(activeDraft, token);
    }
  }
);
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/liveStore.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Add queue and float state to useLiveStore"
```

---

### Task 10: Add picking logic to `useLiveStore`

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Modify: `src/app/stores/liveStore.test.ts`
- Reference: `src/app/hooks/useLiveDraftPicking.ts`

- [ ] **Step 1: Write tests**

```typescript
// Test: submitPick POSTs to /api/drafts/{id}/pick with token
// Test: submitPick calls draftStore.refreshNow() on success
// Test: submitPick sets pickError on failure
// Test: isMyTurn derived from draftStore.liveDraftStatus.nextSeat === mySeat
// Test: auto-pick triggers when isMyTurn && autoPick && queuedCards.size > 0
// Test: auto-pick in cautious mode checks refreshSettings before picking
// Test: consecutivePicks tracks sequential picks by same seat
```

- [ ] **Step 2: Implement picking**

Port from `useLiveDraftPicking.ts`. Key change: `submitPick` calls `useDraftStore.getState().refreshNow()` instead of a passed-in `refreshDraftStatus` callback.

Add the auto-pick subscription:

```typescript
useDraftStore.subscribe(
  (state) => state.liveDraftStatus?.nextSeat,
  async (nextSeat) => {
    const { mySeat, autoPick, queuedCards, autoPickMode, refreshSettings } = useLiveStore.getState();
    if (nextSeat !== mySeat || !autoPick || !queuedCards.size) return;
    // Cautious mode: re-check server setting before auto-picking
    if (autoPickMode === "cautious") {
      const settings = await refreshSettings();
      if (!settings?.autoPick) return;
    }
    const firstCard = [...queuedCards.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
    if (firstCard) useLiveStore.getState().submitPick(firstCard);
  }
);
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/liveStore.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Add picking logic and auto-pick to useLiveStore"
```

---

### Task 11: Add deck builder + sync to `useLiveStore`

**Files:**
- Modify: `src/app/stores/liveStore.ts`
- Modify: `src/app/stores/liveStore.test.ts`
- Reference: `src/app/hooks/useDeckBuilder.ts`
- Reference: `src/app/hooks/useDeckBuilderSync.ts`

- [ ] **Step 1: Write tests**

```typescript
// Test: dispatchDeck dispatches deck actions (ADD_CARD, REMOVE_CARD, INIT_FROM_PICKS, SYNC_PICKS)
// Test: deck auto-saves with 1s debounce via PUT /api/drafts/{id}/deck-state
// Test: saveStatus transitions idle → saving → saved
// Test: deck syncs with picks on dataVersion change (SYNC_PICKS dispatched)
// Test: deck initializes from server on initAuth (GET /api/drafts/{id}/deck-state)
```

- [ ] **Step 2: Implement deck builder**

Port from `useDeckBuilder.ts` and `useDeckBuilderSync.ts`. The existing hook uses a `useReducer` pattern with a `deckReducer(state, action)` function.

**Reducer → Zustand mapping:** Keep the existing `deckReducer` function as a pure function. The store's `dispatchDeck` action calls the reducer and `set`s the result:

```typescript
// Import the existing reducer (extract to a shared file if needed)
import { deckReducer } from "./deckReducer"; // or inline

dispatchDeck: (action: DeckAction) => {
  const newState = deckReducer(get().deckState, action);
  set({ deckState: newState });
  // Trigger debounced auto-save
  scheduleSave();
},
```

The auto-save debounce (1s) uses a module-scoped `setTimeout` pattern, same as the polling. On unmount/reset, call `navigator.sendBeacon` for best-effort sync (port from `useDeckBuilder.ts`).

The sync logic reads `seatCardList` from `useCardStore.getState()` and dispatches `SYNC_PICKS` when `dataVersion` changes.

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/liveStore.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git commit -m "Add deck builder and sync to useLiveStore"
```

---

## Chunk 4: Cross-Store Selectors + Hydration + PageClient Migration

### Task 12: Create cross-store selectors

**Files:**
- Create: `src/app/stores/selectors.ts`
- Create: `src/app/stores/selectors.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// Test: getCardStatus returns "picked" for seat's cards
// Test: getCardStatus returns "queued" with position for queued cards (when authed)
// Test: getCardStatus returns "floated" for floated cards (when authed)
// Test: getCardStatus returns "taken" for other seats' cards
// Test: getCardStatus returns "none" for available cards
// Test: getCardStatus hides queue/float when not authed
// Test: getImageUrl returns scryfall image URI from cardStore
```

- [ ] **Step 2: Implement selectors**

```typescript
// src/app/stores/selectors.ts
import { useCardStore } from "./cardStore";
import { useLiveStore } from "./liveStore";
import { useDraftStore } from "./draftStore";
import type { CardStatusResult } from "@/core/cardStatus";

export function getCardStatus(cardName: string): CardStatusResult {
  // Read from both stores — same logic as current PageClient.getCardStatus
  const cardState = useCardStore.getState();
  const liveState = useLiveStore.getState();
  const selectedSeat = useDraftStore.getState().selectedSeat;
  const isAuthed = liveState.mySeat !== null && liveState.mySeat === selectedSeat;

  if (cardState.seatCardNames?.has(cardName)) return { status: "picked" };
  if (isAuthed) {
    const queuePriority = liveState.queuedCards.get(cardName);
    if (queuePriority != null) return { status: "queued", queuePosition: queuePriority };
    if (liveState.floatedCardsSet.has(cardName)) return { status: "floated" };
  }
  if (cardState.takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}

export function getImageUrl(cardName: string | null): string | undefined {
  if (!cardName) return undefined;
  return useCardStore.getState().scryfallDataMap.get(cardName)?.imageUri;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/app/stores/selectors.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/app/stores/selectors.ts src/app/stores/selectors.test.ts
git commit -m "Add cross-store selectors: getCardStatus, getImageUrl"
```

---

### Task 13: Create `useHydration` hook

**Files:**
- Create: `src/app/stores/hydration.ts`

- [ ] **Step 1: Implement hydration hook**

```typescript
// src/app/stores/hydration.ts
import { useEffect, useRef } from "react";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";

export function useHydration(
  initialCardData: CardStatsResponse,
  initialDraftStats: DraftStatsResponse,
  initialDraftId?: string,
) {
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    useDraftStore.getState().hydrate({
      completedDraftIds: initialCardData.completedDraftIds,
      initialDraftId,
    });
    useCardStore.getState().hydrate(initialCardData, initialDraftStats);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/stores/hydration.ts
git commit -m "Add useHydration hook for SSR → store bridge"
```

---

### Task 14: Migrate PageClient to use stores

This is the largest single task. PageClient goes from ~450 lines with 17 hooks to ~100 lines with store imports.

**Files:**
- Modify: `src/app/components/PageClient.tsx`
- Modify: `src/app/components/PageClient.test.tsx`
- Modify: `src/app/hooks/useSharedDeckLoader.ts` (update to use store actions)

- [ ] **Step 1: Update PageClient to import stores**

Replace all hook instantiations with store imports. The structure becomes:

```tsx
export function PageClient({ initialCardData, initialDraftStats, initialDraftId }: PageClientProps) {
  useHydration(initialCardData, initialDraftStats, initialDraftId);

  const activeDraft = useDraftStore(s => s.activeDraft);
  const selectedSeat = useDraftStore(s => s.selectedSeat);
  const mySeat = useLiveStore(s => s.mySeat);

  const modals = useModalManagement({ activeDraft, selectedSeat });
  useScrollLock(modals.deckBuilderModalOpen);
  useSharedDeckLoader();

  // Auto-select seat when mySeat resolves
  useEffect(() => {
    if (mySeat !== null && selectedSeat === null) {
      useDraftStore.getState().setSelectedSeat(mySeat);
    }
  }, [mySeat, selectedSeat]);

  // Page load tracking
  const cardCount = useCardStore(s => s.cardData.cards.length);
  const pageLoadTracked = useRef(false);
  useEffect(() => {
    if (!pageLoadTracked.current && cardCount > 0) {
      pageLoadTracked.current = true;
      track("page_load", { duration_ms: Math.round(performance.now()), card_count: cardCount });
    }
  }, [cardCount]);

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* ... same JSX structure, but components now import stores directly */}
    </div>
  );
}
```

- [ ] **Step 2: Update child components to import stores**

Each component that previously received props from PageClient now imports stores directly. For each component, remove the props that came from hooks and replace with store selectors:

- **`CardTable.tsx`** — Remove props: `cards`, `getCardStatus`, `getImageUrl`, `isLoading`, `cubeCopies`, `takenCardCounts`, `onCardClick`. Replace with: `useCardStore(s => s.searchFilteredCards)`, `useCardStore(s => s.isLoading)`, `useCardStore(s => s.displayedCubeCopies)`, `useCardStore(s => s.takenCardCounts)`. Import `getCardStatus` and `getImageUrl` from `stores/selectors.ts`. Card click calls `useCardStore.getState().selectCard(name)`.

- **`Settings.tsx`** — Remove props: `drafts`, `selectedDrafts`, `activeDraft`, `selectedSeat`, `hideTaken`, `syncStatus`, `onDraftsChange`, `onActiveDraftChange`, `onSeatChange`, `onHideTakenChange`, `onSync`, `mySeat`, `autoPick`, `displayName`, `autoPickMode`, `toggleAutoPick`, `updateDisplayName`, `updateAutoPickMode`. Replace with: `useDraftStore` selectors for selection/sync, `useLiveStore` selectors for auth/settings. Actions call store methods directly.

- **`CardStatsModal.tsx`** — Remove props: `selectedCard`, `onClose`, `cardStatsData`, `loading`. Replace with: `useCardStore(s => s.selectedCard)`, `useCardStore(s => s.cardStatsDetail)`, `useCardStore(s => s.cardStatsLoading)`. Close calls `useCardStore.getState().clearSelectedCard()`.

- **`DraftBoardModal.tsx`** — Remove props: `board`, `liveDraftStatus`, `draftBoard`. Replace with: `useDraftStore(s => s.board)`, `useDraftStore(s => s.liveDraftStatus)`.

- **`DeckBuilderPanel.tsx`** — Remove props: `state`, `dispatch`, `ready`, `saveStatus`, `scryfallDataMap`, `cardStatsMap`. Replace with: `useLiveStore` selectors for deck state, `useCardStore(s => s.scryfallDataMap)`, `useCardStore(s => s.cardStatsMap)`.

- **`ColorFilter.tsx`** — Remove props: `colorFilter`, `setColorFilter`, `colorFilterMode`, `setColorFilterMode`. Replace with: `useCardStore` selectors and actions.

- [ ] **Step 3: Update useSharedDeckLoader**

Currently receives `{ setActiveDraft, setSelectedSeat, dispatch, setDeckBuilderActive, setDeckBuilderModalOpen }` as props. Update to take no props and call store actions directly:

```typescript
export function useSharedDeckLoader() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deckId = params.get("deck");
    if (!deckId) return;
    // Fetch shared deck snapshot
    fetch(`/api/deck/${deckId}`).then(async (res) => {
      if (!res.ok) return;
      const data = await res.json();
      useDraftStore.getState().setActiveDraft(data.draftId);
      useDraftStore.getState().setSelectedSeat(data.seat);
      useLiveStore.getState().dispatchDeck({ type: "LOAD_SNAPSHOT", state: data.state });
      // Open deck builder modal — use whatever modal management pattern survives
    });
  }, []);
}
```

Read the existing `useSharedDeckLoader.ts` for the exact URL param names and fetch logic — the above is the structural pattern, not the exact code.

- [ ] **Step 4: Update PageClient test**

Update `src/app/components/PageClient.test.tsx` to mock stores instead of hooks.

- [ ] **Step 5: Run all tests**

```bash
pnpm test
```

Expected: PASS — existing component tests may need mock updates.

- [ ] **Step 6: Run quality checks**

```bash
pnpm typecheck && pnpm lint
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/components/ src/app/hooks/useSharedDeckLoader.ts src/app/stores/
git commit -m "Migrate PageClient and components to use Zustand stores"
```

---

### Task 15: Delete old hooks and API routes

**Files:**
- Delete: All hook files listed in the "Deleted Files" section above (15 hook files + their test files)
- Delete: `src/app/api/drafts/[id]/status/` directory
- Delete: `src/app/api/drafts/[id]/board/` directory

- [ ] **Step 1: Delete absorbed hook files**

```bash
rm src/app/hooks/useDraftSelection.ts src/app/hooks/useDraftSelection.test.ts
rm src/app/hooks/useSyncStatus.ts
rm src/app/hooks/useLiveDraftStatus.ts
rm src/app/hooks/useCardData.ts
rm src/app/hooks/useCardSearch.ts src/app/hooks/useCardSearch.test.ts
rm src/app/hooks/useCardFiltering.ts src/app/hooks/useCardFiltering.test.ts
rm src/app/hooks/useCardStats.ts src/app/hooks/useCardStats.test.ts
rm src/app/hooks/useSeatToken.ts src/app/hooks/useSeatToken.test.ts
rm src/app/hooks/useMySeat.ts src/app/hooks/useMySeat.test.ts
rm src/app/hooks/usePickQueue.ts src/app/hooks/usePickQueue.test.ts
rm src/app/hooks/useFloatedCards.ts src/app/hooks/useFloatedCards.test.ts
rm src/app/hooks/useLiveDraftPicking.ts src/app/hooks/useLiveDraftPicking.test.ts
rm src/app/hooks/useDeckBuilder.ts src/app/hooks/useDeckBuilder.test.ts
rm src/app/hooks/useDeckBuilderSync.ts src/app/hooks/useDeckBuilderSync.test.ts
```

- [ ] **Step 2: Delete old API routes**

```bash
rm -r src/app/api/drafts/\[id\]/status
rm -r src/app/api/drafts/\[id\]/board
```

- [ ] **Step 3: Move types that were defined in deleted hooks**

`LiveDraftStatus` and `BoardData` are currently defined in `useLiveDraftStatus.ts`. `QueueEntry` is in `usePickQueue.ts`. Move these into the store that owns them:
- `LiveDraftStatus`, `BoardData` → `src/app/stores/draftStore.ts` (exported)
- `QueueEntry` → `src/app/stores/liveStore.ts` (exported)

Update all imports that referenced the old hook locations. `pnpm typecheck` will catch any missed imports.

- [ ] **Step 4: Run full quality suite**

```bash
pnpm precommit
```

Expected: typecheck, lint, knip, tests, e2e all pass. Knip specifically should show no unused exports from deleted files.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Remove absorbed hooks and replaced API routes

15 hooks replaced by 3 Zustand stores. /status and /board
routes replaced by unified /live endpoint."
```

---

## Chunk 5: Server-Side Consolidation

### Task 16: Thread opt-outs through route handlers

**Files:**
- Modify: `src/core/db/queries/picks.ts` — `getPicks`, `getStandings`
- Modify: `src/core/db/queries/pool.ts` — `getDraftPool`
- Modify: `src/core/db/queries/decklists.ts` — `getCardPlayStats`, `getCardWinStats`, `getWinningDecksByColor`
- Modify: Route handlers that call multiple of these functions for the same draft

- [ ] **Step 1: Add optional optedOutSeats parameter**

For each function, add `optedOutSeats?: Set<number>` to the params type. If provided, skip the internal `getOptedOutSeats` call:

```typescript
// In getPicks:
const optedOut = params.optedOutSeats ?? await getOptedOutSeats(params.draft_id);
```

Apply to: `getPicks` (picks.ts:36), `getStandings` (picks.ts:268), `getDraftPool` (pool.ts:143), `getCardPlayStats` (decklists.ts:30), `getCardWinStats`, `getWinningDecksByColor`.

- [ ] **Step 2: Update route handlers to pass through**

The following route handlers call multiple query functions for the same draft and should thread opt-outs:

- `src/app/api/drafts/[id]/picks/route.ts` — calls `getPicks`
- `src/app/api/drafts/[id]/standings/route.ts` — calls `getStandings`
- `src/app/api/drafts/[id]/pool/route.ts` — calls `getDraftPool`
- `src/app/api/cards/stats/route.ts` — calls `getCardPlayStats` + `getCardWinStats` (same draft)
- `src/app/api/decks/winning/route.ts` — calls `getWinningDecksByColor`

For routes that call only one of these functions, the threading saves nothing (the function fetches opt-outs internally). Focus on routes that call 2+ of the affected functions for the same draft_id.

```typescript
// Example in a route handler that calls multiple affected functions:
const optedOutSeats = await getOptedOutSeats(draftId);
const [picks, standings] = await Promise.all([
  getPicks({ ...params, optedOutSeats }),
  getStandings({ ...params, optedOutSeats }),
]);
```

- [ ] **Step 3: Run tests**

```bash
pnpm test
```

Expected: PASS — all existing behavior preserved, just fewer redundant queries.

- [ ] **Step 4: Commit**

```bash
git add src/core/db/queries/ src/app/api/
git commit -m "Thread opt-out seats through route handlers to eliminate redundant queries"
```

---

### Task 17: Consolidate `getCardStats` sub-queries

**Files:**
- Modify: `src/core/db/queries/stats/cardStats.ts`
- Reference: `src/core/db/queries/stats/pickStats.ts`
- Reference: `src/core/db/queries/stats/pickHistory.ts`
- Reference: `src/core/db/queries/decklists.ts`

- [ ] **Step 1: Audit current query flow**

Read `src/core/db/queries/stats/cardStats.ts` to understand the current flow. Note: `getCardStats` already resolves the card once (line ~80) and passes `card_id` to most sub-queries. However, `getPickHistory` and `getColorPairBreakdown` receive `card.name` and may re-resolve internally — check if they do. Also check if `pickStats.ts:getCardPickStats` does its own `resolveCard` call.

- [ ] **Step 2: Ensure card_id is threaded everywhere**

If any sub-query (`getPickHistory`, `getColorPairBreakdown`, `getCardPickStats`) re-resolves the card name, update it to accept `card_id` directly and skip the redundant resolution.

- [ ] **Step 3: Merge play stats + win stats query**

`getCardPlayStats` and `getCardWinStats` (both in `src/core/db/queries/decklists.ts`) are called separately. Combine into a single query joining `deck_cards` with `match_events` to get both play rate and win rate in one pass. Target: 2 queries → 1.

- [ ] **Step 4: Run tests**

```bash
pnpm test src/core/db/queries
```

Expected: PASS — same results, fewer queries.

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/
git commit -m "Consolidate card stats sub-queries — thread card_id, merge play+win stats"
```

---

### Task 18: Batch processPick seat queries

**Files:**
- Modify: `src/core/processPick.ts`
- Modify: `src/core/db/queries/seatTokens.ts` (add `getAllSeatSettings`)

- [ ] **Step 1: Add getAllSeatSettings query**

```typescript
// In src/core/db/queries/seatTokens.ts
export async function getAllSeatSettings(
  client: Client,
  draftId: string,
): Promise<Map<number, { autoPick: boolean; autoPickMode: string; displayName: string | null }>> {
  const result = await client.execute({
    sql: "SELECT seat, auto_pick, auto_pick_mode, display_name FROM seat_tokens WHERE draft_id = ?",
    args: [draftId],
  });
  const map = new Map();
  for (const row of result.rows) {
    map.set(row.seat as number, {
      autoPick: row.auto_pick === 1,
      autoPickMode: (row.auto_pick_mode as string) ?? "resilient",
      displayName: row.display_name as string | null,
    });
  }
  return map;
}
```

- [ ] **Step 2: Update processPick to use batch query**

Replace the per-seat `getSeatSettings` calls in the cascade loop (processPick.ts:~138-144) with a single `getAllSeatSettings` call before the loop:

```typescript
const allSettings = await getAllSeatSettings(client, input.draftId);
// In the loop:
const settings = allSettings.get(affectedSeat);
```

- [ ] **Step 3: Run tests**

```bash
pnpm test src/core/
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/processPick.ts src/core/db/queries/seatTokens.ts
git commit -m "Batch seat settings query in processPick auto-pick cascade"
```

---

## Chunk 6: Final Verification

### Task 19: Full verification pass

- [ ] **Step 1: Run full precommit suite**

```bash
pnpm precommit
```

Expected: typecheck, lint, knip, unit tests, e2e tests all pass.

- [ ] **Step 2: Verify no old hook imports remain**

```bash
grep -r "from.*hooks/useDraftSelection\|from.*hooks/useSyncStatus\|from.*hooks/useLiveDraftStatus\|from.*hooks/useCardData\|from.*hooks/useCardSearch\|from.*hooks/useCardFiltering\|from.*hooks/useCardStats\|from.*hooks/useSeatToken\|from.*hooks/useMySeat\|from.*hooks/usePickQueue\|from.*hooks/useFloatedCards\|from.*hooks/useLiveDraftPicking\|from.*hooks/useDeckBuilder\b" src/
```

Expected: No results.

- [ ] **Step 4: Verify no old API route references remain**

```bash
grep -r "/api/drafts/.*status\|/api/drafts/.*board" src/ --include="*.ts" --include="*.tsx" | grep -v "/api/drafts/.*live" | grep -v "sync-status" | grep -v "deck-state"
```

Expected: No results (all references point to `/live` now).

- [ ] **Step 4: Manual smoke test**

Open the dev server (`pnpm dev`) and verify:
1. Draft page loads with SSR data
2. Switching drafts updates card table
3. Setting an active draft starts 10s polling (check Network tab)
4. Card search works with debounce
5. Card stats modal opens and shows data
6. Draft board modal shows picks
7. Queue and float actions work (if you have a seat token)
8. Deck builder opens and auto-saves

- [ ] **Step 5: Commit any final fixes (if needed)**

If any fixes were needed during the smoke test:

```bash
git add <specific-files>
git commit -m "Fix issues found during final verification"
```

If all checks passed with no changes needed, skip this step.
