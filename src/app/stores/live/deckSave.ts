/**
 * Deck save action module: dispatchDeck, save machine (debounce/dirty/inFlight/pending/
 * justHydrated flags), fetchDeckState, flushDeckSave, syncDeckWithPicks,
 * setDeckBuilderActive, enterSharedView.
 *
 * All module-scoped mutable flags are encapsulated here.
 */
import { useDraftStore } from "../draftStore";
import { useCardStore } from "../cardStore";
import { computeMyDeckCardNames } from "../computeMyDeckCardNames";
import {
  deckReducer,
  createEmptyDeckState,
} from "@/core/deckBuilder";
import type { DeckAction } from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";
import type { SetState, GetState } from "../liveStore";

// ---------------------------------------------------------------------------
// Module-scoped refs for deck save debounce + shared-view sequencing
// ---------------------------------------------------------------------------

// Set to true by enterSharedView before calling setActiveDraft so the
// activeDraft subscription can tell that the draft switch is for shared-deck
// viewing and must NOT reset viewingSharedDeck back to false.
let enteringSharedView = false;

let deckDirty = false;
let deckInFlight = false;
let deckPendingSave = false;
let deckSaveTimer: ReturnType<typeof setTimeout> | null = null;
let justHydrated = false;

let syncDeckTimer: ReturnType<typeof setTimeout> | null = null;

const DECK_SAVE_DEBOUNCE_MS = 1000;
const DECK_SAVE_STATUS_RESET_MS = 2000;

// ---------------------------------------------------------------------------
// Exported flag accessors (for wiring.ts subscriptions and activeDraft handler)
// ---------------------------------------------------------------------------

export function getEnteringSharedView(): boolean {
  return enteringSharedView;
}

// ---------------------------------------------------------------------------
// Reset — called on draft switch
// ---------------------------------------------------------------------------

export function resetDeckSaveState(): void {
  deckDirty = false;
  deckInFlight = false;
  deckPendingSave = false;
  justHydrated = false;
  if (deckSaveTimer) {
    clearTimeout(deckSaveTimer);
    deckSaveTimer = null;
  }
  if (syncDeckTimer) {
    clearTimeout(syncDeckTimer);
    syncDeckTimer = null;
  }
}

// ---------------------------------------------------------------------------
// flushDeckSave — the actual HTTP PUT
// ---------------------------------------------------------------------------

async function flushDeckSave(
  scheduledForDraft: string,
  getLiveStore: () => { getState: GetState; setState: SetState },
): Promise<void> {
  const { seatToken, deckState } = getLiveStore().getState();
  const activeDraft = useDraftStore.getState().activeDraft;
  if (activeDraft !== scheduledForDraft) return;
  if (!seatToken || !activeDraft || !deckDirty || deckInFlight) return;

  deckInFlight = true;
  getLiveStore().setState({ deckSaveStatus: "saving" });

  try {
    const res = await fetch(`/api/drafts/${activeDraft}/deck-state`, {
      method: "PUT",
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deckState),
    });
    if (res.ok) {
      deckDirty = false;
      getLiveStore().setState({ deckSaveStatus: "saved" });
      setTimeout(() => {
        if (getLiveStore().getState().deckSaveStatus === "saved") {
          getLiveStore().setState({ deckSaveStatus: "idle" });
        }
      }, DECK_SAVE_STATUS_RESET_MS);
    } else {
      getLiveStore().setState({ deckSaveStatus: "idle" });
    }
  } catch {
    getLiveStore().setState({ deckSaveStatus: "idle" });
    setTimeout(() => {
      if (deckDirty) void flushDeckSave(scheduledForDraft, getLiveStore);
    }, 5000);
  }

  deckInFlight = false;

  if (deckPendingSave) {
    deckPendingSave = false;
    await flushDeckSave(scheduledForDraft, getLiveStore);
  }
}

// ---------------------------------------------------------------------------
// scheduleDeckSave
// ---------------------------------------------------------------------------

function scheduleDeckSave(getLiveStore: () => { getState: GetState; setState: SetState }): void {
  if (deckInFlight) {
    deckPendingSave = true;
    return;
  }
  const draftIdAtSchedule = useDraftStore.getState().activeDraft ?? "";
  if (deckSaveTimer) clearTimeout(deckSaveTimer);
  deckSaveTimer = setTimeout(() => {
    deckSaveTimer = null;
    void flushDeckSave(draftIdAtSchedule, getLiveStore);
  }, DECK_SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// syncDeckWithPicks — called by subscriptions in liveStore.ts
// ---------------------------------------------------------------------------

export function makeSyncDeckWithPicks(get: GetState) {
  return (): void => {
    const { deckBuilderActive, deckReady, dispatchDeck, mySeat, floatedCards, queue, viewingSharedDeck } = get();
    const { scryfallDataMap, seatCardList } = useCardStore.getState();
    const { selectedSeat } = useDraftStore.getState();

    if (!deckBuilderActive || !deckReady || viewingSharedDeck) return;

    const isAuthed = mySeat !== null && mySeat === selectedSeat;
    const canonicalCards = computeMyDeckCardNames({
      picks: seatCardList ?? [],
      isAuthed,
      floatedCards,
      queue,
    });

    dispatchDeck({
      type: "REBUILD",
      canonicalCards,
      scryfallData: scryfallDataMap,
    });
  };
}

export function makeDebouncedSyncDeckWithPicks(syncDeckWithPicks: () => void) {
  return (): void => {
    if (syncDeckTimer) clearTimeout(syncDeckTimer);
    syncDeckTimer = setTimeout(syncDeckWithPicks, 50);
  };
}

// ---------------------------------------------------------------------------
// Action factory functions
// ---------------------------------------------------------------------------

export function makeDispatchDeck(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; setState: SetState },
) {
  return (action: DeckAction): void => {
    if (action.type === "INIT_FROM_SNAPSHOT") {
      const prev = get().deckState;
      const next = deckReducer(prev, action);
      if (next !== prev) set({ deckState: next });
      justHydrated = true;
      return;
    }

    if (action.type === "REBUILD" && justHydrated) {
      justHydrated = false;
      const prev = get().deckState;
      const next = deckReducer(prev, action);
      if (next !== prev) set({ deckState: next });
      return;
    }

    const prev = get().deckState;
    const next = deckReducer(prev, action);
    if (next === prev) return;
    set({ deckState: next });

    if (get().viewingSharedDeck) return;

    if (justHydrated) {
      justHydrated = false;
    }

    deckDirty = true;
    scheduleDeckSave(getLiveStore);
  };
}

export function makeSetDeckBuilderActive(set: SetState) {
  return (active: boolean): void => {
    set({ deckBuilderActive: active });
  };
}

export function makeEnterSharedView(get: GetState) {
  return (draftId: string, seat: number, sharedDeckState: DeckState): void => {
    enteringSharedView = true;
    try {
      useDraftStore.getState().setActiveDraft(draftId);
      useDraftStore.getState().setSelectedSeat(seat);
    } finally {
      enteringSharedView = false;
    }
    get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot: sharedDeckState });
  };
}

export function makeFetchDeckState(set: SetState, get: GetState) {
  return async (): Promise<void> => {
    if (get().viewingSharedDeck) return;
    const { seatToken } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!activeDraft) return;

    if (seatToken) {
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/deck-state`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (res.ok) {
          const snapshot = await res.json();
          const mySeat = get().mySeat ?? useDraftStore.getState().selectedSeat;
          const identifiedSnapshot = {
            ...snapshot,
            draftId: activeDraft,
            seat: mySeat ?? snapshot.seat,
          };
          get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot: identifiedSnapshot });
        } else {
          const mySeat = get().mySeat ?? useDraftStore.getState().selectedSeat;
          const emptyDeck = createEmptyDeckState(activeDraft, mySeat ?? 0);
          get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot: emptyDeck });
        }
      } catch {
        // Network error — stay with empty state
      }
    }

    deckDirty = false;
    set({ deckReady: true });
  };
}
