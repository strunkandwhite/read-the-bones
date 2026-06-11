import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore, registerSeatTokenProvider, registerApplyMeData } from "./draftStore";
import type { LiveMeData } from "./draftStore";
import { useCardStore } from "./cardStore";
import { getMyDeckCardNames } from "./selectors";
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
  enterSharedView: (draftId: string, seat: number, deckState: DeckState) => void;
}

// ---------------------------------------------------------------------------
// Internal helper: sync queue to server with optimistic revert
// ---------------------------------------------------------------------------

type SetState = (partial: Partial<LiveStoreState>) => void;
type GetState = () => LiveStoreState;

async function syncQueue(set: SetState, get: GetState, newQueue: QueueGroupEntry[], previousQueue?: QueueGroupEntry[], fallbackFloats?: string[]) {
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
      // Refresh floated cards to pick up any server-side auto-float/unfloat side effects
      void useLiveStore.getState().fetchFloatedCards();
    } else {
      set({
        queue: fallbackQueue,
        queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
        queueError: "Failed to sync queue",
      });
      if (fallbackFloats !== undefined) {
        set({ floatedCards: fallbackFloats, floatedCardsSet: new Set(fallbackFloats) });
      }
    }
  } catch {
    set({
      queue: fallbackQueue,
      queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
      queueError: "Failed to sync queue",
    });
    if (fallbackFloats !== undefined) {
      set({ floatedCards: fallbackFloats, floatedCardsSet: new Set(fallbackFloats) });
    }
  }
  set({ queueLoading: false });
}

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

async function flushDeckSave(scheduledForDraft: string) {
  const { seatToken, deckState } = useLiveStore.getState();
  const activeDraft = useDraftStore.getState().activeDraft;
  // Belt-and-braces: if the user switched drafts between schedule and flush, discard the save
  if (activeDraft !== scheduledForDraft) return;
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
      if (deckDirty) flushDeckSave(scheduledForDraft);
    }, 5000);
  }

  deckInFlight = false;

  if (deckPendingSave) {
    deckPendingSave = false;
    await flushDeckSave(scheduledForDraft);
  }
}

function scheduleDeckSave() {
  if (deckInFlight) {
    deckPendingSave = true;
    return;
  }
  // Capture the draftId at schedule time; flushDeckSave will abort if it has changed by flush time.
  const draftIdAtSchedule = useDraftStore.getState().activeDraft ?? "";
  if (deckSaveTimer) clearTimeout(deckSaveTimer);
  deckSaveTimer = setTimeout(() => {
    deckSaveTimer = null;
    flushDeckSave(draftIdAtSchedule);
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
        if (res.ok) {
          set({ autoPick: newValue });
          recomputePicking();
        }
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
          // Deep-compare with current queue to avoid churn on idle polls —
          // keep the existing reference when content is identical.
          const prevQueue = get().queue;
          const queueChanged = JSON.stringify(queue) !== JSON.stringify(prevQueue);
          if (queueChanged) {
            set({
              queue,
              queuedCardCounts: deriveQueuedCardCounts(queue),
              queueError: null,
            });
          } else {
            set({ queueError: null });
          }
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
      syncQueue(set, get, optimisticQueue, original, floatedCards);
    },

    removeFromQueue: (cardName: string) => {
      const { queue: original, floatedCards } = get();
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
      // Optimistically demote to float (mirrors the server-side auto-float behavior)
      const nextFloats = floatedCards.includes(cardName) ? floatedCards : [...floatedCards, cardName];
      set({
        queue: optimisticQueue,
        queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
        floatedCards: nextFloats,
        floatedCardsSet: new Set(nextFloats),
      });
      syncQueue(set, get, optimisticQueue, original, floatedCards);
    },

    reorderQueue: (entries: QueueGroupEntry[]) => {
      const { queue: original } = get();
      // Optimistic: reflect the reorder/group/eject immediately, revert on failure.
      set({ queue: entries, queuedCardCounts: deriveQueuedCardCounts(entries) });
      syncQueue(set, get, entries, original);
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
          if (data?.cards) {
            // Deep-compare with current floats to avoid churn on idle polls —
            // keep the existing reference when content is identical.
            const incoming: string[] = data.cards;
            const prevFloats = get().floatedCards;
            const floatsChanged =
              incoming.length !== prevFloats.length ||
              incoming.some((c, i) => c !== prevFloats[i]);
            if (floatsChanged) {
              set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
            }
          }
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
        // On failure, refetch server truth instead of restoring a potentially
        // stale snapshot — a concurrent op may have succeeded between our
        // optimistic update and this response.
        if (!res.ok) await useLiveStore.getState().fetchFloatedCards();
      } catch {
        await useLiveStore.getState().fetchFloatedCards();
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
        // On failure, refetch server truth rather than restoring a snapshot
        // that may have been overtaken by a concurrent successful operation.
        if (!res.ok) await useLiveStore.getState().fetchFloatedCards();
      } catch {
        await useLiveStore.getState().fetchFloatedCards();
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
      // Invariant: justHydrated is set by INIT_FROM_SNAPSHOT and must be
      // consumed by the very next REBUILD (the automatic sync that follows
      // hydration) regardless of whether that REBUILD changes state.  If the
      // user dispatches any non-REBUILD action while justHydrated is set, the
      // flag is also cleared — that action is a real edit and must be saved.
      //
      // Why this ordering matters: deckReducer can return the same reference
      // for a no-op REBUILD (zones are identical after hydration).  Without
      // eager flag consumption, the no-op guard below would return before the
      // justHydrated check, leaving the flag alive to eat the user's first
      // real edit.
      if (action.type === "INIT_FROM_SNAPSHOT") {
        const prev = get().deckState;
        const next = deckReducer(prev, action);
        if (next !== prev) set({ deckState: next });
        justHydrated = true;
        return;
      }

      if (action.type === "REBUILD" && justHydrated) {
        // Consume the post-hydration rebuild flag before the no-op guard so a
        // no-op REBUILD (same reference returned) cannot leave the flag alive.
        justHydrated = false;
        const prev = get().deckState;
        const next = deckReducer(prev, action);
        if (next !== prev) set({ deckState: next });
        // No dirty/save — this is the automatic sync, not a user edit.
        return;
      }

      const prev = get().deckState;
      const next = deckReducer(prev, action);
      if (next === prev) return; // reducer returned same reference = no change
      set({ deckState: next });

      // Never persist edits while viewing someone else's shared deck snapshot.
      if (get().viewingSharedDeck) return;

      if (justHydrated) {
        // User acted before any REBUILD came (e.g. deck builder opened
        // immediately after hydration with no picks loaded yet).  Consume the
        // flag and save — this is a real edit.
        justHydrated = false;
      }

      deckDirty = true;
      scheduleDeckSave();
    },

    setDeckBuilderActive: (active: boolean) => {
      set({ deckBuilderActive: active });
    },

    // -----------------------------------------------------------------------
    // enterSharedView — atomically switch to shared-deck viewing mode.
    //
    // The activeDraft subscription resets ALL live state including
    // viewingSharedDeck whenever the draft changes.  If the loader called
    // setActiveDraft first and then set viewingSharedDeck, fetchDeckState
    // (fired by the subscription) would see viewingSharedDeck=false and
    // overwrite the shared snapshot with the viewer's own WIP deck.
    //
    // This action sets the module-scoped enteringSharedView flag BEFORE
    // calling setActiveDraft so the subscription preserves viewingSharedDeck.
    // -----------------------------------------------------------------------
    enterSharedView: (draftId: string, seat: number, sharedDeckState: DeckState) => {
      // Signal to the subscription that it must not clear viewingSharedDeck.
      enteringSharedView = true;
      try {
        useDraftStore.getState().setActiveDraft(draftId);
        useDraftStore.getState().setSelectedSeat(seat);
      } finally {
        enteringSharedView = false;
      }
      // The subscription fired synchronously above; viewingSharedDeck is now
      // true (preserved by the flag).  Load the snapshot.
      get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot: sharedDeckState });
    },

    fetchDeckState: async () => {
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
            // Ensure identity (draftId/seat) is correct at load time so
            // syncDeckWithPicks never needs to patch it after the fact.
            const mySeat = get().mySeat ?? useDraftStore.getState().selectedSeat;
            const identifiedSnapshot = {
              ...snapshot,
              draftId: activeDraft,
              seat: mySeat ?? snapshot.seat,
            };
            get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot: identifiedSnapshot });
          } else {
            // No saved state (404) — create an empty deck with correct identity
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
    },
  })),
);

// ---------------------------------------------------------------------------
// Derived picking state
// ---------------------------------------------------------------------------

let autoPickInFlight = false;

/**
 * Client-side auto-pick trigger: checks the trigger condition (my turn +
 * autoPick enabled + not in flight) then delegates ALL queue-traversal and
 * candidate selection to the server via POST /api/drafts/[id]/pick with
 * `{ auto: true }`.  The server runs the same logic as the cascade path so
 * both paths are guaranteed to make identical picks for the same queue state.
 *
 * On conflict (pick_n already taken — cascade fired first): the server returns
 * 409, which we treat as "already handled — just refresh".
 */
async function triggerAutoPick() {
  if (autoPickInFlight) return;
  autoPickInFlight = true;
  try {
    const { seatToken, autoPick } = useLiveStore.getState();
    if (!autoPick) return;

    const activeDraft = useDraftStore.getState().activeDraft;
    if (!seatToken || !activeDraft) return;

    const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
      method: "POST",
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auto: true }),
    });

    if (res.ok) {
      const data = await res.json() as { autoPickDisabled?: boolean; pickedCard?: unknown };
      if (data.autoPickDisabled) {
        // Server disabled auto-pick due to pause-mode exhaustion — reflect locally
        useLiveStore.setState({ autoPick: false });
      }
      // Refresh to pick up the new pick (or the disabled-autoPick state)
      await useDraftStore.getState().refreshNow();
    } else if (res.status === 409) {
      // Conflict: cascade already fired for this pick_n — refresh to catch up
      await useDraftStore.getState().refreshNow();
    }
    // Other errors (not my turn, queue empty, etc.) are silent — the next poll
    // will recompute isMyTurn and re-trigger if still appropriate.
  } finally {
    autoPickInFlight = false;
  }
}

export function recomputePicking() {
  const { mySeat, autoPick, queue } = useLiveStore.getState();
  const { liveDraftStatus } = useDraftStore.getState();

  const isMyTurn = mySeat !== null && liveDraftStatus?.nextSeat === mySeat;

  useLiveStore.setState({ isMyTurn });

  // Auto-pick trigger — only fire when the queue is non-empty (client-side
  // pre-check to avoid a round-trip when there is obviously nothing to pick).
  // The server validates the candidate independently so this is just an
  // optimisation, not a correctness gate.
  if (isMyTurn && autoPick && queue.length > 0) {
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
      // Reset ALL per-draft state (auth, queue, float, AND deck builder) before loading
      // for the new draft so nothing from the previous draft bleeds in.  Cancel any
      // pending debounced save so a flush scheduled for the old draft cannot overwrite
      // the new draft's deck-state endpoint.
      _resetDeckState();
      useLiveStore.setState({
        seatToken: null,
        mySeat: null,
        autoPick: true,
        displayName: null,
        queue: [],
        queuedCardCounts: new Map(),
        floatedCards: [],
        floatedCardsSet: new Set<string>(),
        deckState: createEmptyDeckState("", 0),
        deckReady: false,
        deckSaveStatus: "idle",
        // When enterSharedView called setActiveDraft, this subscription fires
        // synchronously.  The enteringSharedView flag tells us to preserve the
        // shared-view intent so fetchDeckState (called below) sees it and bails.
        viewingSharedDeck: enteringSharedView,
      });
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
        deckState: createEmptyDeckState("", 0),
        deckReady: false,
        deckSaveStatus: "idle",
        deckBuilderActive: false,
        viewingSharedDeck: false,
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Poll-integrated per-seat data (Task 24)
// ---------------------------------------------------------------------------
// When /live returns `me` data (authenticated callers with a valid seat token),
// apply it to the live store here — eliminating separate /queue, /float, and /me
// poll requests. The server-side sig includes a per-seat freshness marker so
// cross-device queue/float changes break the short-circuit and deliver fresh data.
//
// The standalone /queue and /float endpoints remain for mutations (they return the
// authoritative server state after writes). The subscriptions below that called
// fetchQueue/fetchFloatedCards on every pollCount and refreshSettings on every pick
// are replaced by this single callback path.

function applyMeFromPoll(me: LiveMeData): void {
  const set = useLiveStore.setState;
  const get = useLiveStore.getState;

  // Guard against stale responses: if mySeat is already resolved and differs from
  // the incoming seat, this response is from a different draft/token context — skip.
  // When mySeat is null (first poll after draft switch), accept the response and
  // use it to resolve mySeat, superseding the fetchMySeat() async call.
  const { mySeat } = get();
  if (mySeat !== null && me.seat !== mySeat) return;

  // Resolve mySeat from the first authenticated /live response if not yet set.
  if (mySeat === null) {
    set({ mySeat: me.seat });
    // recomputePicking is called below after applying all me fields
  }

  // autoPick — apply unconditionally (simple scalar)
  if (me.autoPick !== null && me.autoPick !== undefined) {
    const prev = get().autoPick;
    if (me.autoPick !== prev) {
      set({ autoPick: me.autoPick });
    }
  }

  // displayName — apply unconditionally (simple scalar)
  if (me.displayName !== undefined) {
    const prev = get().displayName;
    if (me.displayName !== prev) {
      set({ displayName: me.displayName });
    }
  }

  // queue — deep-compare before updating (Task 23 reference-stability)
  if (me.queue !== null && me.queue !== undefined) {
    const incoming: QueueGroupEntry[] = (me.queue as Array<{ mode: 'pause' | 'flow-through'; cards: Array<{ id?: number; cardId?: number; name?: string; cardName?: string }> }>).map((e) => ({
      mode: e.mode,
      cards: e.cards.map((c) => ({ cardId: c.id ?? c.cardId ?? 0, cardName: c.name ?? c.cardName ?? "" })),
    }));
    const prevQueue = get().queue;
    if (JSON.stringify(incoming) !== JSON.stringify(prevQueue)) {
      set({
        queue: incoming,
        queuedCardCounts: deriveQueuedCardCounts(incoming),
      });
    }
  }

  // floatedCards — deep-compare before updating
  if (me.floatedCards !== null && me.floatedCards !== undefined) {
    const incoming = me.floatedCards;
    const prev = get().floatedCards;
    const changed = incoming.length !== prev.length || incoming.some((c, i) => c !== prev[i]);
    if (changed) {
      set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
    }
  }

  // Recompute auto-pick eligibility after all fields are applied.
  recomputePicking();
}

// Register providers with draftStore — avoids circular imports.
// These run at module load time (after both stores are initialized).
registerSeatTokenProvider(() => useLiveStore.getState().seatToken);
registerApplyMeData(applyMeFromPoll);

/** Exported for tests only — do not use in production code. */
export const _applyMeDataForTest = applyMeFromPoll;

// Recompute picking state when nextSeat changes
useDraftStore.subscribe(
  (state) => state.liveDraftStatus?.nextSeat,
  () => recomputePicking(),
);

// ---------------------------------------------------------------------------
// Deck builder sync (absorbed from useDeckBuilderSync hook)
// ---------------------------------------------------------------------------

function syncDeckWithPicks() {
  const { deckBuilderActive, deckReady, dispatchDeck } = useLiveStore.getState();
  const { scryfallDataMap } = useCardStore.getState();

  if (!deckBuilderActive || !deckReady || useLiveStore.getState().viewingSharedDeck) return;

  // getMyDeckCardNames() is the canonical union (picks + speculative, auth-gated,
  // deduplicated) shared with the mobile deck filter in PageClient.
  // Set preserves insertion order: picks first, then speculative (queue, then floats).
  const canonicalCards = [...getMyDeckCardNames()];

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

// Rebuild deck when mySeat resolves (identity fix)
useLiveStore.subscribe(
  (state) => state.mySeat,
  () => debouncedSyncDeckWithPicks(),
);
