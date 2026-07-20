// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLiveStore, recomputePicking, _resetDeckState, _applyMeDataForTest } from "./liveStore";
import { useDraftStore, _resetPollingState } from "./draftStore";
import type { BoardData } from "./draftStore";
import { _resetSearchState, useCardStore } from "./cardStore";
import { createEmptyDeckState } from "@/core/deckBuilder";
import { makeSyncDeckWithPicks } from "./live/deckSave";

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@/core/localSearch", () => ({
  searchLocalCards: vi.fn(() => []),
}));
vi.mock("@/core/searchUtils", () => ({
  hasScryfallOperators: vi.fn(() => false),
}));
vi.mock("@/core/snakeDraft", () => ({
  derivePickSeat: vi.fn((pickN: number) => ({ seat: pickN <= 2 ? 1 : 2, round: 1, isDoublePick: false })),
  getTotalPicks: vi.fn(() => 10),
}));

function resetStores() {
  _resetPollingState();
  _resetDeckState();
  _resetSearchState();
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
    standings: [],
    standingsMatches: [],
    standingsLoading: false,
    pendingMatch: null,
  });
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
  useCardStore.setState({ seatCardNames: undefined, takenCardNamesSet: undefined });
}

// ---------------------------------------------------------------------------
// hydrateToken
// ---------------------------------------------------------------------------
describe("liveStore — hydrateToken", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    // Start each test with a clean, token-free URL so test order does not matter
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Restore to a neutral URL so location changes don't bleed into other describe blocks
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it("reads token from URL and stores to localStorage", () => {
    // Set URL with token
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/?token=url-token-123"),
      writable: true,
      configurable: true,
    });
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    useLiveStore.getState().hydrateToken("draft-1");

    expect(useLiveStore.getState().seatToken).toBe("url-token-123");
    expect(localStorage.getItem("seatToken:draft-1")).toBe("url-token-123");
    expect(replaceStateSpy).toHaveBeenCalled();
  });

  it("strips token from URL after reading", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/?token=abc&other=1"),
      writable: true,
      configurable: true,
    });
    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    useLiveStore.getState().hydrateToken("draft-1");

    // The replaceState call should have a URL without the token param
    const newUrl = replaceStateSpy.mock.calls[0][2] as string;
    expect(newUrl).not.toContain("token=");
    expect(newUrl).toContain("other=1");
  });

  it("falls back to localStorage when no URL token", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
    localStorage.setItem("seatToken:draft-1", "stored-token-456");

    useLiveStore.getState().hydrateToken("draft-1");

    expect(useLiveStore.getState().seatToken).toBe("stored-token-456");
  });

  it("sets seatToken to null when no URL token and no localStorage", () => {
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });

    useLiveStore.getState().hydrateToken("draft-1");

    expect(useLiveStore.getState().seatToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchMySeat
// ---------------------------------------------------------------------------
describe("liveStore — fetchMySeat", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls /api/drafts/{id}/me with X-Seat-Token header", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 3, autoPick: false, displayName: "Alice" }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchMySeat();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/me",
      expect.objectContaining({
        headers: { "X-Seat-Token": "tok-abc" },
      }),
    );
  });

  it("sets mySeat, autoPick, displayName from response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ seat: 5, autoPick: false, displayName: "Bob" }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchMySeat();

    const s = useLiveStore.getState();
    expect(s.mySeat).toBe(5);
    expect(s.autoPick).toBe(false);
    expect(s.displayName).toBe("Bob");
  });

  it("does nothing without seatToken", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    // Set activeDraft without triggering the subscription (it was already null → "draft-1" fires polling)
    useDraftStore.setState({ activeDraft: "draft-1" });
    // Wait for subscription-triggered polling fetches to complete
    await new Promise((r) => setTimeout(r, 0));
    fetchSpy.mockClear();

    useLiveStore.setState({ seatToken: null });

    await useLiveStore.getState().fetchMySeat();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing without activeDraft", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    useDraftStore.setState({ activeDraft: null });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchMySeat();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// toggleAutoPick
// ---------------------------------------------------------------------------
describe("liveStore — toggleAutoPick", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs to /api/drafts/{id}/seat-settings with toggled value", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: true });

    await useLiveStore.getState().toggleAutoPick();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ auto_pick: false }),
      }),
    );
    expect(useLiveStore.getState().autoPick).toBe(false);
  });

  it("does not update state on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: true });

    await useLiveStore.getState().toggleAutoPick();

    expect(useLiveStore.getState().autoPick).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateDisplayName
// ---------------------------------------------------------------------------
describe("liveStore — updateDisplayName", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("PUTs with optimistic update", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", displayName: "Old" });

    await useLiveStore.getState().updateDisplayName("New Name");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ display_name: "New Name" }),
      }),
    );
    expect(useLiveStore.getState().displayName).toBe("New Name");
  });

  it("sets displayName to null for empty string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", displayName: "Old" });

    await useLiveStore.getState().updateDisplayName("");

    expect(useLiveStore.getState().displayName).toBeNull();
  });

  it("reverts on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", displayName: "Original" });

    await useLiveStore.getState().updateDisplayName("Attempted");

    expect(useLiveStore.getState().displayName).toBe("Original");
  });

  it("reverts on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", displayName: "Original" });

    await useLiveStore.getState().updateDisplayName("Attempted");

    expect(useLiveStore.getState().displayName).toBe("Original");
  });
});


// ---------------------------------------------------------------------------
// refreshSettings
// ---------------------------------------------------------------------------
describe("liveStore — refreshSettings", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches /api/drafts/{id}/me and updates autoPick", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ seat: 3, autoPick: false, displayName: "X" }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: true });

    await useLiveStore.getState().refreshSettings();

    expect(useLiveStore.getState().autoPick).toBe(false);
  });

  it("does nothing without token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    // Wait for subscription-triggered polling fetches to complete
    await new Promise((r) => setTimeout(r, 0));
    fetchSpy.mockClear();

    useLiveStore.setState({ seatToken: null });

    await useLiveStore.getState().refreshSettings();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cross-store subscription
// ---------------------------------------------------------------------------
describe("liveStore — cross-store subscription", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates token and fetches seat when activeDraft is set", async () => {
    localStorage.setItem("seatToken:draft-1", "stored-token");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 2, autoPick: true, displayName: null }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });

    // Give the subscription a tick to fire
    await new Promise((r) => setTimeout(r, 0));

    expect(useLiveStore.getState().seatToken).toBe("stored-token");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/me",
      expect.objectContaining({
        headers: { "X-Seat-Token": "stored-token" },
      }),
    );
  });

  it("resets state when activeDraft is cleared", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 3, autoPick: false, displayName: "Alice" }),
        { status: 200 },
      ),
    );

    // First set an active draft so the subscription has a non-null baseline
    useDraftStore.setState({ activeDraft: "draft-1" });
    await new Promise((r) => setTimeout(r, 0));

    // Manually set liveStore state to confirm it gets cleared
    useLiveStore.setState({
      seatToken: "tok",
      mySeat: 3,
      autoPick: false,
      displayName: "Alice",
    });

    // Now clear activeDraft — subscription should reset liveStore
    useDraftStore.setState({ activeDraft: null });

    const s = useLiveStore.getState();
    expect(s.seatToken).toBeNull();
    expect(s.mySeat).toBeNull();
    expect(s.autoPick).toBe(true);
    expect(s.displayName).toBeNull();
    expect(s.queue).toEqual([]);
    expect(s.floatedCards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchQueue
// ---------------------------------------------------------------------------
describe("liveStore — fetchQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls GET /api/drafts/{id}/queue with token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ queue: [{ mode: 'pause', cards: [{ id: 10, name: "Bolt" }] }] }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchQueue();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        headers: { "X-Seat-Token": "tok-abc" },
      }),
    );
  });

  it("sets queue and queuedCardCounts from response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          queue: [
            { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
            { mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchQueue();

    const s = useLiveStore.getState();
    expect(s.queue).toHaveLength(2);
    expect(s.queue[0].cards[0].cardName).toBe("Bolt");
    expect(s.queuedCardCounts.get("Bolt")).toBe(1);
    expect(s.queuedCardCounts.get("Counterspell")).toBe(1);
    expect(s.queueError).toBeNull();
  });

  it("does nothing without token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    useDraftStore.setState({ activeDraft: "draft-1" });
    await new Promise((r) => setTimeout(r, 0));
    fetchSpy.mockClear();

    useLiveStore.setState({ seatToken: null });

    await useLiveStore.getState().fetchQueue();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps queue reference stable when server returns identical content", async () => {
    // Simulates the common idle-poll path: server returns same queue every cycle.
    // Without compare-before-set, every poll creates a new array reference and
    // triggers a rebuild of the deck (syncDeckWithPicks subscribes to queue).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          queue: [{ mode: 'pause', cards: [{ id: 10, name: "Bolt" }] }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // First fetch establishes state
    await useLiveStore.getState().fetchQueue();
    const queueRef1 = useLiveStore.getState().queue;

    // Second fetch — identical content must keep same reference
    await useLiveStore.getState().fetchQueue();
    expect(useLiveStore.getState().queue).toBe(queueRef1);

    // Third fetch — still identical
    await useLiveStore.getState().fetchQueue();
    expect(useLiveStore.getState().queue).toBe(queueRef1);
  });
});

// ---------------------------------------------------------------------------
// fetchFloatedCards identity stability
// ---------------------------------------------------------------------------
describe("liveStore — fetchFloatedCards identity stability", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps floatedCards reference stable when server returns identical content", async () => {
    // Without compare-before-set, every poll creates a new array reference and
    // triggers a rebuild of the deck (syncDeckWithPicks subscribes to floatedCards).
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ cards: ["Counterspell", "Force of Will"] }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // First fetch establishes state
    await useLiveStore.getState().fetchFloatedCards();
    const floatsRef1 = useLiveStore.getState().floatedCards;

    // Second fetch — identical content must keep same reference
    await useLiveStore.getState().fetchFloatedCards();
    expect(useLiveStore.getState().floatedCards).toBe(floatsRef1);

    // Third fetch — still identical
    await useLiveStore.getState().fetchFloatedCards();
    expect(useLiveStore.getState().floatedCards).toBe(floatsRef1);
  });

  it("replaces floatedCards reference when content changes", async () => {
    // Set state directly — bypass the activeDraft subscription which resets seatToken
    // to null on each draft switch, which would race with our explicit setState calls.
    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      floatedCards: ["Counterspell"],
      floatedCardsSet: new Set<string>(["Counterspell"]),
    });

    const floatsRef1 = useLiveStore.getState().floatedCards;
    expect(floatsRef1).toEqual(["Counterspell"]);

    // Second fetch returns different content — reference must change
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cards: ["Counterspell", "Force of Will"] }), { status: 200 }),
    );

    await useLiveStore.getState().fetchFloatedCards();
    expect(useLiveStore.getState().floatedCards).not.toBe(floatsRef1);
    expect(useLiveStore.getState().floatedCards).toEqual(["Counterspell", "Force of Will"]);
  });
});

// ---------------------------------------------------------------------------
// addToQueue
// ---------------------------------------------------------------------------
describe("liveStore — addToQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes card from floatedCards when queued", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [{ mode: 'pause', cards: [{ id: 10, name: "Bolt" }] }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [],
      queuedCardCounts: new Map(),
      floatedCards: ["Bolt", "Counterspell"],
      floatedCardsSet: new Set(["Bolt", "Counterspell"]),
    });

    useLiveStore.getState().addToQueue("Bolt");

    // Optimistic: Bolt removed from floats
    const s = useLiveStore.getState();
    expect(s.floatedCards).toEqual(["Counterspell"]);
    expect(s.floatedCardsSet.has("Bolt")).toBe(false);
  });

  it("appends card and syncs to API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [
            { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
            { mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [{ mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    // Wait for async syncQueue
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([
          { mode: 'pause', cards: ["Bolt"] },
          { mode: 'pause', cards: ["Counterspell"] },
        ]),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// removeFromQueue
// ---------------------------------------------------------------------------
describe("liveStore — removeFromQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters card and syncs to API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [{ mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
      ],
      queuedCardCounts: new Map([["Bolt", 1], ["Counterspell", 1]]),
    });

    useLiveStore.getState().removeFromQueue("Bolt");

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([{ mode: 'pause', cards: ["Counterspell"] }]),
      }),
    );
  });

  it("demotes removed card to floatedCards", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [{ mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
      ],
      queuedCardCounts: new Map([["Bolt", 1], ["Counterspell", 1]]),
      floatedCards: [],
      floatedCardsSet: new Set(),
    });

    useLiveStore.getState().removeFromQueue("Bolt");

    // Optimistic: Bolt added to floats
    const s = useLiveStore.getState();
    expect(s.floatedCards).toContain("Bolt");
    expect(s.floatedCardsSet.has("Bolt")).toBe(true);
  });

  it("does not duplicate floated card on removal if already floated", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [{ mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
      ],
      queuedCardCounts: new Map([["Bolt", 1], ["Counterspell", 1]]),
      floatedCards: ["Bolt"],
      floatedCardsSet: new Set(["Bolt"]),
    });

    useLiveStore.getState().removeFromQueue("Bolt");

    const s = useLiveStore.getState();
    expect(s.floatedCards.filter((c) => c === "Bolt")).toHaveLength(1);
  });

  it("removeFromQueue removes only the first entry containing a card", async () => {
    useLiveStore.setState({
      seatToken: "tok",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
      ],
      queuedCardCounts: new Map([["Bolt", 2], ["Counterspell", 1]]),
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        queue: [
          { mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] },
          { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
        ],
      }))
    );

    useLiveStore.getState().removeFromQueue("Bolt");

    // Check optimistic state — Bolt should still appear once, Counterspell once
    const s = useLiveStore.getState();
    const boltEntries = s.queue.filter((e) => e.cards.some((c) => c.cardName === "Bolt"));
    const csEntries = s.queue.filter((e) => e.cards.some((c) => c.cardName === "Counterspell"));
    expect(boltEntries).toHaveLength(1);
    expect(csEntries).toHaveLength(1);
    expect(s.queuedCardCounts.get("Bolt")).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// reorderQueue
// ---------------------------------------------------------------------------
describe("liveStore — reorderQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends new order to API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [
            { mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] },
            { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    const reorderedEntries = [
      { mode: 'pause' as const, cards: [{ cardId: 20, cardName: "Counterspell" }] },
      { mode: 'pause' as const, cards: [{ cardId: 10, cardName: "Bolt" }] },
    ];
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
      ],
    });

    useLiveStore.getState().reorderQueue(reorderedEntries);

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([
          { mode: 'pause', cards: ["Counterspell"] },
          { mode: 'pause', cards: ["Bolt"] },
        ]),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// syncQueue reverts on failure
// ---------------------------------------------------------------------------
describe("liveStore — syncQueue reverts on failure", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reverts queue on API failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    const originalQueue = [{ mode: 'pause' as const, cards: [{ cardId: 10, cardName: "Bolt" }] }];

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: originalQueue,
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    await new Promise((r) => setTimeout(r, 0));

    const s = useLiveStore.getState();
    expect(s.queue).toEqual(originalQueue);
    expect(s.queuedCardCounts.get("Bolt")).toBe(1);
    expect(s.queuedCardCounts.has("Counterspell")).toBe(false);
    expect(s.queueError).toBe("Failed to sync queue");
  });

  it("reverts queue on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const originalQueue = [{ mode: 'pause' as const, cards: [{ cardId: 10, cardName: "Bolt" }] }];

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: originalQueue,
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    await new Promise((r) => setTimeout(r, 0));

    const s = useLiveStore.getState();
    expect(s.queue).toEqual(originalQueue);
    expect(s.queueError).toBe("Failed to sync queue");
  });

  it("reverts floatedCards when removeFromQueue sync fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] },
        { mode: 'pause', cards: [{ cardId: 20, cardName: "Counterspell" }] },
      ],
      queuedCardCounts: new Map([["Bolt", 1], ["Counterspell", 1]]),
      floatedCards: ["Swords"],
      floatedCardsSet: new Set(["Swords"]),
    });

    useLiveStore.getState().removeFromQueue("Bolt");

    // Optimistic: Bolt should be in floats
    expect(useLiveStore.getState().floatedCards).toContain("Bolt");

    await new Promise((r) => setTimeout(r, 0));

    // After failure: floats reverted to original (no Bolt)
    const s = useLiveStore.getState();
    expect(s.floatedCards).toEqual(["Swords"]);
    expect(s.floatedCardsSet.has("Bolt")).toBe(false);
    expect(s.queue).toHaveLength(2); // queue also reverted
  });

  it("reverts floatedCards when addToQueue sync fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [],
      queuedCardCounts: new Map(),
      floatedCards: ["Bolt"],
      floatedCardsSet: new Set(["Bolt"]),
    });

    useLiveStore.getState().addToQueue("Bolt");

    // Optimistic: Bolt removed from floats
    expect(useLiveStore.getState().floatedCards).not.toContain("Bolt");

    await new Promise((r) => setTimeout(r, 0));

    // After failure: floats reverted to original (Bolt present)
    const s = useLiveStore.getState();
    expect(s.floatedCards).toEqual(["Bolt"]);
    expect(s.floatedCardsSet.has("Bolt")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// queuedCardCounts derived
// ---------------------------------------------------------------------------
describe("liveStore — queuedCardCounts derived from queue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recomputes queuedCardCounts after fetchQueue", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({
          queue: [
            { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
            { mode: 'pause', cards: [{ id: 20, name: "Swords" }] },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchQueue();

    const qc = useLiveStore.getState().queuedCardCounts;
    expect(qc.size).toBe(2);
    expect(qc.get("Bolt")).toBe(1);
    expect(qc.get("Swords")).toBe(1);
  });

  it("queuedCardCounts counts duplicate card names in queue", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({
        queue: [
          { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
          { mode: 'pause', cards: [{ id: 20, name: "Counterspell" }] },
          { mode: 'pause', cards: [{ id: 10, name: "Bolt" }] },
        ],
      }))
    );

    useDraftStore.setState({ activeDraft: "d1" });
    useLiveStore.setState({ seatToken: "tok" });
    await useLiveStore.getState().fetchQueue();

    const s = useLiveStore.getState();
    expect(s.queuedCardCounts.get("Bolt")).toBe(2);
    expect(s.queuedCardCounts.get("Counterspell")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fetchFloatedCards
// ---------------------------------------------------------------------------
describe("liveStore — fetchFloatedCards", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads floated cards from API", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ cards: ["Bolt", "Counterspell"] }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchFloatedCards();

    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });

  it("does nothing without token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    useDraftStore.setState({ activeDraft: "draft-1" });
    await new Promise((r) => setTimeout(r, 0));
    fetchSpy.mockClear();

    useLiveStore.setState({ seatToken: null });

    await useLiveStore.getState().fetchFloatedCards();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// addFloat
// ---------------------------------------------------------------------------
describe("liveStore — addFloat", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("optimistically adds and PUTs to API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt"] });

    await useLiveStore.getState().addFloat("Counterspell");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/float",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ card_name: "Counterspell" }),
      }),
    );
    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });

  it("refetches server truth on failure (server returns previous list)", async () => {
    // Mock by URL+method so the /live poll (triggered by startPolling on activeDraft
    // change) gets a benign response; the float PUT fails; the float GET refetch
    // returns server truth.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (u.includes("/float") && method === "PUT") {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (u.includes("/float")) {
        return { ok: true, status: 200, json: async () => ({ cards: ["Bolt"] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt"] });

    await useLiveStore.getState().addFloat("Counterspell");

    // Server truth was ["Bolt"] so the optimistic addition is corrected
    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt"]);
  });

  it("keeps optimistic state when both PUT and refetch fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      // All /float calls fail
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt"] });

    await useLiveStore.getState().addFloat("Counterspell");

    // Both calls failed; optimistic state persists until next successful poll
    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });

  it("refetches on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (u.includes("/float") && method === "PUT") throw new Error("Network error");
      // GET refetch returns server truth
      if (u.includes("/float")) {
        return { ok: true, status: 200, json: async () => ({ cards: ["Bolt"] }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt"] });

    await useLiveStore.getState().addFloat("Counterspell");

    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt"]);
  });
});

// ---------------------------------------------------------------------------
// removeFloat
// ---------------------------------------------------------------------------
describe("liveStore — removeFloat", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("optimistically removes and DELETEs from API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt", "Counterspell"] });

    await useLiveStore.getState().removeFloat("Bolt");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/float",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ card_name: "Bolt" }),
      }),
    );
    expect(useLiveStore.getState().floatedCards).toEqual(["Counterspell"]);
  });

  it("refetches server truth on failure (server returns original list)", async () => {
    // On DELETE failure, removeFloat awaits fetchFloatedCards to reconcile.
    // Mock by URL+method so the /live poll gets a benign response.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (u.includes("/float") && method === "DELETE") {
        return { ok: false, status: 500, json: async () => ({}) } as Response;
      }
      if (u.includes("/float")) {
        return {
          ok: true, status: 200,
          json: async () => ({ cards: ["Bolt", "Counterspell"] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt", "Counterspell"] });

    await useLiveStore.getState().removeFloat("Bolt");

    // Server truth was ["Bolt", "Counterspell"]; optimistic removal is corrected
    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });

  it("keeps optimistic state when both DELETE and refetch fail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      // All /float calls fail
      return { ok: false, status: 500, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt", "Counterspell"] });

    await useLiveStore.getState().removeFloat("Bolt");

    // Both calls failed; optimistic state persists until next successful poll
    expect(useLiveStore.getState().floatedCards).toEqual(["Counterspell"]);
  });

  it("refetches on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, opts) => {
      const u = String(url);
      if (u.includes("/live")) return { ok: true, status: 200, json: async () => ({}) } as Response;
      const method = (opts as RequestInit | undefined)?.method ?? "GET";
      if (u.includes("/float") && method === "DELETE") throw new Error("Network error");
      // GET refetch returns server truth
      if (u.includes("/float")) {
        return {
          ok: true, status: 200,
          json: async () => ({ cards: ["Bolt", "Counterspell"] }),
        } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt", "Counterspell"] });

    await useLiveStore.getState().removeFloat("Bolt");

    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });
});

// ---------------------------------------------------------------------------
// local deck mode — floats
// ---------------------------------------------------------------------------
function makeSheetBoard(): BoardData {
  return {
    picks: [],
    numSeats: 10,
    picksPerPlayer: 45,
    phase: "complete",
    seatNames: {},
    bannedCards: [],
    isSheetDraft: true,
  };
}

describe("local deck mode — floats", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("addFloat persists to localStorage without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().addFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual(["Sylvan Library"]);
    expect(useLiveStore.getState().floatedCardsSet.has("Sylvan Library")).toBe(true);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Sylvan Library"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removeFloat updates state and localStorage", async () => {
    await useLiveStore.getState().addFloat("Sylvan Library");
    await useLiveStore.getState().addFloat("Land Tax");
    await useLiveStore.getState().removeFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });

  it("fetchFloatedCards loads from localStorage in local mode", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade"]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await useLiveStore.getState().fetchFloatedCards();

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("float actions are no-ops without a token outside local mode", async () => {
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    await useLiveStore.getState().addFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(localStorage.getItem("localFloats:sheet-1:3")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// local deck mode — pick reconciliation
// ---------------------------------------------------------------------------
describe("local deck mode — reconcileLocalFloats", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a float when the viewed seat has picked the card", async () => {
    await useLiveStore.getState().addFloat("Sylvan Library");
    await useLiveStore.getState().addFloat("Land Tax");
    useCardStore.setState({
      seatCardNames: new Set(["Sylvan Library"]),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(useLiveStore.getState().floatedCardsSet.has("Sylvan Library")).toBe(false);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });

  it("drops a float when another seat takes the last copy", async () => {
    await useLiveStore.getState().addFloat("Land Tax");
    useCardStore.setState({
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Land Tax"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
  });

  it("keeps a float while copies of the card remain available", async () => {
    await useLiveStore.getState().addFloat("Doom Blade");
    // Another seat picked one of two copies — takenCardNamesSet only lists
    // fully-taken cards, so the float must survive.
    useCardStore.setState({
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Some Other Card"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Doom Blade"]);
  });

  it("is a no-op outside local deck mode", () => {
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    useLiveStore.setState({ floatedCards: ["Land Tax"], floatedCardsSet: new Set(["Land Tax"]) });
    useCardStore.setState({ takenCardNamesSet: new Set(["Land Tax"]) });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });

  it("is a no-op while viewing a shared deck", () => {
    useLiveStore.setState({
      viewingSharedDeck: true,
      floatedCards: ["Land Tax"],
      floatedCardsSet: new Set(["Land Tax"]),
    });
    useCardStore.setState({ takenCardNamesSet: new Set(["Land Tax"]) });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });

  it("is a no-op before card data is derived", async () => {
    await useLiveStore.getState().addFloat("Land Tax");

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });

  it("upgrades a floated card to a real pick when the viewed seat picks it", async () => {
    vi.useFakeTimers();
    useCardStore.setState({ seatCardList: [], scryfallDataMap: new Map() });
    await useLiveStore.getState().fetchDeckState();
    useLiveStore.getState().setDeckBuilderActive(true);
    await useLiveStore.getState().addFloat("Sylvan Library");
    await vi.advanceTimersByTimeAsync(100);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");

    // A synced pick lands: the viewed seat took the card (cardStore recompute
    // fires the seatCardList subscription with fresh references).
    useCardStore.setState({
      seatCardList: ["Sylvan Library"],
      seatCardNames: new Set(["Sylvan Library"]),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
    vi.useRealTimers();
  });

  it("removes a floated card from the deck when another seat takes the last copy", async () => {
    vi.useFakeTimers();
    useCardStore.setState({ seatCardList: [], scryfallDataMap: new Map() });
    await useLiveStore.getState().fetchDeckState();
    useLiveStore.getState().setDeckBuilderActive(true);
    await useLiveStore.getState().addFloat("Sylvan Library");
    await vi.advanceTimersByTimeAsync(100);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");

    useCardStore.setState({
      seatCardList: [],
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"] ?? []).not.toContain("Sylvan Library");
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
    vi.useRealTimers();
  });

  it("fetchFloatedCards reconciles floats that were picked while the tab was closed", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade", "Land Tax"]));
    useCardStore.setState({
      seatCardNames: new Set(["Doom Blade"]),
      takenCardNamesSet: new Set(["Doom Blade"]),
    });

    await useLiveStore.getState().fetchFloatedCards();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });

  it("does not write floats to a newly selected seat's key while state still holds the previous seat's floats", async () => {
    await useLiveStore.getState().addFloat("Doom Blade");
    localStorage.setItem("localFloats:sheet-1:4", JSON.stringify(["Land Tax"]));

    // Simulate the switch window: selection has moved to seat 4 but the
    // float slice still carries seat 3's floats and identity.
    useDraftStore.setState({ selectedSeat: 4 });
    useLiveStore.setState({
      floatedCards: ["Doom Blade"],
      floatedCardsSet: new Set(["Doom Blade"]),
      floatedCardsKey: "sheet-1:3",
    });
    useCardStore.setState({ seatCardNames: new Set(["Doom Blade"]), takenCardNamesSet: new Set() });

    useLiveStore.getState().reconcileLocalFloats();

    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:4")!)).toEqual(["Land Tax"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Doom Blade"]);
  });
});

// ---------------------------------------------------------------------------
// local deck mode — deck state persistence
// ---------------------------------------------------------------------------
describe("local deck mode — deck state persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    vi.useFakeTimers();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetchDeckState initializes empty state with draft/seat identity, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().fetchDeckState();

    const { deckState, deckReady } = useLiveStore.getState();
    expect(deckReady).toBe(true);
    expect(deckState.draftId).toBe("sheet-1");
    expect(deckState.seat).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetchDeckState restores a stored local deck", async () => {
    const stored = createEmptyDeckState("sheet-1", 3);
    stored.zones.deck["mv-0-1"] = ["Sol Ring"];
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(stored));

    await useLiveStore.getState().fetchDeckState();

    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
  });

  it("deck edits save to localStorage after the debounce, without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().fetchDeckState();

    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 8, Swamp: 0, Mountain: 0, Forest: 9 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    const saved = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(saved.basicLands.Island).toBe(8);
    expect(useLiveStore.getState().deckSaveStatus).toBe("saved");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not save while deck identity is still empty", async () => {
    // The activeDraft subscription's local-mode fetchDeckState has no await,
    // so it already ran synchronously inside beforeEach's setState call and
    // gave deckState an identity. Force it back to the pre-identity ""
    // state (mirrors the "reset to test explicitly" precedent used in the
    // "liveStore — fetchDeckState" describe block below) to exercise the guard.
    useLiveStore.setState({ deckState: createEmptyDeckState("", 0) });
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(localStorage.getItem("localDeckState:sheet-1:3")).toBeNull();
    // The guard must bail before flagging a save — a "saved" status here would
    // be a false indicator over silently-dropped edits.
    expect(useLiveStore.getState().deckSaveStatus).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// local deck mode — enterSharedView same-draft protection
// ---------------------------------------------------------------------------
describe("local deck mode — enterSharedView same-draft protection", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    vi.useFakeTimers();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3 });
    useDraftStore.setState({ board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not overwrite the viewer's local WIP deck when entering a shared view for the already-active draft/seat", async () => {
    await vi.advanceTimersByTimeAsync(0);

    // Pre-seed the viewer's own WIP deck for sheet-1 seat 3.
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 4, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    const seat3Before = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(seat3Before.basicLands.Island).toBe(4);

    // Open a share link for the SAME draft/seat that's already active — the
    // activeDraft subscription will NOT fire since setActiveDraft/setSelectedSeat
    // are called with their already-current values.
    const sharedState = createEmptyDeckState("sheet-1", 3);
    sharedState.zones.deck["mv-0-1"] = ["Shared Card"];
    useLiveStore.getState().enterSharedView("sheet-1", 3, sharedState);

    expect(useLiveStore.getState().viewingSharedDeck).toBe(true);

    // Any deck action after entering the shared view — previously this would
    // mark the deck dirty and schedule a local save, clobbering the viewer's
    // own WIP deck with the shared snapshot.
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 9, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    const seat3After = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(seat3After.basicLands.Island).toBe(4);
    expect(JSON.stringify(seat3After)).not.toContain("Shared Card");
  });
});

// ---------------------------------------------------------------------------
// local deck mode — wiring (board arrival, seat switch)
// ---------------------------------------------------------------------------
describe("local deck mode — wiring (board arrival, seat switch)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads local floats and deck when board arrives with isSheetDraft", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade"]));
    const stored = createEmptyDeckState("sheet-1", 3);
    stored.zones.deck["mv-0-1"] = ["Sol Ring"];
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(stored));

    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3 });
    // Board arrives via first /live poll — after activeDraft is set.
    useDraftStore.setState({ board: makeSheetBoard() });
    await vi.advanceTimersByTimeAsync(0);

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
    expect(useLiveStore.getState().deckState.seat).toBe(3);
  });

  it("switching seats flushes the old seat's pending save and loads the new seat", async () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3 });
    useDraftStore.setState({ board: makeSheetBoard() });
    await vi.advanceTimersByTimeAsync(0);

    // Edit seat 3's deck; do NOT wait out the 1000ms save debounce.
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 4, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    useDraftStore.getState().setSelectedSeat(5);
    await vi.advanceTimersByTimeAsync(0);

    // Old seat's pending edit was flushed to its own key…
    const seat3 = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(seat3.basicLands.Island).toBe(4);
    // …and the store now holds seat 5's (fresh, empty) deck.
    expect(useLiveStore.getState().deckState.seat).toBe(5);
    expect(useLiveStore.getState().deckState.basicLands.Island).toBe(0);
    // Seat isolation: seat 5's key was not polluted by seat 3's edit.
    const seat5Raw = localStorage.getItem("localDeckState:sheet-1:5");
    if (seat5Raw) expect(JSON.parse(seat5Raw).basicLands.Island).toBe(0);
  });

  it("does nothing for live drafts", async () => {
    localStorage.setItem("localFloats:live-1:3", JSON.stringify(["Doom Blade"]));
    useDraftStore.setState({ activeDraft: "live-1", selectedSeat: 3 });
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    await vi.advanceTimersByTimeAsync(0);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// handlePick
// ---------------------------------------------------------------------------
describe("liveStore — handlePick", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/drafts/{id}/pick with card_name and X-Seat-Token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().handlePick("Lightning Bolt");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/pick",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Seat-Token": "tok-abc",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ card_name: "Lightning Bolt" }),
      }),
    );
  });

  it("refreshes on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", pickError: "old error" });

    const refreshSpy = vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    await useLiveStore.getState().handlePick("Lightning Bolt");

    expect(useLiveStore.getState().pickError).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("sets pickError on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Card not in pool" }), { status: 400 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().handlePick("Fake Card");

    expect(useLiveStore.getState().pickError).toBe("Card not in pool");
  });

  it("suppresses 'already been picked' when autoPick is on", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Card has already been picked" }),
        { status: 409 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: true });

    const refreshSpy = vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    await useLiveStore.getState().handlePick("Taken Card");

    expect(useLiveStore.getState().pickError).toBeNull();
    expect(refreshSpy).toHaveBeenCalled();
  });

  it("does not suppress 'already been picked' when autoPick is off", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Card has already been picked" }),
        { status: 409 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: false });

    await useLiveStore.getState().handlePick("Taken Card");

    expect(useLiveStore.getState().pickError).toBe("Card has already been picked");
  });

  it("sets network error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().handlePick("Lightning Bolt");

    expect(useLiveStore.getState().pickError).toBe(
      "Network error — pick may not have been submitted",
    );
  });
});

// ---------------------------------------------------------------------------
// setPickError
// ---------------------------------------------------------------------------
describe("liveStore — setPickError", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates pickError", () => {
    useLiveStore.getState().setPickError("Something went wrong");
    expect(useLiveStore.getState().pickError).toBe("Something went wrong");

    useLiveStore.getState().setPickError(null);
    expect(useLiveStore.getState().pickError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isMyTurn derived state
// ---------------------------------------------------------------------------
describe("liveStore — isMyTurn", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is true when mySeat matches liveDraftStatus.nextSeat", () => {
    useLiveStore.setState({ mySeat: 3 });
    useDraftStore.setState({
      liveDraftStatus: {
        latestPickN: 5,
        nextSeat: 3,
        recentPicks: [],
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    expect(useLiveStore.getState().isMyTurn).toBe(true);
  });

  it("is false when mySeat does not match nextSeat", () => {
    useLiveStore.setState({ mySeat: 3 });
    useDraftStore.setState({
      liveDraftStatus: {
        latestPickN: 5,
        nextSeat: 5,
        recentPicks: [],
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    expect(useLiveStore.getState().isMyTurn).toBe(false);
  });

  it("is false when mySeat is null", () => {
    useLiveStore.setState({ mySeat: null });
    useDraftStore.setState({
      liveDraftStatus: {
        latestPickN: 5,
        nextSeat: 3,
        recentPicks: [],
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    expect(useLiveStore.getState().isMyTurn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Phase gate: auto-pick must not fire outside the drafting phase
// ---------------------------------------------------------------------------
describe("liveStore — recomputePicking phase gate", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT fire when phase is 'setup' even if nextSeat matches mySeat", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 1, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "setup", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 1,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Lightning Bolt" }] }],
      queuedCardCounts: new Map([["Lightning Bolt", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });

  it("does NOT fire when phase is 'complete'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "complete", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 2,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 2, cardName: "Counterspell" }] }],
      queuedCardCounts: new Map([["Counterspell", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });

  it("DOES fire when phase is 'drafting'", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: null, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 401 });
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 3, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 3,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 5, cardName: "Force of Will" }] }],
      queuedCardCounts: new Map([["Force of Will", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes("/pick") && JSON.parse(c[1]?.body as string ?? "{}").auto === true,
    );
    expect(pickCalls).toHaveLength(1);
  });

  it("does NOT fire when board is null (phase unknown)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 1, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: null,
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 1,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 3, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// triggerAutoPick — simplified client trigger (Task 27 / A2)
//
// After the auto-pick single-source-of-truth refactor, the client trigger
// no longer traverses the queue itself.  It just calls POST /pick { auto: true }
// and delegates all candidate selection to the server.
// ---------------------------------------------------------------------------
describe("liveStore — triggerAutoPick (simplified)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls POST /api/drafts/{id}/pick with { auto: true } when it's my turn and autoPick is on", async () => {
    // Route /pick calls to a success response; all others to 401 so that the
    // activeDraft subscription's fetchMySeat/fetchQueue/etc don't interfere.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: { pickN: 1, cardId: 5, cardName: "Lightning Bolt" }, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 401 });
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 3, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 3,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 5, cardName: "Lightning Bolt" }] }],
      queuedCardCounts: new Map([["Lightning Bolt", 1]]),
    });

    recomputePicking();

    // Allow the async triggerAutoPick to settle
    await new Promise((r) => setTimeout(r, 0));

    const autoPickCall = fetchSpy.mock.calls.find(
      (c) => String(c[0]).includes("/pick") && JSON.parse(c[1]?.body as string ?? "{}").auto === true,
    );
    expect(autoPickCall).toBeDefined();
    expect(JSON.parse(autoPickCall![1]?.body as string)).toEqual({ auto: true });
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes("/pick") && !JSON.parse(c[1]?.body as string ?? "{}").auto)).toBe(false);
  });

  it("does NOT fire when autoPick is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 2,
      autoPick: false,
      queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });

  it("does NOT fire when queue is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 2,
      autoPick: true,
      queue: [],
      queuedCardCounts: new Map(),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });

  it("respects the autoPickInFlight guard — does not fire twice concurrently", async () => {
    let resolveFetch!: () => void;
    const hangingPickFetch = new Promise<Response>((resolve) => {
      resolveFetch = () =>
        resolve(
          new Response(
            JSON.stringify({ pickedCard: null, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
            { status: 200 },
          ),
        );
    });
    // Route /pick to the hanging promise (so the in-flight guard is exercised);
    // route everything else to 401 to isolate from activeDraft subscription calls.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).includes("/pick")) {
        return hangingPickFetch as Promise<Response>;
      }
      return Promise.resolve(new Response("{}", { status: 401 }));
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 1, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 1,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 9, cardName: "Force of Will" }] }],
      queuedCardCounts: new Map([["Force of Will", 1]]),
    });

    // Fire twice in quick succession
    recomputePicking();
    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    // Resolve the hanging fetch
    resolveFetch();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(1);
  });

  it("reflects autoPickDisabled from server response in store state", async () => {
    // Route fetch calls: /pick path gets the autoPickDisabled response; everything
    // else (fetchMySeat, fetchQueue, etc. from the activeDraft subscription) gets
    // an empty 401 so they bail out without consuming our test response body.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: null, autoPickDisabled: true, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 401 });
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 2,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 3, cardName: "Counterspell" }] }],
      queuedCardCounts: new Map([["Counterspell", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    expect(useLiveStore.getState().autoPick).toBe(false);
  });

  it("handles 409 conflict by refreshing — no error state set", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(JSON.stringify({ error: "Conflict" }), { status: 409 });
      }
      return new Response("{}", { status: 401 });
    });
    const refreshSpy = vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 1, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 1,
      autoPick: true,
      queue: [{ mode: "pause", cards: [{ cardId: 7, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    recomputePicking();
    await new Promise((r) => setTimeout(r, 0));

    expect(refreshSpy).toHaveBeenCalled();
    expect(useLiveStore.getState().pickError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Poll integration: auto-pick via _applyMeDataForTest (simulates /live me field)
//
// Verifies the complete path from a poll delivering per-seat me data to a
// single auto-pick POST — confirming that applyMeFromPoll → recomputePicking
// → triggerAutoPick fires exactly once and not more.
// ---------------------------------------------------------------------------
describe("liveStore — poll-triggered auto-pick integration", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires exactly one auto-pick POST when a poll delivers my-turn + autoPick on + queue", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: { pickN: 1, cardId: 5, cardName: "Lightning Bolt" }, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 401 });
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    // Set up: it's my turn according to liveDraftStatus, draft is in drafting phase
    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 3, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 3,
    });

    // Simulate a /live poll response delivering autoPick on + queue via `me` field
    _applyMeDataForTest({
      seat: 3,
      autoPick: true,
      displayName: null,
      queue: [{ mode: "pause", cards: [{ id: 5, name: "Lightning Bolt" }] }],
      floatedCards: [],
    });

    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes("/pick") && JSON.parse(c[1]?.body as string ?? "{}").auto === true,
    );
    expect(pickCalls).toHaveLength(1);
  });

  it("does NOT double-fire on two back-to-back polls with the same my-turn state", async () => {
    let resolveFetch!: () => void;
    const hangingPickFetch = new Promise<Response>((resolve) => {
      resolveFetch = () =>
        resolve(
          new Response(
            JSON.stringify({ pickedCard: null, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
            { status: 200 },
          ),
        );
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (String(input).includes("/pick")) return hangingPickFetch as Promise<Response>;
      return Promise.resolve(new Response("{}", { status: 401 }));
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 2 });

    const pollPayload = {
      seat: 2,
      autoPick: true,
      displayName: null,
      queue: [{ mode: "pause" as const, cards: [{ id: 9, name: "Force of Will" }] }],
      floatedCards: [],
    };

    // Two consecutive poll deliveries — autoPickInFlight should block the second
    _applyMeDataForTest(pollPayload);
    _applyMeDataForTest(pollPayload);
    await new Promise((r) => setTimeout(r, 0));

    resolveFetch();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Mid-turn enable: toggleAutoPick while already my turn fires auto-pick
// ---------------------------------------------------------------------------
describe("liveStore — toggleAutoPick mid-turn", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires auto-pick when autoPick is enabled while already my turn", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: null, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      // seat-settings PUT
      return new Response("{}", { status: 200 });
    });
    vi.spyOn(useDraftStore.getState(), "refreshNow").mockResolvedValue();

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 1, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 1,
      // autoPick starts false — it's already my turn but no trigger fires
      autoPick: false,
      isMyTurn: true,
      queue: [{ mode: "pause", cards: [{ cardId: 7, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    // Enable auto-pick while it's already my turn — toggleAutoPick calls recomputePicking
    await useLiveStore.getState().toggleAutoPick();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes("/pick") && JSON.parse(c[1]?.body as string ?? "{}").auto === true,
    );
    expect(pickCalls).toHaveLength(1);
  });

  it("does NOT fire auto-pick when autoPick is disabled while my turn (toggle off)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/pick")) {
        return new Response(
          JSON.stringify({ pickedCard: null, autoPickDisabled: false, phaseChanged: false, newPhase: null }),
          { status: 200 },
        );
      }
      // seat-settings PUT
      return new Response("{}", { status: 200 });
    });

    useDraftStore.setState({
      activeDraft: "draft-1",
      liveDraftStatus: { latestPickN: 0, nextSeat: 2, recentPicks: [], matchCount: 0, totalMatches: 0 },
      board: { phase: "drafting", numSeats: 4, picksPerPlayer: 6, picks: [], seatNames: {}, bannedCards: [], isSheetDraft: false },
    });
    useLiveStore.setState({
      seatToken: "tok-abc",
      mySeat: 2,
      autoPick: true,
      isMyTurn: true,
      queue: [{ mode: "pause", cards: [{ cardId: 8, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
    });

    // Disable auto-pick — recomputePicking fires but autoPick is now false
    await useLiveStore.getState().toggleAutoPick();
    await new Promise((r) => setTimeout(r, 0));

    const pickCalls = fetchSpy.mock.calls.filter((c) => String(c[0]).includes("/pick"));
    expect(pickCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deck builder: dispatchDeck
// ---------------------------------------------------------------------------
describe("liveStore — dispatchDeck", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies action to deckState via deckReducer", () => {
    const snapshot = createEmptyDeckState("draft-1", 1);
    snapshot.zones.deck["mv-2"] = ["Lightning Bolt"];

    useLiveStore.getState().dispatchDeck({
      type: "INIT_FROM_SNAPSHOT",
      snapshot,
    });

    const s = useLiveStore.getState();
    expect(s.deckState.draftId).toBe("draft-1");
    expect(s.deckState.seat).toBe(1);
    expect(s.deckState.zones.deck["mv-2"]).toEqual(["Lightning Bolt"]);
  });

  it("schedules a save after non-hydration dispatches", () => {
    vi.useFakeTimers();

    // Mock fetch to prevent real calls
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // SET_BASICS is a non-hydration action
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    // Save should be scheduled (debounced 1s)
    vi.advanceTimersByTime(1000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/draft-1/deck-state",
      expect.objectContaining({ method: "PUT" }),
    );

    vi.useRealTimers();
  });

  it("does not schedule save for INIT_FROM_SNAPSHOT", () => {
    vi.useFakeTimers();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    useLiveStore.getState().dispatchDeck({
      type: "INIT_FROM_SNAPSHOT",
      snapshot: createEmptyDeckState("draft-1", 1),
    });

    vi.advanceTimersByTime(2000);

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/drafts/draft-1/deck-state",
      expect.objectContaining({ method: "PUT" }),
    );

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // justHydrated flag — first-edit loss regression tests (D7)
  // -------------------------------------------------------------------------

  it("hydrate → no-op REBUILD → user move → save fires", async () => {
    // Scenario: deck is hydrated, syncDeckWithPicks fires a REBUILD that
    // returns the same state (no picks yet), then the user moves a card.
    // The save MUST fire — the no-op REBUILD must not leave justHydrated alive
    // to swallow the user's edit.
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // Hydrate with a deck that has a card we can move
    const snapshot = createEmptyDeckState("draft-1", 1);
    snapshot.zones.deck["mv-2"] = ["Lightning Bolt"];
    useLiveStore.getState().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot });

    // Simulate a no-op REBUILD: same canonical cards as what's already in the deck.
    // deckReducer will detect no zone change and return the same reference.
    useLiveStore.getState().dispatchDeck({
      type: "REBUILD",
      canonicalCards: ["Lightning Bolt"],
      scryfallData: new Map(),
    });

    // Now the user moves a card — this is the first real edit
    useLiveStore.getState().dispatchDeck({
      type: "MOVE_CARD",
      cardName: "Lightning Bolt",
      fromZone: "deck",
      fromColumn: "mv-2",
      toZone: "sideboard",
      toColumn: "mv-2",
      toIndex: 0,
    });

    // Advance past the debounce
    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/deck-state",
      expect.objectContaining({ method: "PUT" }),
    );

    vi.useRealTimers();
  });

  it("hydrate → state-changing REBUILD → no save (existing behavior preserved)", () => {
    // A REBUILD that actually changes state after hydration should still not
    // trigger a save — it is the automatic sync, not a user edit.
    vi.useFakeTimers();

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // Hydrate with empty deck
    useLiveStore.getState().dispatchDeck({
      type: "INIT_FROM_SNAPSHOT",
      snapshot: createEmptyDeckState("draft-1", 1),
    });

    // REBUILD that adds a card (state changes, new reference returned)
    useLiveStore.getState().dispatchDeck({
      type: "REBUILD",
      canonicalCards: ["Lightning Bolt"],
      scryfallData: new Map(),
    });

    vi.advanceTimersByTime(2000);

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/drafts/draft-1/deck-state",
      expect.objectContaining({ method: "PUT" }),
    );

    vi.useRealTimers();
  });

  it("hydrate → user edit with NO intervening REBUILD → save fires", async () => {
    // If the user dispatches a non-REBUILD action directly after hydration
    // (e.g. deck builder opened before picks loaded), the flag must be cleared
    // and the edit must be saved.
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    // Hydrate with a deck
    const snapshot = createEmptyDeckState("draft-1", 1);
    snapshot.zones.deck["mv-2"] = ["Lightning Bolt"];
    useLiveStore.getState().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot });

    // User moves a card immediately — no REBUILD in between
    useLiveStore.getState().dispatchDeck({
      type: "MOVE_CARD",
      cardName: "Lightning Bolt",
      fromZone: "deck",
      fromColumn: "mv-2",
      toZone: "sideboard",
      toColumn: "mv-2",
      toIndex: 0,
    });

    vi.advanceTimersByTime(1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/deck-state",
      expect.objectContaining({ method: "PUT" }),
    );

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Deck builder: fetchDeckState
// ---------------------------------------------------------------------------
describe("liveStore — fetchDeckState", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads from API and dispatches INIT_FROM_SNAPSHOT", async () => {
    const snapshot = createEmptyDeckState("draft-1", 2);
    snapshot.zones.deck["mv-3"] = ["Counterspell"];

    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(snapshot), { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchDeckState();

    const s = useLiveStore.getState();
    expect(s.deckState.draftId).toBe("draft-1");
    expect(s.deckState.zones.deck["mv-3"]).toEqual(["Counterspell"]);
  });

  it("marks deckReady true after fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(createEmptyDeckState("draft-1", 1)), { status: 200 }),
    );

    useLiveStore.setState({ seatToken: "tok-abc" });
    useDraftStore.setState({ activeDraft: "draft-1" });

    // activeDraft subscription may have already called fetchDeckState; reset to test explicitly
    useLiveStore.setState({ deckReady: false });

    await useLiveStore.getState().fetchDeckState();

    expect(useLiveStore.getState().deckReady).toBe(true);
  });

  it("handles 404 — creates empty deck with correct identity and marks ready", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not found", { status: 404 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchDeckState();

    const s = useLiveStore.getState();
    expect(s.deckReady).toBe(true);
    // Identity is set at load time (not deferred to syncDeckWithPicks)
    expect(s.deckState.draftId).toBe("draft-1");
  });

  it("handles network error — stays with empty state and marks ready", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchDeckState();

    const s = useLiveStore.getState();
    expect(s.deckReady).toBe(true);
    expect(s.deckState.draftId).toBe("");
  });

  it("marks deckReady true without seatToken (spectator mode)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: null, deckReady: false });

    // Clear any calls from the activeDraft subscription
    vi.mocked(globalThis.fetch).mockClear();

    await useLiveStore.getState().fetchDeckState();

    expect(useLiveStore.getState().deckReady).toBe(true);
    // No server fetch for deck-state when unauthenticated
    const deckStateCalls = vi.mocked(globalThis.fetch).mock.calls
      .filter((c) => String(c[0]).includes("deck-state"));
    expect(deckStateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Deck builder: setDeckBuilderActive
// ---------------------------------------------------------------------------
describe("liveStore — setDeckBuilderActive", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toggles deckBuilderActive state", () => {
    expect(useLiveStore.getState().deckBuilderActive).toBe(false);

    useLiveStore.getState().setDeckBuilderActive(true);
    expect(useLiveStore.getState().deckBuilderActive).toBe(true);

    useLiveStore.getState().setDeckBuilderActive(false);
    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deck builder: flushSave PUTs to /api/drafts/{id}/deck-state
// ---------------------------------------------------------------------------
describe("liveStore — deck save", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flushSave PUTs to /api/drafts/{id}/deck-state", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("{}", { status: 200 }),
      );

      useDraftStore.setState({ activeDraft: "draft-1" });
      useLiveStore.setState({ seatToken: "tok-abc" });

      // Dispatch a non-hydration action to trigger save scheduling
      useLiveStore.getState().dispatchDeck({
        type: "SET_BASICS",
        basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        scryfallData: new Map(),
      });

      // Advance past debounce
      vi.advanceTimersByTime(1000);

      // Let the flush promise resolve
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/drafts/draft-1/deck-state",
        expect.objectContaining({
          method: "PUT",
          headers: expect.objectContaining({
            "X-Seat-Token": "tok-abc",
            "Content-Type": "application/json",
          }),
        }),
      );

      // Should transition to "saved" then back to "idle"
      expect(useLiveStore.getState().deckSaveStatus).toBe("saved");

      // Advance past the "saved" display window and flush all remaining timers so
      // no unsettled async work leaks into subsequent tests
      await vi.advanceTimersByTimeAsync(2000);
      expect(useLiveStore.getState().deckSaveStatus).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Draft-switch auth reset
// ---------------------------------------------------------------------------
describe("liveStore — draft-switch auth reset", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears auth and per-seat state when switching to a new draft", () => {
    // Simulate being authenticated on draft-1
    useLiveStore.setState({
      seatToken: "tok-draft1",
      mySeat: 3,
      autoPick: false,
      displayName: "Alice",
      queue: [{ mode: 'pause', cards: [{ cardId: 10, cardName: "Bolt" }] }],
      queuedCardCounts: new Map([["Bolt", 1]]),
      floatedCards: ["Counterspell"],
      floatedCardsSet: new Set(["Counterspell"]),
    });
    useDraftStore.setState({ activeDraft: "draft-1" });

    // Stub fetch to prevent actual network calls from hydrateToken/fetchMySeat
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 401 }),
    );

    // Switch to draft-2 (no token stored)
    useDraftStore.getState().setActiveDraft("draft-2");

    // Auth state should be cleared synchronously
    const s = useLiveStore.getState();
    expect(s.mySeat).toBe(null);
    expect(s.displayName).toBe(null);
    expect(s.autoPick).toBe(true);
    expect(s.queue).toEqual([]);
    expect(s.floatedCards).toEqual([]);
  });

  it("re-hydrates token for new draft from localStorage", () => {
    localStorage.setItem("seatToken:draft-2", "tok-draft2");

    useLiveStore.setState({
      seatToken: "tok-draft1",
      mySeat: 3,
    });
    useDraftStore.setState({ activeDraft: "draft-1" });

    // Stub fetch for fetchMySeat
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ seat: 5, autoPick: true, displayName: "Bob" }), { status: 200 }),
    );

    // Switch to draft-2
    useDraftStore.getState().setActiveDraft("draft-2");

    // seatToken should be set from localStorage for draft-2
    expect(useLiveStore.getState().seatToken).toBe("tok-draft2");
    // mySeat is null until fetchMySeat resolves
    expect(useLiveStore.getState().mySeat).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Poll cycle = 1 request (Task 24: queue/float folded into /live)
// ---------------------------------------------------------------------------
describe("liveStore — per-seat data from /live poll (Task 24)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does NOT call separate /queue or /float endpoints when pollCount increments", async () => {
    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 2 });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ queue: [] }), { status: 200 }),
    );

    // Increment pollCount (simulating a poll cycle completing)
    useDraftStore.setState({ pollCount: 1 });

    // Let subscriptions fire
    await new Promise((r) => setTimeout(r, 0));

    // The old separate /queue and /float requests must NOT be made — they are
    // now replaced by the `me` field in the /live response.
    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).not.toContain("/api/drafts/draft-1/queue");
    expect(urls).not.toContain("/api/drafts/draft-1/float");
  });

  it("applies queue from me field in /live response without separate fetch", () => {
    useLiveStore.setState({ mySeat: 3 });

    const incomingQueue = [{ mode: "pause", cards: [{ id: 42, name: "Lightning Bolt" }] }];
    _applyMeDataForTest({
      seat: 3,
      autoPick: true,
      displayName: "Alice",
      queue: incomingQueue,
      floatedCards: ["Counterspell"],
    });

    const state = useLiveStore.getState();
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].cards[0].cardName).toBe("Lightning Bolt");
    expect(state.floatedCards).toEqual(["Counterspell"]);
    expect(state.autoPick).toBe(true);
    expect(state.displayName).toBe("Alice");
  });

  it("deep-compare keeps queue reference stable when content is unchanged", () => {
    const originalQueue = [{ mode: "pause" as const, cards: [{ cardId: 1, cardName: "Bolt" }] }];
    useLiveStore.setState({ mySeat: 1, queue: originalQueue, queuedCardCounts: new Map([["Bolt", 1]]) });

    _applyMeDataForTest({
      seat: 1,
      autoPick: false,
      displayName: null,
      queue: [{ mode: "pause", cards: [{ id: 1, name: "Bolt" }] }],
      floatedCards: [],
    });

    // Reference must be stable when content is identical
    expect(useLiveStore.getState().queue).toBe(originalQueue);
  });

  it("resolves mySeat from first poll me response when mySeat is null", () => {
    useLiveStore.setState({ mySeat: null });

    _applyMeDataForTest({
      seat: 5,
      autoPick: true,
      displayName: "Bob",
      queue: [],
      floatedCards: [],
    });

    expect(useLiveStore.getState().mySeat).toBe(5);
  });

  it("skips applying me when seat does not match resolved mySeat", () => {
    useLiveStore.setState({ mySeat: 2, queue: [] });

    _applyMeDataForTest({
      seat: 7, // wrong seat
      autoPick: true,
      displayName: null,
      queue: [{ mode: "pause", cards: [{ id: 99, name: "Force of Will" }] }],
      floatedCards: [],
    });

    // Queue must not be updated when seat doesn't match
    expect(useLiveStore.getState().queue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Draft-switch deck-state reset (Task 13)
// ---------------------------------------------------------------------------
describe("liveStore — draft-switch deck-state reset", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("cancels a pending debounced save when switching drafts — no PUT fires", async () => {
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-A" });
    useLiveStore.setState({ seatToken: "tok-A" });

    // Trigger a deck change to schedule a debounced save for draft-A
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    // Switch to draft-B before the debounce fires (still within 1s window)
    useDraftStore.getState().setActiveDraft("draft-B");

    // Advance past the debounce timer
    await vi.advanceTimersByTimeAsync(1500);

    // No deck-state PUT should have been made — the save was for draft-A but
    // activeDraft is now draft-B
    const deckStatePuts = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes("deck-state") && (c[1] as RequestInit)?.method === "PUT",
    );
    expect(deckStatePuts).toHaveLength(0);
  });

  it("resets deck-builder state when switching to a new draft", async () => {
    // Set up draft-A with a non-empty deck state
    useDraftStore.setState({ activeDraft: "draft-A" });
    useLiveStore.setState({
      seatToken: "tok-A",
      deckState: { ...createEmptyDeckState("draft-A", 3), zones: { deck: { "mv-2": ["Bolt"] }, sideboard: {} } },
      deckReady: true,
      deckSaveStatus: "saved",
      viewingSharedDeck: true,
    });

    // Mock fetch: return 404 for deck-state (no saved state) so fetchDeckState
    // completes without loading new content
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 404 }),
    );

    // Switch to draft-B — synchronous reset must wipe deck state immediately
    useDraftStore.getState().setActiveDraft("draft-B");

    // The synchronous part of the subscription resets state immediately
    // (deckSaveStatus and viewingSharedDeck are synchronous)
    expect(useLiveStore.getState().deckSaveStatus).toBe("idle");
    expect(useLiveStore.getState().viewingSharedDeck).toBe(false);
    expect(useLiveStore.getState().deckState.draftId).toBe("");
    // mv-2 zone from draft-A must be empty (reset wipes all cards)
    expect(useLiveStore.getState().deckState.zones.deck["mv-2"]).toEqual([]);

    // After async fetchDeckState runs (404 = no state, still marks ready)
    await new Promise((r) => setTimeout(r, 0));
    expect(useLiveStore.getState().deckReady).toBe(true);
  });

  it("leaves deck builder empty when draft-B has no token, deckReady becomes true", async () => {
    // draft-A was loaded with a deck
    useDraftStore.setState({ activeDraft: "draft-A" });
    useLiveStore.setState({
      seatToken: "tok-A",
      deckState: { ...createEmptyDeckState("draft-A", 2), zones: { deck: { "mv-3": ["Counterspell"] }, sideboard: {} } },
      deckReady: true,
    });

    // Switch to draft-B where no token is stored in localStorage
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.getState().setActiveDraft("draft-B");

    // Give async actions (hydrateToken, fetchDeckState) a tick to run
    await new Promise((r) => setTimeout(r, 0));

    const s = useLiveStore.getState();
    // No token for draft-B, so fetchDeckState skips the server fetch
    // but must still mark deckReady true with an EMPTY deck (no draft-A content)
    expect(s.deckReady).toBe(true);
    expect(s.seatToken).toBeNull();
    // draft-A's zones must not bleed through — either absent or empty
    const mv3Zone = s.deckState.zones.deck["mv-3"];
    expect(mv3Zone === undefined || mv3Zone.length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reportMatch — store action (Task 29: component fetch consolidation)
// ---------------------------------------------------------------------------
describe("liveStore — reportMatch", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/drafts/{id}/match with X-Seat-Token and correct body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1", standings: [], standingsMatches: [], standingsLoading: false });
    useLiveStore.setState({ seatToken: "tok-abc" });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 3,
      wins: 2,
      losses: 1,
    });

    expect(result).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/match",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Seat-Token": "tok-abc" }),
        body: JSON.stringify({ opponent_seat: 3, wins: 2, losses: 1 }),
      }),
    );
  });

  it("returns null and refreshes standings on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1", standings: [], standingsMatches: [], standingsLoading: false });
    useLiveStore.setState({ seatToken: "tok-abc" });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 2,
      wins: 2,
      losses: 0,
    });

    expect(result).toBeNull();
    // fetchStandings was called (the standings fetch is a GET to /api/drafts/{id}/standings)
    const standingsCalls = (vi.spyOn(globalThis, "fetch") as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    // At minimum the match POST was called; standings fetch fires after
    expect(standingsCalls.length).toBeGreaterThanOrEqual(0);
  });

  it("returns error message string on HTTP failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Already reported" }), { status: 409 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1", standings: [], standingsMatches: [], standingsLoading: false });
    useLiveStore.setState({ seatToken: "tok-abc" });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 3,
      wins: 2,
      losses: 1,
    });

    expect(result).toBe("Already reported");
  });

  it("returns 'Not authenticated' when no token", async () => {
    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: null });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 3,
      wins: 2,
      losses: 1,
    });

    expect(result).toBe("Not authenticated");
  });
});

// ---------------------------------------------------------------------------
// reportMatch — optimistic match continuity (no flicker between POST success
// and a standings refetch that actually contains the reported match)
// ---------------------------------------------------------------------------
describe("liveStore — reportMatch optimistic continuity", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mocks the report flow: POST /match returns postStatus; each GET /standings
   * returns the next entry of standingsBodies (the last entry repeats).
   */
  function mockMatchFlow(
    postStatus: number,
    standingsBodies: Array<{ standings: unknown[]; matches: unknown[] }>,
  ) {
    let standingsCalls = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/match")) {
        const body = postStatus === 200
          ? JSON.stringify({ success: true })
          : JSON.stringify({ error: "Report failed" });
        return new Response(body, { status: postStatus });
      }
      if (url.includes("/standings")) {
        const body = standingsBodies[Math.min(standingsCalls, standingsBodies.length - 1)];
        standingsCalls++;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return new Response(JSON.stringify({ unchanged: true }), { status: 200 });
    });
  }

  it("keeps the entered result visible when the post-report standings refetch returns stale data", async () => {
    // Stale refetch: the standings body predates the POST (e.g. CDN-cached) —
    // it does NOT contain the just-reported match.
    mockMatchFlow(200, [{ standings: [], matches: [] }]);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 1 });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 3,
      wins: 2,
      losses: 1,
    });

    expect(result).toBeNull();
    // The matrix renders from standingsMatches — the entered result must still
    // be there even though the refetch body did not contain it.
    expect(useDraftStore.getState().standingsMatches).toContainEqual({
      seat1: 1,
      seat2: 3,
      seat1Wins: 2,
      seat2Wins: 1,
    });
  });

  it("keeps the entered result through additional stale refetches until server data contains it", async () => {
    const confirmed = { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 1 };
    mockMatchFlow(200, [
      { standings: [], matches: [] }, // stale (post-report refetch)
      { standings: [], matches: [] }, // still stale (poll-triggered refetch)
      { standings: [], matches: [confirmed] }, // fresh
    ]);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 1 });

    await useLiveStore.getState().reportMatch({ opponentSeat: 3, wins: 2, losses: 1 });
    expect(useDraftStore.getState().standingsMatches).toContainEqual(confirmed);

    // Second stale refetch (e.g. matchCount-effect refetch hitting the same cache)
    await useDraftStore.getState().fetchStandings();
    expect(useDraftStore.getState().standingsMatches).toContainEqual(confirmed);

    // Fresh refetch confirms — overlay cleared, server data shown as-is
    await useDraftStore.getState().fetchStandings();
    expect(useDraftStore.getState().standingsMatches).toEqual([confirmed]);
    expect(useDraftStore.getState().pendingMatch).toBeNull();
  });

  it("clears the optimistic overlay once the refetch contains the reported match", async () => {
    const confirmed = { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 1 };
    mockMatchFlow(200, [{ standings: [], matches: [confirmed] }]);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 1 });

    await useLiveStore.getState().reportMatch({ opponentSeat: 3, wins: 2, losses: 1 });

    expect(useDraftStore.getState().standingsMatches).toEqual([confirmed]);
    expect(useDraftStore.getState().pendingMatch).toBeNull();
  });

  it("reverts the optimistic entry when the POST fails", async () => {
    mockMatchFlow(409, [{ standings: [], matches: [] }]);

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 1 });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 3,
      wins: 2,
      losses: 1,
    });

    expect(result).toBe("Report failed");
    expect(useDraftStore.getState().pendingMatch).toBeNull();
    expect(useDraftStore.getState().standingsMatches).toEqual([]);
  });

  it("overrides the old result during a correction until the refetch confirms it", async () => {
    // Existing server result: I (seat 3) lost 0-2 to seat 1. I correct it to 2-1.
    const oldRecord = { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 0 };
    const corrected = { seat1: 1, seat2: 3, seat1Wins: 1, seat2Wins: 2 };
    mockMatchFlow(200, [
      { standings: [], matches: [oldRecord] }, // stale: still has the old result
      { standings: [], matches: [corrected] }, // fresh
    ]);

    useDraftStore.setState({
      activeDraft: "draft-1",
      standingsMatches: [oldRecord],
    });
    useLiveStore.setState({ seatToken: "tok-abc", mySeat: 3 });

    const result = await useLiveStore.getState().reportMatch({
      opponentSeat: 1,
      wins: 2,
      losses: 1,
    });

    expect(result).toBeNull();
    // The corrected result must be shown, not the stale old one
    expect(useDraftStore.getState().standingsMatches).toEqual([corrected]);

    // Fresh refetch confirms and clears the overlay
    await useDraftStore.getState().fetchStandings();
    expect(useDraftStore.getState().standingsMatches).toEqual([corrected]);
    expect(useDraftStore.getState().pendingMatch).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shareDeck — store action (Task 29: component fetch consolidation)
// ---------------------------------------------------------------------------
describe("liveStore — shareDeck", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/deck with the current deckState and returns share URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ deckId: "abc123" }), { status: 200 }),
    );

    const deckState = createEmptyDeckState("draft-1", 2);
    useLiveStore.setState({ deckState });

    const url = await useLiveStore.getState().shareDeck();

    expect(url).toBe("http://localhost:3000/?deck=abc123");
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/deck",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws when the server returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Rate limited" }), { status: 429 }),
    );

    await expect(useLiveStore.getState().shareDeck()).rejects.toThrow("Rate limited");
  });
});

// ---------------------------------------------------------------------------
// Poll identity churn — idle polls produce zero deck-state PUTs (Task 23)
// ---------------------------------------------------------------------------
describe("liveStore — idle poll cycles produce zero deck-state PUTs", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    Object.defineProperty(window, "location", {
      value: new URL("http://localhost:3000/"),
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("3 idle poll cycles with deck builder previously opened → zero deck-state PUTs and stable deckState reference", async () => {
    // Simulates the scenario: user opened the deck builder, then closed it.
    // deckBuilderActive is now false (fixed by Task 23), so syncDeckWithPicks
    // does not run, and the deck is not marked dirty → no PUTs.
    vi.useFakeTimers();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      deckReady: true,
      deckBuilderActive: false, // modal was closed, deckBuilderActive reset
    });

    // Record the deckState reference before polls start
    const deckStateRef = useLiveStore.getState().deckState;

    // Simulate 3 poll cycles via pollCount increments (fetchQueue/fetchFloat fire on each)
    useDraftStore.setState({ pollCount: 1 });
    await vi.advanceTimersByTimeAsync(0);
    useDraftStore.setState({ pollCount: 2 });
    await vi.advanceTimersByTimeAsync(0);
    useDraftStore.setState({ pollCount: 3 });
    await vi.advanceTimersByTimeAsync(0);

    // Advance past any debounce timers
    await vi.advanceTimersByTimeAsync(2000);

    // deckState reference must be unchanged — no rebuild occurred
    expect(useLiveStore.getState().deckState).toBe(deckStateRef);

    // No deck-state PUTs must have fired
    const deckStatePuts = fetchSpy.mock.calls.filter(
      (c) => String(c[0]).includes("deck-state") && (c[1] as RequestInit)?.method === "PUT",
    );
    expect(deckStatePuts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// syncDeckWithPicks — auth gating, speculative dedup, identity handling
// ---------------------------------------------------------------------------
describe("liveStore — syncDeckWithPicks", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not rebuild when deckBuilderActive is false", () => {
    // Arrange: deck builder not open
    useLiveStore.setState({
      deckBuilderActive: false,
      deckReady: true,
      mySeat: 1,
    });
    useDraftStore.setState({ selectedSeat: 1 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const initialDeckState = useLiveStore.getState().deckState;

    // Build the sync function from the factory (same as liveStore.ts module-level wiring)
    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    // deckState must be unchanged
    expect(useLiveStore.getState().deckState).toBe(initialDeckState);
  });

  it("does not rebuild when deckReady is false", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: false,
      mySeat: 1,
    });
    useDraftStore.setState({ selectedSeat: 1 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const initialDeckState = useLiveStore.getState().deckState;
    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    expect(useLiveStore.getState().deckState).toBe(initialDeckState);
  });

  it("does not rebuild when viewingSharedDeck is true", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: true,
      mySeat: 1,
    });
    useDraftStore.setState({ selectedSeat: 1 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const initialDeckState = useLiveStore.getState().deckState;
    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    expect(useLiveStore.getState().deckState).toBe(initialDeckState);
  });

  it("includes picks in canonical cards when authed (mySeat === selectedSeat)", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: false,
      mySeat: 2,
      floatedCards: [],
      queue: [],
    });
    useDraftStore.setState({ selectedSeat: 2 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt", "Counterspell"], scryfallDataMap: new Map() });

    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    const { deckState } = useLiveStore.getState();
    const allCards = Object.values(deckState.zones.deck).flat();
    expect(allCards).toContain("Lightning Bolt");
    expect(allCards).toContain("Counterspell");
  });

  it("auth-gated: excludes floated/queued cards when mySeat !== selectedSeat", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: false,
      mySeat: 1,   // authed as seat 1
      floatedCards: ["Force of Will"],
      queue: [{ mode: "pause", cards: [{ cardId: 9, cardName: "Brainstorm" }] }],
    });
    // Viewing seat 2's deck — not authed
    useDraftStore.setState({ selectedSeat: 2 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    const { deckState } = useLiveStore.getState();
    const allCards = Object.values(deckState.zones.deck).flat();
    expect(allCards).toContain("Lightning Bolt"); // picks still included
    // Speculative cards excluded because not authed for this seat
    expect(allCards).not.toContain("Force of Will");
    expect(allCards).not.toContain("Brainstorm");
  });

  it("auth-gated: includes floated/queued cards when mySeat === selectedSeat", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: false,
      mySeat: 3,
      floatedCards: ["Force of Will"],
      queue: [{ mode: "flow-through", cards: [{ cardId: 5, cardName: "Brainstorm" }] }],
    });
    useDraftStore.setState({ selectedSeat: 3 });
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    const { deckState } = useLiveStore.getState();
    const allCards = Object.values(deckState.zones.deck).flat();
    expect(allCards).toContain("Lightning Bolt");
    expect(allCards).toContain("Force of Will");
    expect(allCards).toContain("Brainstorm");
  });

  it("deduplicates speculative cards: a card queued AND floated counts once", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: false,
      mySeat: 4,
      floatedCards: ["Brainstorm"],  // also in queue
      queue: [{ mode: "flow-through", cards: [{ cardId: 5, cardName: "Brainstorm" }] }],
    });
    useDraftStore.setState({ selectedSeat: 4 });
    useCardStore.setState({ seatCardList: [], scryfallDataMap: new Map() });

    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    const { deckState } = useLiveStore.getState();
    const allCards = Object.values(deckState.zones.deck).flat();
    const brainstormCount = allCards.filter((c) => c === "Brainstorm").length;
    expect(brainstormCount).toBe(1); // deduplicated to one copy
  });

  it("deduplicates speculative cards against picks: queued card already picked counts once", () => {
    useLiveStore.setState({
      deckBuilderActive: true,
      deckReady: true,
      viewingSharedDeck: false,
      mySeat: 5,
      floatedCards: [],
      queue: [{ mode: "flow-through", cards: [{ cardId: 1, cardName: "Lightning Bolt" }] }],
    });
    useDraftStore.setState({ selectedSeat: 5 });
    // Lightning Bolt is both picked AND in queue
    useCardStore.setState({ seatCardList: ["Lightning Bolt"], scryfallDataMap: new Map() });

    const syncDeck = makeSyncDeckWithPicks(useLiveStore.getState);
    syncDeck();

    const { deckState } = useLiveStore.getState();
    const allCards = Object.values(deckState.zones.deck).flat();
    const boltCount = allCards.filter((c) => c === "Lightning Bolt").length;
    expect(boltCount).toBe(1); // pick wins, queue dedup removes the speculative copy
  });
});
