import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { track } from "@vercel/analytics/react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveDraftStatus {
  phase: string;
  latestPickN: number;
  nextSeat: number | null;
  recentPicks: { pickN: number; seat: number; cardName: string }[];
  seatNames: Record<string, string>;
  numSeats: number;
  picksPerPlayer: number;
  matchCount: number;
  totalMatches: number;
}

export interface BoardData {
  picks: {
    pickN: number;
    seat: number;
    cardName: string;
    oracleId: string;
    colorIdentity: string[];
    manaCost: string;
  }[];
  numSeats: number;
  picksPerPlayer: number;
  phase: string;
  seatNames: Record<string, string>;
  bannedCards: string[];
}

export type ActiveDraftInfo = { id: string; numSeats: number };

interface SyncStatusData {
  lastSyncedAt: string;
  syncInProgress: boolean;
  activeDrafts: ActiveDraftInfo[];
}

// ---------------------------------------------------------------------------
// Store state & actions
// ---------------------------------------------------------------------------

interface DraftState {
  // Selection
  selectedDrafts: Set<string>;
  activeDraft: string | null;
  selectedSeat: number | null;
  hideTaken: boolean;
  completedDraftIds: string[];
  hydrated: boolean;

  // Polling / data
  dataVersion: number;
  liveDraftStatus: LiveDraftStatus | null;
  board: BoardData | null;
  poolAsOfDraft: string | null;
  syncStatus: SyncStatusData;
  manualSyncInFlight: boolean;

  // Selection actions
  setSelectedDrafts: (drafts: Set<string>) => void;
  setActiveDraft: (draft: string | null) => void;
  setSelectedSeat: (seat: number | null) => void;
  setHideTaken: (hide: boolean) => void;
  hydrate: (props: { completedDraftIds: string[]; initialDraftId?: string }) => void;

  // Data actions
  setPoolAsOfDraft: (draftId: string | null) => void;
  patchSeatName: (seat: number, name: string) => void;

  // Polling actions
  startPolling: () => void;
  stopPolling: () => void;
  refreshNow: () => Promise<void>;

  // Sync actions
  triggerSync: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-scoped polling state
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000;

let pollInterval: ReturnType<typeof setInterval> | null = null;
let prevPickN = -1; // -1 = no previous data (first poll)
let prevSeatNamesKey = "";
let prevSyncedAt = "0";

/** Reset module-scoped polling state (for tests). */
export function _resetPollingState() {
  prevPickN = -1;
  prevSeatNamesKey = "";
  prevSyncedAt = "0";
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStoredSeat(draftId: string | null): number | null {
  if (!draftId) return null;
  const raw = localStorage.getItem("selectedSeats");
  if (!raw) return null;
  const seatsMap = JSON.parse(raw) as Record<string, number>;
  return draftId in seatsMap ? seatsMap[draftId] : null;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchPollData(draftId: string) {
  const [liveRes, syncRes] = await Promise.all([
    fetch(`/api/drafts/${draftId}/live`),
    fetch("/api/sync-status"),
  ]);

  let liveData = null;
  let syncData: SyncStatusData | null = null;

  if (liveRes.ok) {
    liveData = await liveRes.json();
  }
  if (syncRes.ok) {
    syncData = await syncRes.json();
  }

  return { liveData, syncData };
}

function applyPollResults(
  liveData: Record<string, unknown> | null,
  syncData: SyncStatusData | null,
) {
  const state = useDraftStore.getState();
  let versionBump = false;

  if (liveData) {
    const status: LiveDraftStatus = {
      phase: liveData.phase as string,
      latestPickN: liveData.latestPickN as number,
      nextSeat: liveData.nextSeat as number | null,
      recentPicks: liveData.recentPicks as LiveDraftStatus["recentPicks"],
      seatNames: liveData.seatNames as Record<string, string>,
      numSeats: liveData.numSeats as number,
      picksPerPlayer: liveData.picksPerPlayer as number,
      matchCount: liveData.matchCount as number,
      totalMatches: liveData.totalMatches as number,
    };

    const board: BoardData = {
      picks: liveData.picks as BoardData["picks"],
      numSeats: liveData.numSeats as number,
      picksPerPlayer: liveData.picksPerPlayer as number,
      phase: liveData.phase as string,
      seatNames: liveData.seatNames as Record<string, string>,
      bannedCards: liveData.bannedCards as string[],
    };

    // Detect pick changes. prevPickN === -1 means "first poll, no previous data" —
    // skip the version bump to avoid double-fetching card data (SSR hydration already
    // provided initial data). Subsequent changes (including 0→1) correctly bump.
    if ((status.latestPickN as number) !== prevPickN) {
      if (prevPickN !== -1) versionBump = true;
      prevPickN = status.latestPickN;
    }

    const seatNamesKey = JSON.stringify(status.seatNames ?? {});
    if (prevSeatNamesKey && seatNamesKey !== prevSeatNamesKey) {
      versionBump = true;
    }
    prevSeatNamesKey = seatNamesKey;

    useDraftStore.setState({ liveDraftStatus: status, board });
  }

  if (syncData) {
    if (prevSyncedAt !== "0" && syncData.lastSyncedAt !== prevSyncedAt) {
      versionBump = true;
    }
    prevSyncedAt = syncData.lastSyncedAt;
    useDraftStore.setState({ syncStatus: syncData });
  }

  if (versionBump) {
    useDraftStore.setState({ dataVersion: state.dataVersion + 1 });
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDraftStore = create<DraftState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    selectedDrafts: new Set<string>(),
    activeDraft: null,
    selectedSeat: null,
    hideTaken: true,
    completedDraftIds: [],
    hydrated: false,
    dataVersion: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
    manualSyncInFlight: false,

    // --- Data actions ---

    setPoolAsOfDraft: (draftId) => set({ poolAsOfDraft: draftId }),

    patchSeatName: (seat, name) => {
      set((state) => state.board ? {
        board: { ...state.board, seatNames: { ...state.board.seatNames, [String(seat)]: name } }
      } : {});
    },

    // --- Selection actions ---

    setSelectedDrafts: (drafts) => set({ selectedDrafts: drafts }),

    setActiveDraft: (draft) => {
      set({ activeDraft: draft, selectedSeat: getStoredSeat(draft) });
      if (draft) {
        localStorage.setItem("activeDraft", draft);
      } else {
        localStorage.removeItem("activeDraft");
      }
    },

    setSelectedSeat: (seat) => {
      set({ selectedSeat: seat });
      const { activeDraft } = get();
      if (!activeDraft) return;
      const raw = localStorage.getItem("selectedSeats");
      const seatsMap: Record<string, number> = raw ? JSON.parse(raw) : {};
      if (seat === null) {
        delete seatsMap[activeDraft];
      } else {
        seatsMap[activeDraft] = seat;
      }
      localStorage.setItem("selectedSeats", JSON.stringify(seatsMap));
    },

    setHideTaken: (hide) => {
      set({ hideTaken: hide });
      localStorage.setItem("hideTaken", String(hide));
    },

    hydrate: ({ completedDraftIds, initialDraftId }) => {
      const draftId = initialDraftId ?? localStorage.getItem("activeDraft");
      let hideTaken = true;
      const storedHideTaken = localStorage.getItem("hideTaken");
      if (storedHideTaken !== null) hideTaken = storedHideTaken !== "false";

      let selectedSeat: number | null = null;
      if (draftId) {
        const storedSeats = localStorage.getItem("selectedSeats");
        if (storedSeats) {
          const seatsMap = JSON.parse(storedSeats) as Record<string, number>;
          if (draftId in seatsMap) selectedSeat = seatsMap[draftId];
        }
      }

      set({
        activeDraft: draftId,
        hideTaken,
        selectedSeat,
        selectedDrafts: new Set(completedDraftIds),
        completedDraftIds,
        hydrated: true,
      });
    },

    // --- Polling actions ---

    startPolling: () => {
      const { activeDraft } = get();
      if (!activeDraft) return;

      // Fetch immediately
      const doFetch = async () => {
        const { activeDraft: currentDraft } = useDraftStore.getState();
        if (!currentDraft) return;
        try {
          const { liveData, syncData } = await fetchPollData(currentDraft);
          applyPollResults(liveData, syncData);
        } catch {
          // Silently ignore transient fetch errors during polling
        }
      };

      doFetch();

      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(doFetch, POLL_INTERVAL_MS);
    },

    stopPolling: () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
    },

    refreshNow: async () => {
      const { activeDraft } = get();
      if (!activeDraft) return;
      try {
        const { liveData, syncData } = await fetchPollData(activeDraft);
        applyPollResults(liveData, syncData);
      } catch {
        // Silently ignore
      }
    },

    // --- Sync actions ---

    triggerSync: async () => {
      set({ manualSyncInFlight: true });
      const start = performance.now();
      const { activeDraft } = get();
      try {
        const res = await fetch("/api/sync", { method: "POST" });
        let syncCompleted = false;
        if (res.ok) {
          const data = await res.json();
          if (data.lastSyncedAt) {
            prevSyncedAt = data.lastSyncedAt;
          }
          syncCompleted = data.status === "completed";
        } else {
          track("sync_failed", {
            error: `HTTP ${res.status}`,
            draft: activeDraft ?? "unknown",
          });
        }

        // Refetch status
        if (activeDraft) {
          try {
            const syncRes = await fetch("/api/sync-status");
            if (syncRes.ok) {
              const syncData: SyncStatusData = await syncRes.json();
              prevSyncedAt = syncData.lastSyncedAt;
              set({ syncStatus: syncData });
            }
          } catch {
            // ignore
          }
        }

        if (syncCompleted) {
          track("sync_completed", {
            duration_ms: Math.round(performance.now() - start),
          });
          set({ dataVersion: get().dataVersion + 1 });
        }
      } catch (err) {
        track("sync_failed", {
          error: String(err).slice(0, 255),
          draft: activeDraft ?? "unknown",
        });
      } finally {
        set({ manualSyncInFlight: false });
      }
    },
  })),
);

// ---------------------------------------------------------------------------
// Auto-manage polling on activeDraft changes
// ---------------------------------------------------------------------------

useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    useDraftStore.getState().stopPolling();
    prevPickN = -1;
    prevSeatNamesKey = "";
    if (activeDraft) useDraftStore.getState().startPolling();
  },
);
