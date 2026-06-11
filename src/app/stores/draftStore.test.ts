// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useDraftStore, _resetPollingState } from "./draftStore";

function resetStore() {
  useDraftStore.setState({
    selectedDrafts: new Set(),
    activeDraft: null,
    selectedSeat: null,
    hideTaken: true,
    completedDraftIds: [],
    hydrated: false,
    dataVersion: 0,
    pollCount: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
  });
  _resetPollingState();
}

// ---------------------------------------------------------------------------
// Selection state
// ---------------------------------------------------------------------------
describe("draftStore — selection state", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("has correct initial state", () => {
    const s = useDraftStore.getState();
    expect(s.selectedDrafts).toEqual(new Set());
    expect(s.activeDraft).toBeNull();
    expect(s.selectedSeat).toBeNull();
    expect(s.hideTaken).toBe(true);
    expect(s.hydrated).toBe(false);
    expect(s.dataVersion).toBe(0);
  });

  it("setSelectedDrafts updates selectedDrafts", () => {
    useDraftStore.getState().setSelectedDrafts(new Set(["a", "b"]));
    expect(useDraftStore.getState().selectedDrafts).toEqual(new Set(["a", "b"]));
  });

  it("setActiveDraft updates activeDraft and resets selectedSeat from localStorage", () => {
    // Pre-populate stored seats map
    localStorage.setItem("selectedSeats", JSON.stringify({ "draft-1": 3 }));

    useDraftStore.getState().setActiveDraft("draft-1");
    const s = useDraftStore.getState();
    expect(s.activeDraft).toBe("draft-1");
    expect(s.selectedSeat).toBe(3);
  });

  it("setActiveDraft resets selectedSeat to null when no stored seat", () => {
    useDraftStore.getState().setActiveDraft("draft-unknown");
    expect(useDraftStore.getState().selectedSeat).toBeNull();
  });

  it("setSelectedSeat persists to localStorage selectedSeats map", () => {
    useDraftStore.getState().setActiveDraft("draft-1");
    useDraftStore.getState().setSelectedSeat(5);
    expect(useDraftStore.getState().selectedSeat).toBe(5);

    const stored = JSON.parse(localStorage.getItem("selectedSeats")!);
    expect(stored["draft-1"]).toBe(5);
  });

  it("setSelectedSeat removes entry when null", () => {
    localStorage.setItem("selectedSeats", JSON.stringify({ "draft-1": 2 }));
    useDraftStore.getState().setActiveDraft("draft-1");
    useDraftStore.getState().setSelectedSeat(null);

    const stored = JSON.parse(localStorage.getItem("selectedSeats")!);
    expect(stored["draft-1"]).toBeUndefined();
  });

  it("setHideTaken persists to localStorage", () => {
    useDraftStore.getState().setHideTaken(false);
    expect(localStorage.getItem("hideTaken")).toBe("false");
    expect(useDraftStore.getState().hideTaken).toBe(false);
  });

  it("hydrate restores from localStorage", () => {
    localStorage.setItem("activeDraft", "saved-draft");
    localStorage.setItem("hideTaken", "false");
    localStorage.setItem("selectedSeats", JSON.stringify({ "saved-draft": 7 }));

    useDraftStore.getState().hydrate({ completedDraftIds: ["c1", "c2"] });
    const s = useDraftStore.getState();
    expect(s.activeDraft).toBe("saved-draft");
    expect(s.hideTaken).toBe(false);
    expect(s.selectedSeat).toBe(7);
    expect(s.selectedDrafts).toEqual(new Set(["c1", "c2"]));
    expect(s.completedDraftIds).toEqual(["c1", "c2"]);
    expect(s.hydrated).toBe(true);
  });

  it("hydrate with initialDraftId takes priority over localStorage", () => {
    localStorage.setItem("activeDraft", "old-draft");

    useDraftStore.getState().hydrate({
      completedDraftIds: ["c1"],
      initialDraftId: "url-draft",
    });
    expect(useDraftStore.getState().activeDraft).toBe("url-draft");
  });

  it("hydrate falls back to SSR completedDraftIds for selectedDrafts", () => {
    useDraftStore.getState().hydrate({ completedDraftIds: ["d1", "d2"] });
    expect(useDraftStore.getState().selectedDrafts).toEqual(new Set(["d1", "d2"]));
  });
});

// ---------------------------------------------------------------------------
// poolAsOfDraft
// ---------------------------------------------------------------------------
describe("draftStore — poolAsOfDraft", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("defaults to null", () => {
    expect(useDraftStore.getState().poolAsOfDraft).toBeNull();
  });

  it("setPoolAsOfDraft sets and clears the value", () => {
    useDraftStore.getState().setPoolAsOfDraft("draft-1");
    expect(useDraftStore.getState().poolAsOfDraft).toBe("draft-1");

    useDraftStore.getState().setPoolAsOfDraft(null);
    expect(useDraftStore.getState().poolAsOfDraft).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// patchSeatName
// ---------------------------------------------------------------------------
describe("draftStore — patchSeatName", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
  });

  it("updates board.seatNames when board is present", () => {
    useDraftStore.setState({
      board: {
        picks: [],
        numSeats: 8,
        picksPerPlayer: 45,
        phase: "drafting",
        seatNames: { "1": "Alice", "2": "Bob" },
        bannedCards: [],
      },
    });

    useDraftStore.getState().patchSeatName(2, "Charlie");
    const board = useDraftStore.getState().board!;
    expect(board.seatNames["2"]).toBe("Charlie");
    // Other seat names are preserved
    expect(board.seatNames["1"]).toBe("Alice");
  });

  it("is a no-op when board is null", () => {
    expect(useDraftStore.getState().board).toBeNull();
    useDraftStore.getState().patchSeatName(1, "Test");
    expect(useDraftStore.getState().board).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Polling logic
// ---------------------------------------------------------------------------
describe("draftStore — polling", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    useDraftStore.getState().stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockFetchResponses(
    liveData: Record<string, unknown>,
    syncData: Record<string, unknown>,
  ) {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/live")) {
        return new Response(JSON.stringify(liveData), { status: 200 });
      }
      if (url.includes("/api/sync-status")) {
        return new Response(JSON.stringify(syncData), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    return fetchSpy;
  }

  const baseLiveData = {
    phase: "drafting",
    latestPickN: 5,
    nextSeat: 2,
    recentPicks: [],
    seatNames: { "1": "Alice", "2": "Bob" },
    numSeats: 8,
    picksPerPlayer: 45,
    matchCount: 0,
    totalMatches: 28,
    picks: [{ pickN: 1, seat: 1, cardName: "Bolt", oracleId: "x", colorIdentity: ["R"], manaCost: "{R}" }],
    bannedCards: [],
  };

  const baseSyncData = {
    lastSyncedAt: "2026-01-01T00:00:00Z",
    syncInProgress: false,
    activeDrafts: [],
  };

  it("startPolling triggers fetch of /live and /sync-status", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useDraftStore.getState().startPolling();

    // Advance through 3 full poll cycles so the 3rd cycle (syncPollCounter % 3 === 0)
    // triggers the sync-status fetch (poll interval is 10s, so 20_001ms covers cycles 2+3)
    await vi.advanceTimersByTimeAsync(20_001);

    const urls = fetchSpy.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    });
    expect(urls).toContain("/api/drafts/draft-1/live");
    expect(urls).toContain("/api/sync-status");
  });

  it("stopPolling clears interval", async () => {
    mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useDraftStore.getState().startPolling();
    await vi.advanceTimersByTimeAsync(0);

    useDraftStore.getState().stopPolling();
    const callCount = vi.mocked(globalThis.fetch).mock.calls.length;

    await vi.advanceTimersByTimeAsync(20_000);
    // No new fetches after stopping
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(callCount);
  });

  it("refreshNow fetches immediately", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();

    expect(fetchSpy).toHaveBeenCalled();
    expect(useDraftStore.getState().liveDraftStatus).not.toBeNull();
  });

  it("dataVersion increments when latestPickN changes", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();
    const v1 = useDraftStore.getState().dataVersion;

    // Change latestPickN
    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/live")) {
        return new Response(JSON.stringify({ ...baseLiveData, latestPickN: 10 }), { status: 200 });
      }
      return new Response(JSON.stringify(baseSyncData), { status: 200 });
    });

    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().dataVersion).toBe(v1 + 1);
  });

  it("dataVersion increments when seatNames changes", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();
    const v1 = useDraftStore.getState().dataVersion;

    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/live")) {
        return new Response(
          JSON.stringify({ ...baseLiveData, seatNames: { "1": "Charlie", "2": "Bob" } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(baseSyncData), { status: 200 });
    });

    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().dataVersion).toBe(v1 + 1);
  });

  it("dataVersion increments when lastSyncedAt changes", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    // Calls 1–3 (counter 1→3): the 3rd call fetches sync-status and establishes prevSyncedAt
    await useDraftStore.getState().refreshNow();
    await useDraftStore.getState().refreshNow();
    await useDraftStore.getState().refreshNow();
    const v1 = useDraftStore.getState().dataVersion;

    fetchSpy.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/live")) {
        return new Response(JSON.stringify(baseLiveData), { status: 200 });
      }
      return new Response(
        JSON.stringify({ ...baseSyncData, lastSyncedAt: "2026-02-01T00:00:00Z" }),
        { status: 200 },
      );
    });

    // Calls 4–6 (counter 4→6): the 6th call fetches sync-status with the new timestamp,
    // detects the change, and triggers a version bump
    await useDraftStore.getState().refreshNow();
    await useDraftStore.getState().refreshNow();
    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().dataVersion).toBe(v1 + 1);
  });

  it("dataVersion does NOT increment when poll returns same data", async () => {
    mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();
    const v1 = useDraftStore.getState().dataVersion;

    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().dataVersion).toBe(v1);
  });

  it("starts polling when activeDraft is set via setActiveDraft", async () => {
    const fetchSpy = mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.getState().setActiveDraft("draft-1");

    // Wait for the subscription and initial fetch to fire
    await vi.advanceTimersByTimeAsync(0);

    const urls = fetchSpy.mock.calls.map((c) => {
      const input = c[0];
      return typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    });
    expect(urls).toContain("/api/drafts/draft-1/live");
  });

  it("stops polling when activeDraft is cleared", async () => {
    mockFetchResponses(baseLiveData, baseSyncData);

    useDraftStore.getState().setActiveDraft("draft-1");
    await vi.advanceTimersByTimeAsync(0);

    useDraftStore.getState().setActiveDraft(null);
    const callCountAfterStop = vi.mocked(globalThis.fetch).mock.calls.length;

    // Advance well past the poll interval — no new fetches should occur
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(callCountAfterStop);
  });

  it("stale interval response resolving after refreshNow is discarded — no state regression, no spurious dataVersion bump", async () => {
    // Simulate the race: an interval tick starts a fetch (generation 0) that is
    // still in-flight when refreshNow() fires (generation 1, resolves first with
    // newer pick data). The interval response then resolves — it should be
    // discarded entirely, leaving the board at the refreshNow state.

    useDraftStore.setState({ activeDraft: "draft-1" });

    // Controlled promise for the interval fetch (will resolve LAST with stale data)
    let resolveInterval!: (r: Response) => void;
    const intervalPromise = new Promise<Response>((res) => { resolveInterval = res; });

    // Controlled promise for the refreshNow fetch (will resolve FIRST with newer data)
    let resolveRefresh!: (r: Response) => void;
    const refreshPromise = new Promise<Response>((res) => { resolveRefresh = res; });

    const staleData = { ...baseLiveData, latestPickN: 5 };
    const freshData = { ...baseLiveData, latestPickN: 10 };

    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (!url.includes("/live")) {
        return new Response(JSON.stringify(baseSyncData), { status: 200 });
      }
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First call: the interval fetch — return the controlled promise (stale, resolves last)
        return intervalPromise;
      }
      // Second call: refreshNow fetch — return the controlled promise (fresh, resolves first)
      return refreshPromise;
    });

    // Start polling — triggers the interval's immediate fetch (generation 0, call #1)
    useDraftStore.getState().startPolling();

    // Kick off refreshNow concurrently — bumps generation to 1, starts call #2
    const refreshDone = useDraftStore.getState().refreshNow();

    // Resolve refreshNow (generation 1) FIRST with the newer pick data
    resolveRefresh(new Response(JSON.stringify(freshData), { status: 200 }));
    await refreshDone;

    const afterRefresh = useDraftStore.getState();
    expect(afterRefresh.liveDraftStatus?.latestPickN).toBe(10);
    const versionAfterRefresh = afterRefresh.dataVersion;

    // Now resolve the stale interval response (generation 0) — should be discarded
    resolveInterval(new Response(JSON.stringify(staleData), { status: 200 }));
    // Let all microtasks/promises flush
    await vi.advanceTimersByTimeAsync(0);

    const afterStale = useDraftStore.getState();
    // Board must NOT regress to the stale pick count
    expect(afterStale.liveDraftStatus?.latestPickN).toBe(10);
    expect(afterStale.board?.picks).toEqual(freshData.picks);
    // No spurious dataVersion bump from the stale response
    expect(afterStale.dataVersion).toBe(versionAfterRefresh);
  });
});

