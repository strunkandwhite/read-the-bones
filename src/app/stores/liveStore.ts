import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";

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
          if (data?.cards) set({ floatedCards: data.cards });
        }
      } catch {
        // ignore
      }
    },

    addFloat: async (cardName: string) => {
      const { seatToken, floatedCards: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      set({ floatedCards: [...previous, cardName] });
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/float`, {
          method: "PUT",
          headers: {
            "X-Seat-Token": seatToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_name: cardName }),
        });
        if (!res.ok) set({ floatedCards: previous });
      } catch {
        set({ floatedCards: previous });
      }
    },

    removeFloat: async (cardName: string) => {
      const { seatToken, floatedCards: previous } = get();
      const activeDraft = useDraftStore.getState().activeDraft;
      if (!seatToken || !activeDraft) return;

      set({ floatedCards: previous.filter((c) => c !== cardName) });
      try {
        const res = await fetch(`/api/drafts/${activeDraft}/float`, {
          method: "DELETE",
          headers: {
            "X-Seat-Token": seatToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ card_name: cardName }),
        });
        if (!res.ok) set({ floatedCards: previous });
      } catch {
        set({ floatedCards: previous });
      }
    },
  })),
);

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
    } else {
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
