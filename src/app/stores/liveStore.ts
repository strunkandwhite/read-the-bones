import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore, registerSeatTokenProvider, registerApplyMeData } from "./draftStore";
import type { LiveMeData } from "./draftStore";
import { useCardStore } from "./cardStore";
import { createEmptyDeckState, type DeckAction } from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

// Action modules
import {
  makeHydrateToken,
  makeFetchMySeat,
  makeToggleAutoPick,
  makeUpdateDisplayName,
  makeRefreshSettings,
} from "./live/auth";
import {
  deriveQueuedCardCounts,
  parseServerQueue,
  makeFetchQueue,
  makeAddToQueue,
  makeRemoveFromQueue,
  makeReorderQueue,
  makeSetEntryMode,
  makeFetchFloatedCards,
  makeAddFloat,
  makeRemoveFloat,
  makeReconcileLocalFloats,
} from "./live/queueFloat";
import {
  makeRecomputePicking,
  makeHandlePick,
  makeSetPickError,
  makeReportMatch,
  type MatchReportParams,
} from "./live/picking";
import {
  resetDeckSaveState,
  getEnteringSharedView,
  makeDispatchDeck,
  makeSetDeckBuilderActive,
  makeEnterSharedView,
  makeFetchDeckState,
  makeSyncDeckWithPicks,
  makeDebouncedSyncDeckWithPicks,
  makeShareDeck,
  makeSyncLocalDeck,
} from "./live/deckSave";

export type { DeckAction, MatchReportParams };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueueCard {
  cardId: number;
  cardName: string;
}

export interface QueueGroupEntry {
  mode: "pause" | "flow-through";
  cards: QueueCard[];
}

export interface LiveStoreState {
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
  // Identity ("<draftId>:<seat>") the local-mode float list was loaded/saved
  // for — guards reconcile against writing floats to the wrong key while a
  // seat/draft switch is mid-flight. Null outside local deck mode.
  floatedCardsKey: string | null;

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
  setEntryMode: (entryIndex: number, mode: "pause" | "flow-through") => void;

  // Float actions
  fetchFloatedCards: () => Promise<void>;
  addFloat: (cardName: string) => Promise<void>;
  removeFloat: (cardName: string) => Promise<void>;
  reconcileLocalFloats: () => void;

  // Pick actions
  handlePick: (cardName: string) => Promise<void>;
  setPickError: (error: string | null) => void;
  reportMatch: (params: MatchReportParams) => Promise<string | null>;

  // Deck builder actions
  dispatchDeck: (action: DeckAction) => void;
  setDeckBuilderActive: (active: boolean) => void;
  fetchDeckState: () => Promise<void>;
  enterSharedView: (draftId: string, seat: number, deckState: DeckState) => void;
  /** Creates a shareable deck snapshot via POST /api/deck. Returns the share URL. */
  shareDeck: () => Promise<string>;
}

// ---------------------------------------------------------------------------
// SetState / GetState convenience types (used by action modules)
// ---------------------------------------------------------------------------

export type SetState = (partial: Partial<LiveStoreState>) => void;
export type GetState = () => LiveStoreState;

// ---------------------------------------------------------------------------
// _resetDeckState — exported for tests
// ---------------------------------------------------------------------------

export function _resetDeckState() {
  resetDeckSaveState();
}

// ---------------------------------------------------------------------------
// getLiveStoreRef — lazy accessor passed to modules needing setState/getState.
// Using a function (not a direct variable) breaks the circular reference at
// module evaluation time: modules capture the function reference; liveStore
// is created before any call is actually made.
// ---------------------------------------------------------------------------

function getLiveStoreRef() {
  return {
    getState: useLiveStore.getState,
    setState: useLiveStore.setState as SetState,
    fetchFloatedCards: () => useLiveStore.getState().fetchFloatedCards(),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useLiveStore = create<LiveStoreState>()(
  subscribeWithSelector((set, get): LiveStoreState => {
    // recomputePicking must be created first — auth and picking actions reference it.
    const boundSet = set as unknown as SetState;
    const recomputePicking = makeRecomputePicking(boundSet, get);

    return {
      // Initial state
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
      floatedCardsKey: null,

      pickError: null,
      isMyTurn: false,

      deckState: createEmptyDeckState("", 0),
      deckReady: false,
      deckSaveStatus: "idle",
      deckBuilderActive: false,
      viewingSharedDeck: false,

      // Auth actions
      hydrateToken: makeHydrateToken(boundSet),
      fetchMySeat: makeFetchMySeat(boundSet, get, recomputePicking),
      toggleAutoPick: makeToggleAutoPick(boundSet, get, recomputePicking),
      updateDisplayName: makeUpdateDisplayName(boundSet, get),
      refreshSettings: makeRefreshSettings(boundSet, get),

      // Queue actions
      fetchQueue: makeFetchQueue(boundSet, get),
      addToQueue: makeAddToQueue(boundSet, get, getLiveStoreRef),
      removeFromQueue: makeRemoveFromQueue(boundSet, get, getLiveStoreRef),
      reorderQueue: makeReorderQueue(boundSet, get, getLiveStoreRef),
      setEntryMode: makeSetEntryMode(boundSet, get, getLiveStoreRef),

      // Float actions
      fetchFloatedCards: makeFetchFloatedCards(boundSet, get),
      addFloat: makeAddFloat(boundSet, get, getLiveStoreRef),
      removeFloat: makeRemoveFloat(boundSet, get, getLiveStoreRef),
      reconcileLocalFloats: makeReconcileLocalFloats(boundSet, get),

      // Pick actions
      handlePick: makeHandlePick(boundSet, get),
      setPickError: makeSetPickError(boundSet),
      reportMatch: makeReportMatch(get),

      // Deck builder actions
      dispatchDeck: makeDispatchDeck(boundSet, get, getLiveStoreRef),
      setDeckBuilderActive: makeSetDeckBuilderActive(boundSet),
      enterSharedView: makeEnterSharedView(boundSet, get),
      fetchDeckState: makeFetchDeckState(boundSet, get),
      shareDeck: makeShareDeck(get),
    };
  }),
);

// ---------------------------------------------------------------------------
// Exported recomputePicking — used in tests and subscriptions.
//
// This mirrors the store-internal recomputePicking (makeRecomputePicking bound
// to set/get) but operates directly on useLiveStore.getState/setState, so it
// can be called from outside the store creator without capturing stale closures.
// ---------------------------------------------------------------------------

export function recomputePicking(): void {
  const get = useLiveStore.getState;
  const set = useLiveStore.setState as SetState;
  // Delegate to the same logic as the in-store version via a fresh binding.
  makeRecomputePicking(set, get)();
}

// ---------------------------------------------------------------------------
// Cross-store subscription: react to activeDraft changes
// ---------------------------------------------------------------------------

useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    if (activeDraft) {
      resetDeckSaveState();
      useLiveStore.setState({
        seatToken: null,
        mySeat: null,
        autoPick: true,
        displayName: null,
        queue: [],
        queuedCardCounts: new Map(),
        floatedCards: [],
        floatedCardsSet: new Set<string>(),
        floatedCardsKey: null,
        deckState: createEmptyDeckState("", 0),
        deckReady: false,
        deckSaveStatus: "idle",
        // Preserve viewingSharedDeck when enterSharedView signalled this switch
        viewingSharedDeck: getEnteringSharedView(),
      });
      useLiveStore.getState().hydrateToken(activeDraft);
      useLiveStore.getState().fetchMySeat();
      useLiveStore.getState().fetchQueue();
      useLiveStore.getState().fetchFloatedCards();
      useLiveStore.getState().fetchDeckState();
    } else {
      resetDeckSaveState();
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
        floatedCardsKey: null,
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

// Server-side queue format — server always sends { id, name }
interface ServerQueueCard { id: number; name: string; }
interface ServerQueueEntry { mode: "pause" | "flow-through"; cards: ServerQueueCard[]; }

function applyMeFromPoll(me: LiveMeData): void {
  const set = useLiveStore.setState;
  const get = useLiveStore.getState;

  // Guard against stale responses: if mySeat is already resolved and differs from
  // the incoming seat, skip.
  const { mySeat } = get();
  if (mySeat !== null && me.seat !== mySeat) return;

  // Resolve mySeat from the first authenticated /live response if not yet set.
  if (mySeat === null) {
    set({ mySeat: me.seat });
  }

  if (me.autoPick !== null && me.autoPick !== undefined) {
    const prev = get().autoPick;
    if (me.autoPick !== prev) {
      set({ autoPick: me.autoPick });
    }
  }

  if (me.displayName !== undefined) {
    const prev = get().displayName;
    if (me.displayName !== prev) {
      set({ displayName: me.displayName });
    }
  }

  if (me.queue !== null && me.queue !== undefined) {
    const incoming = parseServerQueue(me.queue as ServerQueueEntry[]);
    const prevQueue = get().queue;
    if (JSON.stringify(incoming) !== JSON.stringify(prevQueue)) {
      set({
        queue: incoming,
        queuedCardCounts: deriveQueuedCardCounts(incoming),
      });
    }
  }

  if (me.floatedCards !== null && me.floatedCards !== undefined) {
    const incoming = me.floatedCards;
    const prev = get().floatedCards;
    const changed = incoming.length !== prev.length || incoming.some((c, i) => c !== prev[i]);
    if (changed) {
      set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
    }
  }

  recomputePicking();
}

// Register providers with draftStore — avoids circular imports.
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
// Deck builder sync (subscriptions absorbed from useDeckBuilderSync hook)
// ---------------------------------------------------------------------------

const syncDeckWithPicks = makeSyncDeckWithPicks(useLiveStore.getState);
const debouncedSyncDeckWithPicks = makeDebouncedSyncDeckWithPicks(syncDeckWithPicks);

// Sync deck with picks when card data changes. In local deck mode a synced
// pick can supersede a locally-added float (viewed seat picked it, or another
// seat took the last copy) — reconcile before the deck rebuild.
useCardStore.subscribe(
  (state) => state.seatCardList,
  () => {
    useLiveStore.getState().reconcileLocalFloats();
    debouncedSyncDeckWithPicks();
  },
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

// Local deck mode (sheet drafts): load per-seat local floats + deck state when
// the board identifies the draft as sheet-based, and reload on seat switch.
const syncLocalDeck = makeSyncLocalDeck(useLiveStore.getState, getLiveStoreRef);

useDraftStore.subscribe(
  (state) => `${state.activeDraft ?? ""}|${state.board?.isSheetDraft === true}|${state.selectedSeat ?? ""}`,
  () => syncLocalDeck(),
);
