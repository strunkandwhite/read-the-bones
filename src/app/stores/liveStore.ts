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

function deriveQueuedCardCounts(queue: QueueGroupEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of queue) {
    for (const card of entry.cards) {
      counts.set(card.cardName, (counts.get(card.cardName) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueCard {
  cardId: number;
  cardName: string;
}

export interface QueueGroupEntry {
  mode: 'pause' | 'flow-through';
  cards: QueueCard[];
}

// Server-side queue format (id/name fields)
interface ServerQueueCard { id?: number; cardId?: number; name?: string; cardName?: string; }
interface ServerQueueEntry { mode: 'pause' | 'flow-through'; cards: ServerQueueCard[]; }

interface LiveStoreState {
  // Auth
  seatToken: string | null;
  mySeat: number | null;
  autoPick: boolean;
  displayName: string | null;

  // Queue
  queue: QueueGroupEntry[];
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
  refreshSettings: () => Promise<void>;

  // Queue actions
  fetchQueue: () => Promise<void>;
  addToQueue: (cardName: string) => void;
  removeFromQueue: (cardName: string) => void;
  reorderQueue: (entries: QueueGroupEntry[]) => void;
  setEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => void;

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

async function syncQueue(set: SetState, get: GetState, newQueue: QueueGroupEntry[], previousQueue?: QueueGroupEntry[]) {
  const { seatToken } = get();
  const fallbackQueue = previousQueue ?? get().queue;
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft) return;

  set({ queueLoading: true });
  try {
    const body = newQueue.map((entry) => ({
      mode: entry.mode,
      cards: entry.cards.map((c) => c.cardName),
    }));
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
      // Server returns { mode, cards: [{ id, name }] } format
      const queue: QueueGroupEntry[] = (data.queue as ServerQueueEntry[]).map((e) => ({
        mode: e.mode,
        cards: e.cards.map((c) => ({ cardId: c.id ?? c.cardId ?? 0, cardName: c.name ?? c.cardName ?? "" })),
      }));
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
    } else {
      useLiveStore.setState({ deckSaveStatus: "idle" });
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
          // Server returns { mode, cards: [{ id, name }] } format
          const queue: QueueGroupEntry[] = (data.queue as ServerQueueEntry[]).map((e) => ({
            mode: e.mode,
            cards: e.cards.map((c) => ({ cardId: c.id ?? c.cardId ?? 0, cardName: c.name ?? c.cardName ?? "" })),
          }));
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
      const { queue: original, floatedCards } = get();
      // Optimistic update: add card as a new pause entry at the end
      const optimisticQueue: QueueGroupEntry[] = [...original, { mode: 'pause', cards: [{ cardId: 0, cardName }] }];
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      });
      // Queue supersedes float — optimistically remove from float list
      if (floatedCards.includes(cardName)) {
        const nextFloats = floatedCards.filter((c) => c !== cardName);
        set({ floatedCards: nextFloats, floatedCardsSet: new Set(nextFloats) });
      }
      syncQueue(set, get, optimisticQueue, original);
    },

    removeFromQueue: (cardName: string) => {
      const { queue: original } = get();
      // Find the first entry containing this card, remove the card from it; remove empty entries
      let found = false;
      const optimisticQueue: QueueGroupEntry[] = original
        .map((entry) => {
          if (!found) {
            const cardIndex = entry.cards.findIndex((c) => c.cardName === cardName);
            if (cardIndex !== -1) {
              found = true;
              return { ...entry, cards: entry.cards.filter((_, i) => i !== cardIndex) };
            }
          }
          return entry;
        })
        .filter((entry) => entry.cards.length > 0);
      if (!found) return;
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      });
      syncQueue(set, get, optimisticQueue, original);
    },

    reorderQueue: (entries: QueueGroupEntry[]) => {
      syncQueue(set, get, entries);
    },

    setEntryMode: (entryIndex: number, mode: 'pause' | 'flow-through') => {
      const { queue: original } = get();
      const newQueue = original.map((entry, i) =>
        i === entryIndex ? { ...entry, mode } : entry
      );
      set({ queue: newQueue, queuedCardCounts: deriveQueuedCardCounts(newQueue) });
      syncQueue(set, get, newQueue, original);
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
    await useLiveStore.getState().refreshSettings();
    const { autoPick } = useLiveStore.getState();
    if (!autoPick) return;

    // Re-fetch queue to get latest state (a queued card may have been picked by someone else)
    await useLiveStore.getState().fetchQueue();
    const { queue } = useLiveStore.getState();
    if (queue.length === 0) return;

    // Try entries in order; within each entry try each card.
    // If a card succeeds, stop. If a card fails with "already taken", try the next card in the entry.
    // If the whole entry is exhausted without a pick, check mode:
    //   pause → stop; flow-through → continue to next entry.
    for (const entry of queue) {
      let pickedFromEntry = false;
      for (const card of entry.cards) {
        await useLiveStore.getState().handlePick(card.cardName);
        if (!useLiveStore.getState().pickError) {
          pickedFromEntry = true;
          break;
        }
        useLiveStore.getState().setPickError(null);
      }
      if (pickedFromEntry) break;
      if (entry.mode === 'pause') break;
      // flow-through: continue to next entry
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

// Refetch queue, floats, and settings when a new pick arrives
useDraftStore.subscribe(
  (state) => state.liveDraftStatus?.latestPickN,
  (latestPickN, prevLatestPickN) => {
    if (latestPickN != null && prevLatestPickN != null && latestPickN !== prevLatestPickN) {
      useLiveStore.getState().fetchQueue();
      useLiveStore.getState().fetchFloatedCards();
      useLiveStore.getState().refreshSettings();
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
  const authQueued = isAuthed ? queue.flatMap((entry) => entry.cards.map((c) => c.cardName)) : [];
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

  // Ensure deckState identity (draftId/seat) is correct — mySeat may not
  // have been available when fetchDeckState ran, so patch it here.
  const activeDraft = useDraftStore.getState().activeDraft;
  const mySeat = useLiveStore.getState().mySeat;
  const ds = useLiveStore.getState().deckState;
  if (activeDraft && mySeat != null && (ds.draftId !== activeDraft || ds.seat !== mySeat)) {
    useLiveStore.setState({ deckState: { ...ds, draftId: activeDraft, seat: mySeat } });
  }
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

// Rebuild deck when mySeat resolves (identity fix)
useLiveStore.subscribe(
  (state) => state.mySeat,
  () => debouncedSyncDeckWithPicks(),
);
