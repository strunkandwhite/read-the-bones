import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LiveStoreState {
  // Auth
  seatToken: string | null;
  mySeat: number | null;
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  displayName: string | null;

  // Actions
  hydrateToken: (draftId: string) => void;
  fetchMySeat: () => Promise<void>;
  toggleAutoPick: () => Promise<void>;
  updateDisplayName: (name: string) => Promise<void>;
  updateAutoPickMode: (mode: "resilient" | "cautious") => Promise<void>;
  refreshSettings: () => Promise<void>;
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
    } else {
      useLiveStore.setState({
        seatToken: null,
        mySeat: null,
        autoPick: true,
        autoPickMode: "resilient",
        displayName: null,
      });
    }
  },
);
