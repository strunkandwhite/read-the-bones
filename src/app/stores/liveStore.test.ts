// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLiveStore, recomputePicking, _resetDeckState } from "./liveStore";
import { useDraftStore, _resetPollingState } from "./draftStore";
import { _resetSearchState } from "./cardStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@/core/localSearch", () => ({
  searchLocalCards: vi.fn(() => []),
}));
vi.mock("@/core/searchUtils", () => ({
  hasScryfallOperators: vi.fn(() => false),
}));
vi.mock("@/core/snakeDraft", () => ({
  derivePickSeat: vi.fn((pickN: number) => ({ seat: pickN <= 2 ? 1 : 2, round: 1 })),
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
    pickError: null,
    isMyTurn: false,
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
    viewingSharedDeck: false,
  });
}

// ---------------------------------------------------------------------------
// hydrateToken
// ---------------------------------------------------------------------------
describe("liveStore — hydrateToken", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
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

    vi.advanceTimersByTime(2000);
    expect(useLiveStore.getState().deckSaveStatus).toBe("idle");

    vi.useRealTimers();
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
// pollCount triggers queue/float refresh
// ---------------------------------------------------------------------------
describe("liveStore — pollCount subscription", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls fetchQueue and fetchFloatedCards when pollCount increments", async () => {
    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ queue: [] }), { status: 200 }),
    );

    // Increment pollCount (simulating a poll cycle)
    useDraftStore.setState({ pollCount: 1 });

    // Let subscriptions fire
    await new Promise((r) => setTimeout(r, 0));

    // fetchQueue and fetchFloatedCards should have been called
    const urls = fetchSpy.mock.calls.map((call) => call[0]);
    expect(urls).toContain("/api/drafts/draft-1/queue");
    expect(urls).toContain("/api/drafts/draft-1/float");
  });

  it("does not call fetchQueue when pollCount is 0", async () => {
    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ queue: [] }), { status: 200 }),
    );

    // Set pollCount to 0 (no poll yet)
    useDraftStore.setState({ pollCount: 0 });

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
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
