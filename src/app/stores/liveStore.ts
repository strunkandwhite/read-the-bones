import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import { derivePickSeat, getTotalPicks } from "@/core/snakeDraft";
import {
  deckReducer,
  createEmptyDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

export type { DeckAction };

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
  queuedCards: Map<string, number>;
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

async function syncQueue(set: SetState, get: GetState, cardNames: string[]) {
  const { seatToken, queue: previousQueue } = get();
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
        queuedCards: new Map(queue.map((e) => [e.cardName, e.priority])),
        queueError: null,
      });
    } else {
      set({
        queue: previousQueue,
        queuedCards: new Map(previousQueue.map((e) => [e.cardName, e.priority])),
        queueError: "Failed to sync queue",
      });
    }
  } catch {
    set({
      queue: previousQueue,
      queuedCards: new Map(previousQueue.map((e) => [e.cardName, e.priority])),
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
let deckBuilderInitialized = false;
let prevSpeculativeCards = new Set<string>();

const DECK_SAVE_DEBOUNCE_MS = 1000;
const DECK_SAVE_STATUS_RESET_MS = 2000;

export function _resetDeckState() {
  deckDirty = false;
  deckInFlight = false;
  deckPendingSave = false;
  justHydrated = false;
  deckBuilderInitialized = false;
  prevSpeculativeCards = new Set<string>();
  if (deckSaveTimer) {
    clearTimeout(deckSaveTimer);
    deckSaveTimer = null;
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
    // Save failed — will retry on next dispatch
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
    queuedCards: new Map(),
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
            queuedCards: new Map(queue.map((e) => [e.cardName, e.priority])),
            queueError: null,
          });
        }
      } catch {
        set({ queueError: "Failed to load queue" });
      }
      set({ queueLoading: false });
    },

    addToQueue: (cardName: string) => {
      const { queue } = get();
      const newNames = [...queue.map((e) => e.cardName), cardName];
      syncQueue(set, get, newNames);
    },

    removeFromQueue: (cardName: string) => {
      const { queue } = get();
      const newNames = queue.filter((e) => e.cardName !== cardName).map((e) => e.cardName);
      syncQueue(set, get, newNames);
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
      const next = deckReducer(get().deckState, action);
      set({ deckState: next });

      // INIT_FROM_SNAPSHOT comes from hydration — don't trigger a save
      if (action.type === "INIT_FROM_SNAPSHOT") {
        justHydrated = true;
        return;
      }

      if (justHydrated) {
        justHydrated = false;
      }

      deckDirty = true;
      scheduleDeckSave();
    },

    setDeckBuilderActive: (active: boolean) => {
      set({ deckBuilderActive: active });
    },

    fetchDeckState: async () => {
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
    await useLiveStore.getState().refreshSettings();
    const { autoPick, queuedCards } = useLiveStore.getState();
    if (!autoPick || queuedCards.size === 0) return;

    // Pick the highest-priority (lowest number) card from queue
    const { queue } = useLiveStore.getState();
    const sorted = [...queue].sort((a, b) => a.priority - b.priority);
    if (sorted.length > 0) {
      await useLiveStore.getState().handlePick(sorted[0].cardName);
    }
  } finally {
    autoPickInFlight = false;
  }
}

export function recomputePicking() {
  const { mySeat, autoPick, queuedCards } = useLiveStore.getState();
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
  if (isMyTurn && autoPick && queuedCards.size > 0) {
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
        queuedCards: new Map(),
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
  const { deckBuilderActive, deckReady, deckState, floatedCards, queue, dispatchDeck, mySeat } = useLiveStore.getState();
  const { seatCardList, scryfallDataMap } = useCardStore.getState();
  const { activeDraft, selectedSeat } = useDraftStore.getState();
  const isAuthed = mySeat !== null && mySeat === selectedSeat;

  if (!deckBuilderActive || !deckReady) return;

  const picks = seatCardList ?? [];
  const authFloated = isAuthed ? floatedCards : [];
  const authQueued = isAuthed ? [...queue].map((e) => e.cardName) : [];
  const allCardNames = [...picks, ...authFloated, ...authQueued];

  if (allCardNames.length === 0) return;

  // INIT_FROM_PICKS on first activation with empty zones
  if (!deckBuilderInitialized) {
    const isEmpty =
      Object.values(deckState.zones.deck).flat().length === 0 &&
      Object.values(deckState.zones.sideboard).flat().length === 0;
    if (isEmpty) {
      dispatchDeck({
        type: "INIT_FROM_PICKS",
        picks: allCardNames,
        scryfallData: scryfallDataMap,
        draftId: activeDraft ?? "",
        seat: selectedSeat ?? 0,
      });
    }
    deckBuilderInitialized = true;
  }

  // SYNC_PICKS
  dispatchDeck({
    type: "SYNC_PICKS",
    pickedCardNames: allCardNames,
    scryfallData: scryfallDataMap,
  });

  // REMOVE_CARDS for speculative cards that are no longer speculative
  const pickedSet = new Set(picks);
  const currentSpeculative = new Set([
    ...authFloated.filter((c) => !pickedSet.has(c)),
    ...authQueued.filter((c) => !pickedSet.has(c)),
  ]);

  const removed: string[] = [];
  for (const card of prevSpeculativeCards) {
    if (!currentSpeculative.has(card) && !pickedSet.has(card)) {
      removed.push(card);
    }
  }
  if (removed.length > 0) {
    dispatchDeck({ type: "REMOVE_CARDS", cardNames: removed });
  }
  prevSpeculativeCards = currentSpeculative;
}

// Sync deck with picks when card data changes
useCardStore.subscribe(
  (state) => state.seatCardList,
  () => syncDeckWithPicks(),
);

// Reset deck init tracking when deck builder is deactivated
useLiveStore.subscribe(
  (state) => state.deckBuilderActive,
  (active) => {
    if (!active) {
      deckBuilderInitialized = false;
    } else {
      syncDeckWithPicks();
    }
  },
);
