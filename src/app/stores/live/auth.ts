/**
 * Auth action module: token hydration, seat identity, and seat settings.
 * All functions are pure factory functions receiving (set, get) from the Zustand store.
 */
import { useDraftStore } from "../draftStore";
import type { LiveStoreState, SetState, GetState } from "../liveStore";

export function makeHydrateToken(set: SetState) {
  return (draftId: string): void => {
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
  };
}

export function makeFetchMySeat(set: SetState, get: GetState, recomputePicking: () => void) {
  return async (): Promise<void> => {
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
  };
}

export function makeToggleAutoPick(set: SetState, get: GetState, recomputePicking: () => void) {
  return async (): Promise<void> => {
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
  };
}

export function makeUpdateDisplayName(set: SetState, get: GetState) {
  return async (name: string): Promise<void> => {
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
  };
}

export function makeRefreshSettings(set: SetState, get: GetState) {
  return async (): Promise<void> => {
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
  };
}

// Type re-export so consumers can reference it without importing liveStore
export type { LiveStoreState, SetState, GetState };
