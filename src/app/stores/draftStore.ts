import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LiveDraftStatus {
  // Fields unique to liveDraftStatus (not present in BoardData)
  latestPickN: number;
  nextSeat: number | null;
  recentPicks: { pickN: number; seat: number; cardName: string }[];
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
  // Server's current ingestion hash — used by cardStore as the ?v= cache-buster
  // when refetching /api/cards, so the param reflects the data the client WANTS
  // (server's current state) rather than what it already has.
  ingestionHash?: string;
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
  //
  // Two separate change signals let subscribers react with the right scope:
  //   pickVersion  — a live pick landed (latestPickN advanced). Card data may
  //                  change (taken cards). Draft-stats do NOT change — they cover
  //                  completed drafts only.  Task 21 will stop triggering
  //                  fetchCardData here once card data is derived client-side.
  //   dataVersion  — ingestion/sync data changed (lastSyncedAt advanced). Both
  //                  card data AND draft-stats must be refetched.
  //
  // Seat-name changes do NOT bump either version — board consumers already
  // receive updated names directly from the poll response.
  pickVersion: number;
  dataVersion: number;
  pollCount: number;
  liveDraftStatus: LiveDraftStatus | null;
  board: BoardData | null;
  poolAsOfDraft: string | null;
  syncStatus: SyncStatusData;
  // Minimal staleness signal: true when the last /live poll failed (network or
  // non-ok response). Reset to false on next successful poll. Components may
  // show a subtle indicator when this is true.
  pollFailed: boolean;

  // Selection actions
  setSelectedDrafts: (drafts: Set<string>) => void;
  setActiveDraft: (draft: string | null) => void;
  setSelectedSeat: (seat: number | null) => void;
  setHideTaken: (hide: boolean) => void;
  hydrate: (props: { completedDraftIds: string[]; initialDraftId?: string }) => void;

  // Data actions
  setPoolAsOfDraft: (draftId: string | null) => void;
  patchSeatName: (seat: number, name: string) => void;

  // Selector: returns the effective pool-as-of draft.
  // When an active draft is selected it takes precedence; otherwise falls back
  // to the user-chosen poolAsOfDraft. One canonical computation shared by
  // Settings.tsx and cardStore.
  getEffectivePoolAsOfDraft: () => string | null;

  // Polling actions
  startPolling: () => void;
  stopPolling: () => void;
  refreshNow: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Module-scoped polling state
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 10_000;

let pollInterval: ReturnType<typeof setInterval> | null = null;
let prevPickN = -1; // -1 = no previous data (first poll)
let prevSyncedAt = "0";
let syncPollCounter = 0;

// Fetch-generation counter: each poll fetch captures the generation at START.
// refreshNow() bumps the generation so any interval response that was in-flight
// before the refreshNow fetch is considered stale and discarded by applyPollResults.
// This prevents a slow interval response from regressing liveDraftStatus/board to
// pre-pick data after a faster refreshNow response has already committed newer state.
let fetchGeneration = 0;
let appliedGeneration = -1;

// Last acknowledged /live state signature, echoed back to the server as ?since=&sig=
// for the change short-circuit. null means "no previous successful response" (first
// poll or draft switch) — ensures the first poll always fetches the full payload.
// NOTE: Task 24 will add per-seat data (queue/floatedCards) to /live for token callers;
// if that per-seat data changes between polls, the sig alone won't catch it — at that
// point this tracking will need a companion per-seat sig or be bypassed for authed polls.
let lastLiveSig: { pickN: number; sig: string } | null = null;

/** Reset module-scoped polling state (for tests). */
export function _resetPollingState() {
  prevPickN = -1;
  prevSyncedAt = "0";
  syncPollCounter = 0;
  fetchGeneration = 0;
  appliedGeneration = -1;
  lastLiveSig = null;
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

async function fetchPollData(draftId: string, generation: number) {
  // Only fetch sync-status every 3rd poll cycle (~30s) since it rarely changes
  syncPollCounter++;
  const shouldFetchSync = syncPollCounter % 3 === 0;

  // Build the /live URL with change short-circuit params if we have a prior sig.
  // The server runs two cheap queries and returns {unchanged:true} when nothing moved,
  // avoiding the heavy board queries on the common idle-poll path.
  let liveUrl = `/api/drafts/${draftId}/live`;
  if (lastLiveSig !== null) {
    liveUrl += `?since=${lastLiveSig.pickN}&sig=${encodeURIComponent(lastLiveSig.sig)}`;
  }

  const fetches: [Promise<Response>, Promise<Response> | null] = [
    fetch(liveUrl),
    shouldFetchSync ? fetch("/api/sync-status") : null,
  ];

  const liveRes = await fetches[0];
  const syncRes = fetches[1] ? await fetches[1] : null;

  let liveData = null;
  let syncData: SyncStatusData | null = null;

  const liveFailed = !liveRes.ok;
  if (liveRes.ok) {
    const json = await liveRes.json() as Record<string, unknown>;
    // Server returns {unchanged:true} when nothing changed — treat as a no-op.
    // Do NOT update lastLiveSig (it's already current), and return null liveData
    // so applyPollResults skips the board/status update and generation counters
    // are not bumped wrongly. pollFailed is also not set (response was 200 ok).
    if (!json.unchanged) {
      liveData = json;
    }
  }
  if (syncRes?.ok) {
    syncData = await syncRes.json();
  }

  return { liveData, syncData, generation, liveFailed };
}

function applyPollResults(
  liveData: Record<string, unknown> | null,
  syncData: SyncStatusData | null,
  generation: number,
) {
  // Discard responses from a generation older than the last applied generation.
  // This prevents a slow interval response that started before a refreshNow() call
  // from overwriting the newer state that refreshNow already committed.
  if (generation < appliedGeneration) return;
  appliedGeneration = generation;

  const state = useDraftStore.getState();
  let versionBump = false;

  if (liveData) {
    const status: LiveDraftStatus = {
      latestPickN: liveData.latestPickN as number,
      nextSeat: liveData.nextSeat as number | null,
      recentPicks: liveData.recentPicks as LiveDraftStatus["recentPicks"],
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
    // prevPickN must never regress: only advance it when the incoming value is higher
    // (or equal on first poll), ensuring stale responses that slipped through the
    // generation guard (same-generation concurrent fetches) can't roll back state.
    const incomingPickN = status.latestPickN as number;
    let pickBump = false;
    if (incomingPickN !== prevPickN) {
      if (prevPickN !== -1 && incomingPickN > prevPickN) pickBump = true;
      if (incomingPickN > prevPickN || prevPickN === -1) prevPickN = incomingPickN;
    }

    // Seat-name changes are intentionally NOT bumped into any version signal.
    // Board consumers receive updated seat names directly from the poll response
    // — no card or stats refetch is needed for a rename.

    // Capture the server's state sig so the next poll can send it back for the
    // change short-circuit. The sig is opaque to the client — we store it and
    // echo it without recomputing.
    const liveSig = liveData.liveSig as string | undefined;
    if (liveSig !== undefined) {
      lastLiveSig = { pickN: incomingPickN, sig: liveSig };
    }

    // Compare-before-set: keep previous object references when content is identical
    // so subscribers that use reference equality (e.g. selectors, React memoization)
    // don't re-render on idle polls where nothing actually changed.
    const prev = useDraftStore.getState();
    const nextStatus: LiveDraftStatus = prev.liveDraftStatus !== null &&
      status.latestPickN === prev.liveDraftStatus.latestPickN &&
      status.nextSeat === prev.liveDraftStatus.nextSeat &&
      status.matchCount === prev.liveDraftStatus.matchCount &&
      status.totalMatches === prev.liveDraftStatus.totalMatches &&
      JSON.stringify(status.recentPicks) === JSON.stringify(prev.liveDraftStatus.recentPicks)
      ? prev.liveDraftStatus
      : status;

    const nextBoard: BoardData = prev.board !== null &&
      board.phase === prev.board.phase &&
      board.numSeats === prev.board.numSeats &&
      board.picksPerPlayer === prev.board.picksPerPlayer &&
      JSON.stringify(board.picks) === JSON.stringify(prev.board.picks) &&
      JSON.stringify(board.seatNames) === JSON.stringify(prev.board.seatNames) &&
      JSON.stringify(board.bannedCards) === JSON.stringify(prev.board.bannedCards)
      ? prev.board
      : board;

    const stateUpdate: Partial<typeof state> = { pollCount: prev.pollCount + 1 };
    if (nextStatus !== prev.liveDraftStatus) stateUpdate.liveDraftStatus = nextStatus;
    if (nextBoard !== prev.board) stateUpdate.board = nextBoard;
    useDraftStore.setState(stateUpdate);

    if (pickBump) {
      useDraftStore.setState({ pickVersion: state.pickVersion + 1 });
    }
  }

  if (syncData) {
    if (prevSyncedAt !== "0" && syncData.lastSyncedAt !== prevSyncedAt) {
      versionBump = true;
    }
    prevSyncedAt = syncData.lastSyncedAt;
    // Only replace syncStatus reference when content has changed (stable reference avoids
    // spurious subscription fires for unchanged sync data on the every-3rd-cycle path).
    const prevSyncStatus = useDraftStore.getState().syncStatus;
    if (
      syncData.lastSyncedAt !== prevSyncStatus.lastSyncedAt ||
      syncData.syncInProgress !== prevSyncStatus.syncInProgress ||
      JSON.stringify(syncData.activeDrafts) !== JSON.stringify(prevSyncStatus.activeDrafts) ||
      syncData.ingestionHash !== prevSyncStatus.ingestionHash
    ) {
      useDraftStore.setState({ syncStatus: syncData });
    }
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
    pickVersion: 0,
    dataVersion: 0,
    pollCount: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
    pollFailed: false,

    // --- Data actions ---

    setPoolAsOfDraft: (draftId) => set({ poolAsOfDraft: draftId }),

    patchSeatName: (seat, name) => {
      set((state) => state.board ? {
        board: { ...state.board, seatNames: { ...state.board.seatNames, [String(seat)]: name } }
      } : {});
    },

    getEffectivePoolAsOfDraft: () => {
      const { activeDraft, poolAsOfDraft } = get();
      return activeDraft ?? poolAsOfDraft;
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

      // Only update selectedDrafts when the hydrated set differs from current.
      // On initial page load the store already holds the SSR completedDraftIds as
      // its default, so a same-content Set would fire the cardStore subscription
      // and trigger a duplicate fetch of data already baked into the SSR snapshot.
      const currentDrafts = get().selectedDrafts;
      const newDrafts = new Set(completedDraftIds);
      const setsEqual =
        currentDrafts.size === newDrafts.size &&
        [...newDrafts].every((id) => currentDrafts.has(id));

      set({
        activeDraft: draftId,
        hideTaken,
        selectedSeat,
        ...(setsEqual ? {} : { selectedDrafts: newDrafts }),
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
        // Capture the generation at the START of the fetch so a concurrent
        // refreshNow() that bumps the generation will make this response stale.
        const gen = fetchGeneration;
        try {
          const { liveData, syncData, liveFailed } = await fetchPollData(currentDraft, gen);
          // Update stale flag based on whether the live fetch succeeded
          if (liveFailed) {
            useDraftStore.setState({ pollFailed: true });
          } else if (liveData) {
            useDraftStore.setState({ pollFailed: false });
          }
          applyPollResults(liveData, syncData, gen);
        } catch {
          // Mark as stale so the UI can show a subtle indicator
          useDraftStore.setState({ pollFailed: true });
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
      // Bump the generation so any in-flight interval fetch becomes stale.
      const gen = ++fetchGeneration;
      try {
        const { liveData, syncData } = await fetchPollData(activeDraft, gen);
        applyPollResults(liveData, syncData, gen);
      } catch {
        // Silently ignore
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
    lastLiveSig = null; // draft switched — never reuse a sig from the previous draft
    if (activeDraft) useDraftStore.getState().startPolling();
  },
);
