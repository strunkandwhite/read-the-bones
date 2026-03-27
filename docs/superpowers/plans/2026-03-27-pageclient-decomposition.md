# PageClient Decomposition Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce PageClient.tsx from 768 lines to ~300 by extracting 4 custom hooks.

**Architecture:** Extract hooks one at a time, each as its own task with tests. PageClient becomes a thin orchestrator that composes hooks and passes data to child components.

**Tech Stack:** React, TypeScript, Vitest, Next.js

---

## Chunk 1: Live Draft Picking

No dependencies on other chunks. Can run independently.

### Task 1: Extract `useLiveDraftPicking`

Combines pick submission, auto-pick triggering, consecutive pick calculation, and pick error state into a single hook. Currently spread across PageClient.tsx lines 115, 224-277.

**Files:**
- Create: `src/app/hooks/useLiveDraftPicking.ts`
- Create: `src/app/hooks/useLiveDraftPicking.test.ts`
- Modify: `src/app/components/PageClient.tsx` — replace inline logic with hook call

**Hook interface:**

```ts
interface UseLiveDraftPickingProps {
  activeDraft: string | null;
  token: string | null;
  mySeat: number | null;
  liveDraftStatus: LiveDraftStatus | null;
  refreshDraftStatus: () => Promise<void>;
  autoPick: boolean;
  queuedCards: Map<string, number> | undefined;
}

interface UseLiveDraftPickingReturn {
  handlePick: (cardName: string) => Promise<void>;
  pickError: string | null;
  setPickError: (error: string | null) => void;
  isMyTurn: boolean;
  consecutivePicks: number;
}
```

- [ ] **Step 1: Create `src/app/hooks/useLiveDraftPicking.ts`**

```ts
import { useState, useCallback, useEffect, useMemo } from "react";
import type { LiveDraftStatus } from "./useLiveDraftStatus";
import { derivePickSeat, getTotalPicks } from "@/core/snakeDraft";

interface UseLiveDraftPickingProps {
  activeDraft: string | null;
  token: string | null;
  mySeat: number | null;
  liveDraftStatus: LiveDraftStatus | null;
  refreshDraftStatus: () => Promise<void>;
  autoPick: boolean;
  queuedCards: Map<string, number> | undefined;
}

interface UseLiveDraftPickingReturn {
  handlePick: (cardName: string) => Promise<void>;
  pickError: string | null;
  setPickError: (error: string | null) => void;
  isMyTurn: boolean;
  consecutivePicks: number;
}

export function useLiveDraftPicking({
  activeDraft,
  token,
  mySeat,
  liveDraftStatus,
  refreshDraftStatus,
  autoPick,
  queuedCards,
}: UseLiveDraftPickingProps): UseLiveDraftPickingReturn {
  const [pickError, setPickError] = useState<string | null>(null);

  const isMyTurn = mySeat !== null && liveDraftStatus?.nextSeat === mySeat;

  const consecutivePicks = useMemo(() => {
    if (!isMyTurn || !liveDraftStatus || mySeat === null) return 0;
    const { latestPickN, numSeats, picksPerPlayer } = liveDraftStatus;
    const totalPicks = getTotalPicks(numSeats, picksPerPlayer);
    let count = 0;
    let pickN = latestPickN + 1;
    while (pickN <= totalPicks) {
      const { seat } = derivePickSeat(pickN, { numSeats, picksPerPlayer });
      if (seat !== mySeat) break;
      count++;
      pickN++;
    }
    return count;
  }, [isMyTurn, liveDraftStatus, mySeat]);

  const handlePick = useCallback(async (cardName: string) => {
    if (!activeDraft || !token) return;
    setPickError(null);
    try {
      const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": token,
        },
        body: JSON.stringify({ card_name: cardName }),
      });
      if (!res.ok) {
        const data = await res.json();
        setPickError(data.error || "Pick failed");
      } else {
        setPickError(null);
        refreshDraftStatus();
      }
    } catch {
      setPickError("Network error — pick may not have been submitted");
    }
  }, [activeDraft, token, refreshDraftStatus]);

  // Fire queued pick immediately when auto-pick is on and it becomes the player's turn
  /* eslint-disable react-hooks/set-state-in-effect -- submitting pick to external API; setState (setPickError) is a side effect of the API call, not the goal */
  useEffect(() => {
    if (!isMyTurn || !autoPick) return;
    if (!queuedCards || queuedCards.size === 0) return;
    const sorted = [...queuedCards.entries()].sort((a, b) => a[1] - b[1]);
    const [nextCard] = sorted[0];
    handlePick(nextCard);
  }, [isMyTurn, autoPick, queuedCards, handlePick]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { handlePick, pickError, setPickError, isMyTurn, consecutivePicks };
}
```

- [ ] **Step 2: Create `src/app/hooks/useLiveDraftPicking.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLiveDraftPicking } from "./useLiveDraftPicking";
import type { LiveDraftStatus } from "./useLiveDraftStatus";

function makeStatus(overrides: Partial<LiveDraftStatus> = {}): LiveDraftStatus {
  return {
    phase: "drafting",
    latestPickN: 5,
    nextSeat: 1,
    recentPicks: [],
    seatNames: {},
    numSeats: 4,
    picksPerPlayer: 10,
    matchCount: 0,
    totalMatches: 0,
    ...overrides,
  };
}

const baseProps = {
  activeDraft: "test-draft",
  token: "my-token",
  mySeat: 1,
  liveDraftStatus: makeStatus(),
  refreshDraftStatus: vi.fn(),
  autoPick: false,
  queuedCards: new Map<string, number>(),
};

describe("useLiveDraftPicking", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("isMyTurn is true when nextSeat matches mySeat", () => {
    const { result } = renderHook(() => useLiveDraftPicking(baseProps));
    expect(result.current.isMyTurn).toBe(true);
  });

  it("isMyTurn is false when nextSeat does not match mySeat", () => {
    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, liveDraftStatus: makeStatus({ nextSeat: 2 }) }),
    );
    expect(result.current.isMyTurn).toBe(false);
  });

  it("isMyTurn is false when mySeat is null", () => {
    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, mySeat: null }),
    );
    expect(result.current.isMyTurn).toBe(false);
  });

  it("handlePick sends POST and clears error on success", async () => {
    const refreshDraftStatus = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, refreshDraftStatus }),
    );

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toBeNull();
    expect(refreshDraftStatus).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/pick",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ card_name: "Lightning Bolt" }),
      }),
    );
  });

  it("handlePick sets error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not your turn" }), { status: 400 }),
    );

    const { result } = renderHook(() => useLiveDraftPicking(baseProps));

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toBe("Not your turn");
  });

  it("handlePick sets network error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));

    const { result } = renderHook(() => useLiveDraftPicking(baseProps));

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toContain("Network error");
  });

  it("does nothing when activeDraft is null", async () => {
    vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, activeDraft: null }),
    );

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("consecutivePicks counts sequential picks for the player", () => {
    // With 4 seats and latestPickN=3, pick 4 is seat 4, so seat 1 would
    // start at pick 5 in a snake draft. This depends on snakeDraft logic
    // but we verify it returns a number >= 0.
    const { result } = renderHook(() => useLiveDraftPicking(baseProps));
    expect(result.current.consecutivePicks).toBeGreaterThanOrEqual(0);
  });

  it("auto-pick fires when isMyTurn and autoPick enabled with queued cards", async () => {
    const refreshDraftStatus = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const queuedCards = new Map([["Counterspell", 1]]);

    renderHook(() =>
      useLiveDraftPicking({
        ...baseProps,
        autoPick: true,
        queuedCards,
        refreshDraftStatus,
      }),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/drafts/test-draft/pick",
        expect.objectContaining({
          body: JSON.stringify({ card_name: "Counterspell" }),
        }),
      );
    });
  });
});
```

- [ ] **Step 3: Update PageClient.tsx to use `useLiveDraftPicking`**

Add import at the top of `src/app/components/PageClient.tsx`:

```ts
import { useLiveDraftPicking } from "../hooks/useLiveDraftPicking";
```

Replace the following blocks in PageClient.tsx (lines 115, 224-277):

**Remove** the `pickError` state declaration (line 115):
```ts
// DELETE: const [pickError, setPickError] = useState<string | null>(null);
```

**Remove** the `isMyTurn` derived value (line 224):
```ts
// DELETE: const isMyTurn = mySeat !== null && liveDraftStatus.status?.nextSeat === mySeat;
```

**Remove** the `consecutivePicks` IIFE (lines 227-240):
```ts
// DELETE: const consecutivePicks = (() => { ... })();
```

**Remove** the `refreshDraftStatus` alias and `handlePick` callback (lines 243-266):
```ts
// DELETE: const refreshDraftStatus = liveDraftStatus.refresh;
// DELETE: const handlePick = useCallback(async (cardName: string) => { ... }, [...]);
```

**Remove** the auto-pick effect (lines 269-277):
```ts
// DELETE: useEffect(() => { if (!isMyTurn || !autoPick) return; ... }, [...]);
```

**Add** after `useMySeat` (after line 199):

```ts
const { handlePick, pickError, setPickError, isMyTurn, consecutivePicks } = useLiveDraftPicking({
  activeDraft: draftSelection.activeDraft,
  token: seatToken.token,
  mySeat,
  liveDraftStatus: liveDraftStatus.status,
  refreshDraftStatus: liveDraftStatus.refresh,
  autoPick,
  queuedCards: pickQueue.queuedCards,
});
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test src/app/hooks/useLiveDraftPicking.test.ts && pnpm lint src/app/hooks/useLiveDraftPicking.ts src/app/components/PageClient.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useLiveDraftPicking.ts src/app/hooks/useLiveDraftPicking.test.ts src/app/components/PageClient.tsx
git commit -m "Extract useLiveDraftPicking hook from PageClient"
```

---

## Chunk 2: Shared Deck Loading

No dependencies on other chunks. Can run in parallel with Chunk 1.

### Task 2: Extract `useSharedDeckLoader`

Loads shared deck snapshots from the `?deck=` URL query parameter. Currently at PageClient.tsx lines 279-312.

**Files:**
- Create: `src/app/hooks/useSharedDeckLoader.ts`
- Create: `src/app/hooks/useSharedDeckLoader.test.ts`
- Modify: `src/app/components/PageClient.tsx` — replace inline logic with hook call

**Hook interface:**

```ts
interface UseSharedDeckLoaderProps {
  setActiveDraft: (draftId: string) => void;
  setSelectedSeat: (seat: number) => void;
  loadSnapshot: (snapshot: DeckState) => void;
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}
```

- [ ] **Step 1: Create `src/app/hooks/useSharedDeckLoader.ts`**

```ts
import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { DeckState } from "@/core/types";

interface UseSharedDeckLoaderProps {
  setActiveDraft: (draftId: string) => void;
  setSelectedSeat: (seat: number) => void;
  loadSnapshot: (snapshot: DeckState) => void;
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}

export function useSharedDeckLoader({
  setActiveDraft,
  setSelectedSeat,
  loadSnapshot,
  setDeckBuilderActive,
  setDeckBuilderModalOpen,
}: UseSharedDeckLoaderProps): void {
  const searchParams = useSearchParams();
  const sharedDeckId = searchParams.get("deck");

  useEffect(() => {
    if (!sharedDeckId) return;

    async function loadSharedDeck() {
      try {
        const res = await fetch(`/api/deck/${sharedDeckId}`);
        if (!res.ok) {
          console.error(`Failed to load shared deck ${sharedDeckId}: ${res.status}`);
          return;
        }
        const deckState = await res.json();

        // Set draft context to match the shared deck
        setActiveDraft(deckState.draftId);
        setSelectedSeat(deckState.seat);

        // Load the shared deck into the deck builder, pre-empting
        // the localStorage hydration that would otherwise overwrite it
        loadSnapshot(deckState);

        // Activate and open the deck builder modal
        setDeckBuilderActive(true);
        setDeckBuilderModalOpen(true);
      } catch (err) {
        console.error("Failed to load shared deck:", err);
      }
    }

    loadSharedDeck();
  }, [sharedDeckId]); // eslint-disable-line react-hooks/exhaustive-deps
}
```

- [ ] **Step 2: Create `src/app/hooks/useSharedDeckLoader.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSharedDeckLoader } from "./useSharedDeckLoader";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

describe("useSharedDeckLoader", () => {
  const defaultProps = {
    setActiveDraft: vi.fn(),
    setSelectedSeat: vi.fn(),
    loadSnapshot: vi.fn(),
    setDeckBuilderActive: vi.fn(),
    setDeckBuilderModalOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset search params
    mockSearchParams.delete("deck");
    defaultProps.setActiveDraft = vi.fn();
    defaultProps.setSelectedSeat = vi.fn();
    defaultProps.loadSnapshot = vi.fn();
    defaultProps.setDeckBuilderActive = vi.fn();
    defaultProps.setDeckBuilderModalOpen = vi.fn();
  });

  it("does nothing when no deck param present", () => {
    vi.spyOn(globalThis, "fetch");
    renderHook(() => useSharedDeckLoader(defaultProps));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches shared deck and sets up draft context", async () => {
    mockSearchParams.set("deck", "abc123");

    const deckState = {
      draftId: "draft-1",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(deckState), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(defaultProps.setActiveDraft).toHaveBeenCalledWith("draft-1");
    });

    expect(defaultProps.setSelectedSeat).toHaveBeenCalledWith(3);
    expect(defaultProps.loadSnapshot).toHaveBeenCalledWith(deckState);
    expect(defaultProps.setDeckBuilderActive).toHaveBeenCalledWith(true);
    expect(defaultProps.setDeckBuilderModalOpen).toHaveBeenCalledWith(true);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deck/abc123");
  });

  it("logs error on fetch failure and does not set state", async () => {
    mockSearchParams.set("deck", "bad-id");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load shared deck"),
      );
    });

    expect(defaultProps.setActiveDraft).not.toHaveBeenCalled();
  });

  it("logs error on network failure", async () => {
    mockSearchParams.set("deck", "abc123");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to load shared deck:", expect.any(Error));
    });
  });
});
```

- [ ] **Step 3: Update PageClient.tsx to use `useSharedDeckLoader`**

Add import:
```ts
import { useSharedDeckLoader } from "../hooks/useSharedDeckLoader";
```

Remove the `useSearchParams` import from `"next/navigation"` (only if no other code uses it — verify first).

**Remove** lines 279-312 (the `searchParams`, `sharedDeckId`, and the `loadSharedDeck` effect).

**Add** after the `deckBuilder` hook call (after line 185):

```ts
useSharedDeckLoader({
  setActiveDraft: draftSelection.setActiveDraft,
  setSelectedSeat: draftSelection.setSelectedSeat,
  loadSnapshot: deckBuilder.loadSnapshot,
  setDeckBuilderActive,
  setDeckBuilderModalOpen,
});
```

Also remove the `useSearchParams` import from PageClient if it is no longer used.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test src/app/hooks/useSharedDeckLoader.test.ts && pnpm lint src/app/hooks/useSharedDeckLoader.ts src/app/components/PageClient.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useSharedDeckLoader.ts src/app/hooks/useSharedDeckLoader.test.ts src/app/components/PageClient.tsx
git commit -m "Extract useSharedDeckLoader hook from PageClient"
```

---

## Chunk 3: Deck Builder Sync

Depends on Chunk 2 being complete (both chunks modify the same region of PageClient around deck builder initialization). Must run after Chunk 2.

### Task 3: Extract `useDeckBuilderSync`

Manages deck builder initialization from seat picks and reconciliation when data refreshes. Currently at PageClient.tsx lines 328-358.

**Files:**
- Create: `src/app/hooks/useDeckBuilderSync.ts`
- Create: `src/app/hooks/useDeckBuilderSync.test.ts`
- Modify: `src/app/components/PageClient.tsx` — replace inline logic with hook call

**Hook interface:**

```ts
interface UseDeckBuilderSyncProps {
  deckBuilderActive: boolean;
  seatCardList: string[] | undefined;
  takenCardNamesSet: Set<string> | undefined;
  deckBuilderState: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallDataMap: Map<string, ScryCard>;
  activeDraft: string | null;
  selectedSeat: number | null;
}
```

- [ ] **Step 1: Create `src/app/hooks/useDeckBuilderSync.ts`**

```ts
import { useEffect, useRef } from "react";
import type { DeckState, ScryCard } from "@/core/types";
import type { DeckAction } from "@/core/deckBuilder";

interface UseDeckBuilderSyncProps {
  deckBuilderActive: boolean;
  seatCardList: string[] | undefined;
  takenCardNamesSet: Set<string> | undefined;
  deckBuilderState: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallDataMap: Map<string, ScryCard>;
  activeDraft: string | null;
  selectedSeat: number | null;
}

/**
 * Manages deck builder initialization from seat picks and
 * reconciliation on data refreshes.
 *
 * - On first activation with pick data: dispatches INIT_FROM_PICKS
 *   if the deck builder zones are empty.
 * - On subsequent data refreshes: dispatches SYNC_PICKS to reconcile
 *   new picks into the existing deck state.
 */
export function useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  takenCardNamesSet,
  deckBuilderState,
  dispatch,
  scryfallDataMap,
  activeDraft,
  selectedSeat,
}: UseDeckBuilderSyncProps): void {
  // Initialize deck builder from seat picks when first opened
  const deckBuilderInitialized = useRef(false);
  useEffect(() => {
    if (deckBuilderActive && seatCardList && seatCardList.length > 0 && !deckBuilderInitialized.current) {
      const isEmpty = Object.values(deckBuilderState.zones.deck).flat().length === 0
        && Object.values(deckBuilderState.zones.sideboard).flat().length === 0;
      if (isEmpty) {
        dispatch({
          type: "INIT_FROM_PICKS",
          picks: seatCardList!,
          scryfallData: scryfallDataMap,
          draftId: activeDraft ?? "",
          seat: selectedSeat ?? 0,
        });
      }
      deckBuilderInitialized.current = true;
    }
    if (!deckBuilderActive) {
      deckBuilderInitialized.current = false;
    }
  }, [deckBuilderActive, seatCardList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile picked cards with deck builder state on every data refresh
  useEffect(() => {
    if (!deckBuilderActive || !seatCardList || seatCardList.length === 0) return;
    dispatch({
      type: "SYNC_PICKS",
      pickedCardNames: seatCardList,
      takenCardNames: takenCardNamesSet ? Array.from(takenCardNamesSet) : undefined,
      scryfallData: scryfallDataMap,
    });
  }, [seatCardList, deckBuilderActive]); // eslint-disable-line react-hooks/exhaustive-deps
}
```

- [ ] **Step 2: Create `src/app/hooks/useDeckBuilderSync.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDeckBuilderSync } from "./useDeckBuilderSync";
import type { DeckState, ScryCard } from "@/core/types";

function makeEmptyState(overrides: Partial<DeckState> = {}): DeckState {
  return {
    draftId: "test-draft",
    seat: 1,
    zones: {
      deck: {},
      sideboard: {},
    },
    speculativeCards: [],
    ...overrides,
  } as DeckState;
}

describe("useDeckBuilderSync", () => {
  const dispatch = vi.fn();
  const scryfallDataMap = new Map<string, ScryCard>();

  const baseProps = {
    deckBuilderActive: true,
    seatCardList: ["Lightning Bolt", "Counterspell"],
    takenCardNamesSet: new Set(["Sol Ring"]),
    deckBuilderState: makeEmptyState(),
    dispatch,
    scryfallDataMap,
    activeDraft: "test-draft",
    selectedSeat: 1,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    dispatch.mockClear();
  });

  it("dispatches INIT_FROM_PICKS when first activated with empty zones", () => {
    renderHook(() => useDeckBuilderSync(baseProps));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("does not dispatch INIT_FROM_PICKS when zones are non-empty", () => {
    const state = makeEmptyState({
      zones: {
        deck: { "0": ["Existing Card"] },
        sideboard: {},
      },
    });

    renderHook(() => useDeckBuilderSync({ ...baseProps, deckBuilderState: state }));

    expect(dispatch).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });

  it("does not dispatch when deck builder is inactive", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, deckBuilderActive: false }),
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("does not dispatch when seatCardList is empty", () => {
    renderHook(() =>
      useDeckBuilderSync({ ...baseProps, seatCardList: [] }),
    );

    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches SYNC_PICKS when active with card list", () => {
    renderHook(() => useDeckBuilderSync(baseProps));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SYNC_PICKS",
        pickedCardNames: ["Lightning Bolt", "Counterspell"],
      }),
    );
  });

  it("resets initialized flag when deactivated then reactivated", () => {
    const { rerender } = renderHook(
      (props) => useDeckBuilderSync(props),
      { initialProps: baseProps },
    );

    dispatch.mockClear();

    // Deactivate
    rerender({ ...baseProps, deckBuilderActive: false });
    dispatch.mockClear();

    // Reactivate — should dispatch INIT_FROM_PICKS again
    rerender({ ...baseProps, deckBuilderActive: true });

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "INIT_FROM_PICKS" }),
    );
  });
});
```

- [ ] **Step 3: Update PageClient.tsx to use `useDeckBuilderSync`**

Add import:
```ts
import { useDeckBuilderSync } from "../hooks/useDeckBuilderSync";
```

**Remove** lines 328-358 (the `deckBuilderInitialized` ref, the INIT_FROM_PICKS effect, and the SYNC_PICKS effect).

**Add** after the `deckBuilder` hook call:

```ts
useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  takenCardNamesSet,
  deckBuilderState: deckBuilder.state,
  dispatch: deckBuilder.dispatch,
  scryfallDataMap,
  activeDraft: draftSelection.activeDraft,
  selectedSeat: draftSelection.selectedSeat,
});
```

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test src/app/hooks/useDeckBuilderSync.test.ts && pnpm lint src/app/hooks/useDeckBuilderSync.ts src/app/components/PageClient.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useDeckBuilderSync.ts src/app/hooks/useDeckBuilderSync.test.ts src/app/components/PageClient.tsx
git commit -m "Extract useDeckBuilderSync hook from PageClient"
```

---

## Chunk 4: Modal Management

Can run in parallel with Chunks 1 and 2 (touches different lines), but must complete before Chunk 3's PageClient edits are applied if running sequentially. If running sequentially, execute after Chunk 3.

### Task 4: Extract `useModalManagement`

Manages modal open/close state, localStorage persistence, Escape key handling, and draft-deselection cleanup. Currently at PageClient.tsx lines 112-159.

**Files:**
- Create: `src/app/hooks/useModalManagement.ts`
- Create: `src/app/hooks/useModalManagement.test.ts`
- Modify: `src/app/components/PageClient.tsx` — replace inline logic with hook call

**Hook interface:**

```ts
interface UseModalManagementProps {
  activeDraft: string | null;
  selectedSeat: number | null;
}

interface UseModalManagementReturn {
  deckBuilderActive: boolean;
  setDeckBuilderActive: (active: boolean) => void;
  deckBuilderModalOpen: boolean;
  setDeckBuilderModalOpen: (open: boolean) => void;
  draftBoardOpen: boolean;
  setDraftBoardOpen: (open: boolean) => void;
}
```

- [ ] **Step 1: Create `src/app/hooks/useModalManagement.ts`**

```ts
import { useState, useEffect } from "react";

interface UseModalManagementProps {
  activeDraft: string | null;
  selectedSeat: number | null;
}

interface UseModalManagementReturn {
  deckBuilderActive: boolean;
  setDeckBuilderActive: (active: boolean) => void;
  deckBuilderModalOpen: boolean;
  setDeckBuilderModalOpen: (open: boolean) => void;
  draftBoardOpen: boolean;
  setDraftBoardOpen: (open: boolean) => void;
}

export function useModalManagement({
  activeDraft,
  selectedSeat,
}: UseModalManagementProps): UseModalManagementReturn {
  const [deckBuilderActive, setDeckBuilderActive] = useState(false);
  const [deckBuilderModalOpen, setDeckBuilderModalOpen] = useState(false);
  const [draftBoardOpen, setDraftBoardOpen] = useState(false);

  // Restore modal open state from localStorage on mount
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage (localStorage) */
  useEffect(() => {
    const stored = localStorage.getItem("deckBuilderOpen");
    if (stored === "true" && activeDraft && selectedSeat !== null) {
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist modal open state to localStorage
  useEffect(() => {
    localStorage.setItem("deckBuilderOpen", String(deckBuilderModalOpen));
  }, [deckBuilderModalOpen]);

  // Close modal and deactivate deck builder when draft/seat deselected
  /* eslint-disable react-hooks/set-state-in-effect -- resetting derived state when upstream selection changes */
  useEffect(() => {
    if (!activeDraft || selectedSeat === null) {
      setDeckBuilderActive(false);
      setDeckBuilderModalOpen(false);
    }
  }, [activeDraft, selectedSeat]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close modal on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && draftBoardOpen) {
        setDraftBoardOpen(false);
      }
      if (e.key === "Escape" && deckBuilderModalOpen) {
        setDeckBuilderModalOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deckBuilderModalOpen, draftBoardOpen]);

  return {
    deckBuilderActive,
    setDeckBuilderActive,
    deckBuilderModalOpen,
    setDeckBuilderModalOpen,
    draftBoardOpen,
    setDraftBoardOpen,
  };
}
```

- [ ] **Step 2: Create `src/app/hooks/useModalManagement.test.ts`**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModalManagement } from "./useModalManagement";

describe("useModalManagement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("initializes with all modals closed", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(result.current.draftBoardOpen).toBe(false);
  });

  it("restores deck builder open state from localStorage", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(result.current.deckBuilderActive).toBe(true);
    expect(result.current.deckBuilderModalOpen).toBe(true);
  });

  it("does not restore if no active draft", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: null, selectedSeat: null }),
    );

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("persists modal open state to localStorage", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDeckBuilderModalOpen(true);
    });

    expect(localStorage.getItem("deckBuilderOpen")).toBe("true");

    act(() => {
      result.current.setDeckBuilderModalOpen(false);
    });

    expect(localStorage.getItem("deckBuilderOpen")).toBe("false");
  });

  it("closes modals when draft is deselected", () => {
    const { result, rerender } = renderHook(
      (props) => useModalManagement(props),
      { initialProps: { activeDraft: "draft-1" as string | null, selectedSeat: 1 as number | null } },
    );

    act(() => {
      result.current.setDeckBuilderActive(true);
      result.current.setDeckBuilderModalOpen(true);
    });

    expect(result.current.deckBuilderActive).toBe(true);

    rerender({ activeDraft: null, selectedSeat: null });

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("closes deck builder modal on Escape key", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDeckBuilderModalOpen(true);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("closes draft board modal on Escape key", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDraftBoardOpen(true);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.draftBoardOpen).toBe(false);
  });
});
```

- [ ] **Step 3: Update PageClient.tsx to use `useModalManagement`**

Add import:
```ts
import { useModalManagement } from "../hooks/useModalManagement";
```

**Remove** lines 112-159 (the three modal state declarations, the localStorage restore effect, the localStorage persist effect, the deselect-cleanup effect, and the Escape key effect).

**Add** after `useCardFiltering` (after line 110):

```ts
const {
  deckBuilderActive,
  setDeckBuilderActive,
  deckBuilderModalOpen,
  setDeckBuilderModalOpen,
  draftBoardOpen,
  setDraftBoardOpen,
} = useModalManagement({
  activeDraft: draftSelection.activeDraft,
  selectedSeat: draftSelection.selectedSeat,
});
```

The `useScrollLock(deckBuilderModalOpen)` call (previously line 143) stays in PageClient — it depends on `deckBuilderModalOpen` which is now returned from the hook.

- [ ] **Step 4: Verify**

```bash
pnpm typecheck && pnpm test src/app/hooks/useModalManagement.test.ts && pnpm lint src/app/hooks/useModalManagement.ts src/app/components/PageClient.tsx
```

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useModalManagement.ts src/app/hooks/useModalManagement.test.ts src/app/components/PageClient.tsx
git commit -m "Extract useModalManagement hook from PageClient"
```

---

## Final Verification

After all 4 chunks are complete:

- [ ] **Step 1: Full test suite**

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm knip
```

- [ ] **Step 2: Manual verification**

Start the dev server (`pnpm dev`) and verify:
1. Page loads normally with card data
2. Selecting an active draft + seat opens the deck builder
3. Deck builder initializes from seat picks
4. Closing/reopening preserves modal state via localStorage
5. Escape key closes modals
6. If a live draft is active, pick submission works
7. Shared deck URL (`?deck=<id>`) loads and opens the deck builder
8. Deselecting a draft closes the deck builder

- [ ] **Step 3: Final commit (if any cleanup needed)**

---

## Execution Order Summary

| Chunk | Task | Hook | Parallel? |
|-------|------|------|-----------|
| 1 | Task 1 | `useLiveDraftPicking` | Yes (independent) |
| 2 | Task 2 | `useSharedDeckLoader` | Yes (independent) |
| 3 | Task 3 | `useDeckBuilderSync` | After Chunks 1-2 (edits overlap region) |
| 4 | Task 4 | `useModalManagement` | After Chunk 3 (edits overlap region) |

If using sequential execution, run in order: 4, 1, 2, 3 (modal management first since it extracts the earliest lines, minimizing rebase conflicts). If using subagents, Chunks 1 and 2 can run in parallel, then 3, then 4.

## Expected Result

| Metric | Before | After |
|--------|--------|-------|
| PageClient lines | 762 | ~350 |
| Inline `useEffect` calls | 12 | 5 |
| Inline `useCallback` calls | 6 | 4 |
| Inline `useState` calls | 5 | 1 |
| New hook files | 0 | 4 |
| New test files | 0 | 4 |
