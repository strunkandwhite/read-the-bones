import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import { getIsAuthed } from "./selectors";
import { derivePickSeat, getTotalPicks } from "@/core/snakeDraft";
import {
  deckReducer,
  createEmptyDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

export type { DeckAction };

function deriveQueuedCardCounts(queue: QueueEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of queue) {
    counts.set(e.cardName, (counts.get(e.cardName) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueEntry {
  priority: number;
  cardId: number;
  cardName: string;
}

interface LiveStoreState {
  // Auth
  seatToken: string | null;
  mySeat: number | null;
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  displayName: string | null;

  // Queue
  queue: QueueEntry[];
  queuedCardCounts: Map<string, number>;
  queueLoading: boolean;
  queueError: string | null;

  // Float
  floatedCards: string[];
  floatedCardsSet: Set<string>;

  // Picking
  pickError: string | null;
  isMyTurn: boolean;
  consecutivePicks: number;

  // Deck builder
  deckState: DeckState;
  deckReady: boolean;
  deckSaveStatus: "idle" | "saving" | "saved";
  deckBuilderActive: boolean;
  viewingSharedDeck: boolean;

  // Actions
  hydrateToken: (draftId: string) => void;
  fetchMySeat: () => Promise<void>;
  toggleAutoPick: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  updateAutoPickMode: (mode: "resilient" | "cautious") => Promise<void>;
  refreshSettings: () => Promise<void>;

  // Queue actions
  fetchQueue: () => Promise<void>;
  addToQueue: (cardName: string) => void;
  removeFromQueue: (cardName: string) => void;
  removeFromQueueByPriority: (cardName: string, priority: number) => void;
  reorderQueue: (cardNames: string[]) => void;

  // Float actions
  fetchFloatedCards: () => Promise<void>;
  addFloat: (cardName: string) => Promise<void>;
  removeFloat: (cardName: string) => Promise<void>;

  // Pick actions
  handlePick: (cardName: string) => Promise<void>;
  setPickError: (error: string | null) => void;

  // Deck builder actions
  dispatchDeck: (action: DeckAction) => void;
  setDeckBuilderActive: (active: boolean) => void;
  fetchDeckState: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helper: sync queue to server with optimistic revert
// ---------------------------------------------------------------------------

type SetState = (partial: Partial<LiveStoreState>) => void;
type GetState = () => LiveStoreState;

async function syncQueue(set: SetState, get: GetState, cardNames: string[], previousQueue?: QueueEntry[]) {
  const { seatToken } = get();
  const fallbackQueue = previousQueue ?? get().queue;
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft) return;

  set({ queueLoading: true });
  try {
    const body = cardNames.map((card_name) => ({ card_name }));
    const res = await fetch(`/api/drafts/${activeDraft}/queue`, {
      method: "PUT",
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const queue: QueueEntry[] = data.queue;
      set({
        queue,
        queuedCardCounts: deriveQueuedCardCounts(queue),
        queueError: null,
      });
    } else {
      set({
        queue: fallbackQueue,
        queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
        queueError: "Failed to sync queue",
      });
    }
  } catch {
    set({
      queue: fallbackQueue,
      queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
      queueError: "Failed to sync queue",
    });
  }
  set({ queueLoading: false });
}

// ---------------------------------------------------------------------------
// Module-scoped refs for deck save debounce
// ---------------------------------------------------------------------------

let deckDirty = false;
let deckInFlight = false;
let deckPendingSave = false;
let deckSaveTimer: ReturnType<typeof setTimeout> | null = null;
let justHydrated = false;

const DECK_SAVE_DEBOUNCE_MS = 1000;
const DECK_SAVE_STATUS_RESET_MS = 2000;

let syncDeckTimer: ReturnType<typeof setTimeout> | null = null;

export function _resetDeckState() {
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

async function flushDeckSave() {
  const { seatToken, deckState } = useLiveStore.getState();
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft || !deckDirty || deckInFlight) return;

  deckInFlight = true;
  useLiveStore.setState({ deckSaveStatus: "saving" });

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
      useLiveStore.setState({ deckSaveStatus: "saved" });
      setTimeout(() => {
        if (useLiveStore.getState().deckSaveStatus === "saved") {
          useLiveStore.setState({ deckSaveStatus: "idle" });
        }
      }, DECK_SAVE_STATUS_RESET_MS);
    }
  } catch {
    useLiveStore.setState({ deckSaveStatus: "idle" });
    // Retry in 5s if still dirty
    setTimeout(() => {
      if (deckDirty) flushDeckSave();
    }, 5000);
  }

  deckInFlight = false;

  if (deckPendingSave) {
    deckPendingSave = false;
    await flushDeckSave();
  }
}

function scheduleDeckSave() {
  if (deckInFlight) {
    deckPendingSave = true;
    return;
  }
  if (deckSaveTimer) clearTimeout(deckSaveTimer);
  deckSaveTimer = setTimeout(() => {
    deckSaveTimer = null;
    flushDeckSave();
  }, DECK_SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLiveStore = create<LiveStoreState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    seatToken: null,
    mySeat: null,
    autoPick: true,
    autoPickMode: "resilient",
    displayName: null,

    // Queue state
    queue: [],
    queuedCardCounts: new Map(),
    queueLoading: false,
    queueError: null,

    // Float state
    floatedCards: [],
    floatedCardsSet: new Set<string>(),

    // Picking state
    pickError: null,
    isMyTurn: false,
    consecutivePicks: 0,

    // Deck builder state
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
    viewingSharedDeck: false,

    // -----------------------------------------------------------------------
    // hydrateToken — reads token from URL then localStorage
    // -----------------------------------------------------------------------
    hydrateToken: (draftId: string) => {
      const url = new URL(window.location.href);
      const urlToken = url.searchParams.get("token");
      if (urlToken) {
        localStorage.setItem(`seatToken:${draftId}`, urlToken);
        url.searchParams.delete("token");
        window.history.replaceState({}, "", url.toString());
        set({ seatToken: urlToken });
      } else {
        const stored = localStorage.getItem(`seatToken:${draftId}`);
        set({ seatToken: stored });
      }
    },

    // -----------------------------------------------------------------------
    // fetchMySeat — resolves seat from token
    // -----------------------------------------------------------------------
    fetchMySeat: async () => {
      const { seatToken } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/me`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (!res.ok) return;
        const data = await res.json();
        set({
          mySeat: data.seat,
          autoPick: data.autoPick,
          displayName: data.displayName,
          autoPickMode: data.autoPickMode || "resilient",
        });
        recomputePicking();
      } catch {
        // Token invalid or network error — remain as spectator
      }
    },

    // -----------------------------------------------------------------------
    // toggleAutoPick
    // -----------------------------------------------------------------------
    toggleAutoPick: async () => {
      const { seatToken, autoPick } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      const newValue = !autoPick;
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/seat-settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Seat-Token": seatToken,
          },
          body: JSON.stringify({ auto_pick: newValue }),
        });
        if (res.ok) set({ autoPick: newValue });
      } catch {
        // ignore
      }
    },

    // -----------------------------------------------------------------------
    // updateDisplayName — optimistic update, reverts on failure
    // -----------------------------------------------------------------------
    updateDisplayName: async (name: string) => {
      const { seatToken, displayName: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      const newValue = name || null;
      set({ displayName: newValue });

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/seat-settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Seat-Token": seatToken,
          },
          body: JSON.stringify({ display_name: name }),
        });
        if (!res.ok) set({ displayName: previous });
      } catch {
        set({ displayName: previous });
      }
    },

    // -----------------------------------------------------------------------
    // updateAutoPickMode — optimistic update, reverts on failure
    // -----------------------------------------------------------------------
    updateAutoPickMode: async (mode: "resilient" | "cautious") => {
      const { seatToken, autoPickMode: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      set({ autoPickMode: mode });

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/seat-settings`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Seat-Token": seatToken,
          },
          body: JSON.stringify({ auto_pick_mode: mode }),
        });
        if (!res.ok) set({ autoPickMode: previous });
      } catch {
        set({ autoPickMode: previous });
      }
    },

    // -----------------------------------------------------------------------
    // refreshSettings — re-fetches seat settings from server
    // -----------------------------------------------------------------------
    refreshSettings: async () => {
      const { seatToken } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/me`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (!res.ok) return;
        const data = await res.json();
        set({
          autoPick: data.autoPick,
          autoPickMode: data.autoPickMode || "resilient",
        });
      } catch {
        // ignore
      }
    },

    // -----------------------------------------------------------------------
    // Queue actions
    // -----------------------------------------------------------------------
    fetchQueue: async () => {
      const { seatToken } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      set({ queueLoading: true });
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/queue`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (res.ok) {
          const data = await res.json();
          const queue: QueueEntry[] = data.queue;
          set({
            queue,
            queuedCardCounts: deriveQueuedCardCounts(queue),
            queueError: null,
          });
        }
      } catch {
        set({ queueError: "Failed to load queue" });
      }
      set({ queueLoading: false });
    },

    addToQueue: (cardName: string) => {
      const { queue: original } = get();
      // Optimistic update: add card to queue immediately
      const optimisticQueue = [...original, { priority: original.length + 1, cardId: 0, cardName }];
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      });
      const newNames = [...original.map((e) => e.cardName), cardName];
      syncQueue(set, get, newNames, original);
    },

    removeFromQueue: (cardName: string) => {
      const { queue: original } = get();
      // Remove only the highest-priority (lowest number) entry for this card
      const targetIndex = original.reduce<number | null>((best, e, i) => {
        if (e.cardName !== cardName) return best;
        if (best === null || e.priority < original[best].priority) return i;
        return best;
      }, null);
      if (targetIndex === null) return;
      const optimisticQueue = original.filter((_, i) => i !== targetIndex);
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      });
      const newNames = optimisticQueue.map((e) => e.cardName);
      syncQueue(set, get, newNames, original);
    },

    removeFromQueueByPriority: (cardName: string, priority: number) => {
      const { queue: original } = get();
      const optimisticQueue = original.filter(
        (e) => !(e.cardName === cardName && e.priority === priority)
      );
      if (optimisticQueue.length === original.length) return; // no match
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      });
      const newNames = optimisticQueue.map((e) => e.cardName);
      syncQueue(set, get, newNames, original);
    },

    reorderQueue: (cardNames: string[]) => {
      syncQueue(set, get, cardNames);
    },

    // -----------------------------------------------------------------------
    // Float actions
    // -----------------------------------------------------------------------
    fetchFloatedCards: async () => {
      const { seatToken } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/float`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (res.ok) {
          const data = await res.json();
          if (data?.cards) set({ floatedCards: data.cards, floatedCardsSet: new Set(data.cards) });
        }
      } catch {
        // ignore
      }
    },

    addFloat: async (cardName: string) => {
      const { seatToken, floatedCards: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      const next = [...previous, cardName];
      set({ floatedCards: next, floatedCardsSet: new Set(next) });
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/float`, {
          method: "PUT",
          headers: {
            "X-Seat-Token": seatToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_name: cardName }),
        });
        if (!res.ok) set({ floatedCards: previous, floatedCardsSet: new Set(previous) });
      } catch {
        set({ floatedCards: previous, floatedCardsSet: new Set(previous) });
      }
    },

    removeFloat: async (cardName: string) => {
      const { seatToken, floatedCards: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      const next = previous.filter((c) => c !== cardName);
      set({ floatedCards: next, floatedCardsSet: new Set(next) });
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/float`, {
          method: "DELETE",
          headers: {
            "X-Seat-Token": seatToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_name: cardName }),
        });
        if (!res.ok) set({ floatedCards: previous, floatedCardsSet: new Set(previous) });
      } catch {
        set({ floatedCards: previous, floatedCardsSet: new Set(previous) });
      }
    },

    // -----------------------------------------------------------------------
    // handlePick — submit a pick to the server
    // -----------------------------------------------------------------------
    handlePick: async (cardName: string) => {
      const { seatToken, autoPick } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
          method: "POST",
          headers: {
            "X-Seat-Token": seatToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_name: cardName }),
        });

        if (res.ok) {
          set({ pickError: null });
          // Remove picked card from floats (client-side cleanup)
          const { floatedCards } = get();
          if (floatedCards.includes(cardName)) {
            const updated = floatedCards.filter((c) => c !== cardName);
            set({ floatedCards: updated, floatedCardsSet: new Set(updated) });
          }
          await useDraftStore.getState().refreshNow();
        } else {
          const data = await res.json().catch(() => ({ error: "Pick failed" }));
          const errorMsg = data.error || "Pick failed";

          if (autoPick && errorMsg.includes("already been picked")) {
            // Suppress error when auto-picking — card was taken, refresh will trigger next pick
            set({ pickError: null });
            await useDraftStore.getState().refreshNow();
          } else {
            set({ pickError: errorMsg });
          }
        }
      } catch {
        set({ pickError: "Network error — pick may not have been submitted" });
      }
    },

    // -----------------------------------------------------------------------
    // setPickError
    // -----------------------------------------------------------------------
    setPickError: (error: string | null) => {
      set({ pickError: error });
    },

    // -----------------------------------------------------------------------
    // Deck builder actions
    // -----------------------------------------------------------------------
    dispatchDeck: (action: DeckAction) => {
      const prev = get().deckState;
      const next = deckReducer(prev, action);
      if (next === prev) return; // reducer returned same reference = no change
      set({ deckState: next });

      if (action.type === "INIT_FROM_SNAPSHOT") {
        justHydrated = true;
        return;
      }

      if (justHydrated) {
        justHydrated = false;
        return; // first change after hydration — skip save
      }

      deckDirty = true;
      scheduleDeckSave();
    },

    setDeckBuilderActive: (active: boolean) => {
      set({ deckBuilderActive: active });
    },

    fetchDeckState: async () => {
      if (get().viewingSharedDeck) return;
      const { seatToken } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      try {
        const res = await fetch(`/api/drafts/${activeDraft}/deck-state`, {
          headers: { "X-Seat-Token": seatToken },
        });
        if (res.ok) {
          const snapshot = await res.json();
          get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot });
        }
        // 404 = no saved state, stay with empty deck
      } catch {
        // Network error — stay with empty state
      }

      deckDirty = false;
      set({ deckReady: true });
    },
  })),
);

// ---------------------------------------------------------------------------
// Derived picking state
// ---------------------------------------------------------------------------

let autoPickInFlight = false;

async function triggerAutoPick() {
  if (autoPickInFlight) return;
  autoPickInFlight = true;
  try {
    // Re-check server-side settings before auto-picking (cautious mode may have disabled it)
    await useLiveStore.getState().refreshSettings();
    const { autoPick } = useLiveStore.getState();
    if (!autoPick) return;

    // Re-fetch queue to get latest state (a queued card may have been picked by someone else)
    await useLiveStore.getState().fetchQueue();
    const { queue } = useLiveStore.getState();
    if (queue.length === 0) return;

    // Try each queued card in priority order — if the top card was already taken,
    // handlePick suppresses the "already been picked" error, so try the next card.
    const sorted = [...queue].sort((a, b) => a.priority - b.priority);
    for (const entry of sorted) {
      const { pickError } = useLiveStore.getState();
      if (pickError) break; // real error, stop trying
      await useLiveStore.getState().handlePick(entry.cardName);
      // If no error, the pick succeeded — stop
      if (!useLiveStore.getState().pickError) break;
    }
  } finally {
    autoPickInFlight = false;
  }
}

export function recomputePicking() {
  const { mySeat, autoPick, queuedCardCounts } = useLiveStore.getState();
  const { liveDraftStatus } = useDraftStore.getState();

  const isMyTurn = mySeat !== null && liveDraftStatus?.nextSeat === mySeat;

  let consecutivePicks = 0;
  if (isMyTurn && liveDraftStatus && mySeat !== null) {
    const { latestPickN, numSeats, picksPerPlayer } = liveDraftStatus;
    const totalPicks = getTotalPicks(numSeats, picksPerPlayer);
    let pickN = latestPickN + 1;
    while (pickN <= totalPicks) {
      const { seat } = derivePickSeat(pickN, { numSeats, picksPerPlayer });
      if (seat !== mySeat) break;
      consecutivePicks++;
      pickN++;
    }
  }

  useLiveStore.setState({ isMyTurn, consecutivePicks });

  // Auto-pick trigger
  if (isMyTurn && autoPick && queuedCardCounts.size > 0) {
    triggerAutoPick();
  }
}

// ---------------------------------------------------------------------------
// Cross-store subscription: react to activeDraft changes
// ---------------------------------------------------------------------------

useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    if (activeDraft) {
      useLiveStore.getState().hydrateToken(activeDraft);
      useLiveStore.getState().fetchMySeat();
      useLiveStore.getState().fetchQueue();
      useLiveStore.getState().fetchFloatedCards();
      useLiveStore.getState().fetchDeckState();
    } else {
      _resetDeckState();
      useLiveStore.setState({
        seatToken: null,
        mySeat: null,
        autoPick: true,
        autoPickMode: "resilient",
        displayName: null,
        queue: [],
        queuedCardCounts: new Map(),
        queueLoading: false,
        queueError: null,
        floatedCards: [],
        floatedCardsSet: new Set<string>(),
        pickError: null,
        isMyTurn: false,
        consecutivePicks: 0,
        deckState: createEmptyDeckState("", 0),
        deckReady: false,
        deckSaveStatus: "idle",
        deckBuilderActive: false,
        viewingSharedDeck: false,
      });
    }
  },
);

// Refetch queue when dataVersion changes (new picks arrived)
useDraftStore.subscribe(
  (state) => state.dataVersion,
  (dataVersion) => {
    if (dataVersion > 0) {
      useLiveStore.getState().fetchQueue();
    }
  },
);

// Recompute picking state when nextSeat changes
useDraftStore.subscribe(
  (state) => state.liveDraftStatus?.nextSeat,
  () => recomputePicking(),
);

// ---------------------------------------------------------------------------
// Deck builder sync (absorbed from useDeckBuilderSync hook)
// ---------------------------------------------------------------------------

function syncDeckWithPicks() {
  const { deckBuilderActive, deckReady, floatedCards, queue, dispatchDeck } = useLiveStore.getState();
  const { seatCardList, scryfallDataMap } = useCardStore.getState();
  const isAuthed = getIsAuthed();

  if (!deckBuilderActive || !deckReady) return;

  const picks = seatCardList ?? [];
  const authFloated = isAuthed ? floatedCards : [];
  const authQueued = isAuthed ? [...queue].map((e) => e.cardName) : [];
  // Deduplicate speculative cards: if a card is both floated and queued, count it once.
  // Picks are authoritative; speculative cards add on top of picks but not on top of each other.
  const pickedSet = new Set(picks);
  const seen = new Set(pickedSet);
  const speculative: string[] = [];
  for (const name of [...authQueued, ...authFloated]) {
    if (!seen.has(name)) {
      seen.add(name);
      speculative.push(name);
    }
  }
  const canonicalCards = [...picks, ...speculative];

  dispatchDeck({
    type: "REBUILD",
    canonicalCards,
    scryfallData: scryfallDataMap,
  });
}

function debouncedSyncDeckWithPicks() {
  if (syncDeckTimer) clearTimeout(syncDeckTimer);
  syncDeckTimer = setTimeout(syncDeckWithPicks, 50);
}

// Sync deck with picks when card data changes
useCardStore.subscribe(
  (state) => state.seatCardList,
  () => debouncedSyncDeckWithPicks(),
);

// Rebuild deck when deck builder is activated
useLiveStore.subscribe(
  (state) => state.deckBuilderActive,
  (active) => {
    if (active) {
      debouncedSyncDeckWithPicks();
    }
  },
);

// Rebuild deck when float state changes
useLiveStore.subscribe(
  (state) => state.floatedCards,
  () => debouncedSyncDeckWithPicks(),
);

// Rebuild deck when queue changes
useLiveStore.subscribe(
  (state) => state.queue,
  () => debouncedSyncDeckWithPicks(),
);
