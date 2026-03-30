// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLiveStore, recomputePicking, _resetDeckState } from "./liveStore";
import { useDraftStore, _resetPollingState } from "./draftStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/snakeDraft", () => ({
  derivePickSeat: vi.fn((pickN: number) => ({ seat: pickN <= 2 ? 1 : 2, round: 1 })),
  getTotalPicks: vi.fn(() => 10),
}));

function resetStores() {
  _resetPollingState();
  _resetDeckState();
  useDraftStore.setState({
    selectedDrafts: new Set(),
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
  });
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
    floatedCardsSet: new Set<string>(),
    pickError: null,
    isMyTurn: false,
    consecutivePicks: 0,
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
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
        JSON.stringify({ seat: 3, autoPick: false, displayName: "Alice", autoPickMode: "cautious" }),
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

  it("sets mySeat, autoPick, displayName, autoPickMode from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 5, autoPick: false, displayName: "Bob", autoPickMode: "cautious" }),
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
    expect(s.autoPickMode).toBe("cautious");
  });

  it("defaults autoPickMode to 'resilient' when missing from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 2, autoPick: true, displayName: null }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchMySeat();

    expect(useLiveStore.getState().autoPickMode).toBe("resilient");
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
// updateAutoPickMode
// ---------------------------------------------------------------------------
describe("liveStore — updateAutoPickMode", () => {
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
    useLiveStore.setState({ seatToken: "tok-abc", autoPickMode: "resilient" });

    await useLiveStore.getState().updateAutoPickMode("cautious");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ auto_pick_mode: "cautious" }),
      }),
    );
    expect(useLiveStore.getState().autoPickMode).toBe("cautious");
  });

  it("reverts on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPickMode: "resilient" });

    await useLiveStore.getState().updateAutoPickMode("cautious");

    expect(useLiveStore.getState().autoPickMode).toBe("resilient");
  });

  it("reverts on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPickMode: "resilient" });

    await useLiveStore.getState().updateAutoPickMode("cautious");

    expect(useLiveStore.getState().autoPickMode).toBe("resilient");
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

  it("fetches /api/drafts/{id}/me and updates autoPick + autoPickMode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ seat: 3, autoPick: false, autoPickMode: "cautious", displayName: "X" }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", autoPick: true, autoPickMode: "resilient" });

    await useLiveStore.getState().refreshSettings();

    expect(useLiveStore.getState().autoPick).toBe(false);
    expect(useLiveStore.getState().autoPickMode).toBe("cautious");
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
        JSON.stringify({ seat: 2, autoPick: true, displayName: null, autoPickMode: "resilient" }),
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
        JSON.stringify({ seat: 3, autoPick: false, displayName: "Alice", autoPickMode: "cautious" }),
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
      autoPickMode: "cautious",
      displayName: "Alice",
    });

    // Now clear activeDraft — subscription should reset liveStore
    useDraftStore.setState({ activeDraft: null });

    const s = useLiveStore.getState();
    expect(s.seatToken).toBeNull();
    expect(s.mySeat).toBeNull();
    expect(s.autoPick).toBe(true);
    expect(s.autoPickMode).toBe("resilient");
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
        JSON.stringify({ queue: [{ priority: 1, cardId: 10, cardName: "Bolt" }] }),
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

  it("sets queue and queuedCards from response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [
            { priority: 1, cardId: 10, cardName: "Bolt" },
            { priority: 2, cardId: 20, cardName: "Counterspell" },
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
    expect(s.queue[0].cardName).toBe("Bolt");
    expect(s.queuedCards.get("Bolt")).toBe(1);
    expect(s.queuedCards.get("Counterspell")).toBe(2);
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

  it("appends card and syncs to API", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [
            { priority: 1, cardId: 10, cardName: "Bolt" },
            { priority: 2, cardId: 20, cardName: "Counterspell" },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [{ priority: 1, cardId: 10, cardName: "Bolt" }],
      queuedCards: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    // Wait for async syncQueue
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([{ card_name: "Bolt" }, { card_name: "Counterspell" }]),
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
          queue: [{ priority: 1, cardId: 20, cardName: "Counterspell" }],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { priority: 1, cardId: 10, cardName: "Bolt" },
        { priority: 2, cardId: 20, cardName: "Counterspell" },
      ],
      queuedCards: new Map([["Bolt", 1], ["Counterspell", 2]]),
    });

    useLiveStore.getState().removeFromQueue("Bolt");

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([{ card_name: "Counterspell" }]),
      }),
    );
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
            { priority: 1, cardId: 20, cardName: "Counterspell" },
            { priority: 2, cardId: 10, cardName: "Bolt" },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [
        { priority: 1, cardId: 10, cardName: "Bolt" },
        { priority: 2, cardId: 20, cardName: "Counterspell" },
      ],
    });

    useLiveStore.getState().reorderQueue(["Counterspell", "Bolt"]);

    await new Promise((r) => setTimeout(r, 0));

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify([{ card_name: "Counterspell" }, { card_name: "Bolt" }]),
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

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [{ priority: 1, cardId: 10, cardName: "Bolt" }],
      queuedCards: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    await new Promise((r) => setTimeout(r, 0));

    const s = useLiveStore.getState();
    expect(s.queue).toEqual([{ priority: 1, cardId: 10, cardName: "Bolt" }]);
    expect(s.queuedCards.get("Bolt")).toBe(1);
    expect(s.queuedCards.has("Counterspell")).toBe(false);
    expect(s.queueError).toBe("Failed to sync queue");
  });

  it("reverts queue on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({
      seatToken: "tok-abc",
      queue: [{ priority: 1, cardId: 10, cardName: "Bolt" }],
      queuedCards: new Map([["Bolt", 1]]),
    });

    useLiveStore.getState().addToQueue("Counterspell");

    await new Promise((r) => setTimeout(r, 0));

    const s = useLiveStore.getState();
    expect(s.queue).toEqual([{ priority: 1, cardId: 10, cardName: "Bolt" }]);
    expect(s.queueError).toBe("Failed to sync queue");
  });
});

// ---------------------------------------------------------------------------
// queuedCards derived
// ---------------------------------------------------------------------------
describe("liveStore — queuedCards derived from queue", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recomputes queuedCards after fetchQueue", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          queue: [
            { priority: 1, cardId: 10, cardName: "Bolt" },
            { priority: 2, cardId: 20, cardName: "Swords" },
          ],
        }),
        { status: 200 },
      ),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchQueue();

    const qc = useLiveStore.getState().queuedCards;
    expect(qc.size).toBe(2);
    expect(qc.get("Bolt")).toBe(1);
    expect(qc.get("Swords")).toBe(2);
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

  it("reverts on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt"] });

    await useLiveStore.getState().addFloat("Counterspell");

    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt"]);
  });

  it("reverts on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

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

  it("reverts on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc", floatedCards: ["Bolt", "Counterspell"] });

    await useLiveStore.getState().removeFloat("Bolt");

    expect(useLiveStore.getState().floatedCards).toEqual(["Bolt", "Counterspell"]);
  });

  it("reverts on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

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
        phase: "drafting",
        latestPickN: 5,
        nextSeat: 3,
        recentPicks: [],
        seatNames: {},
        numSeats: 10,
        picksPerPlayer: 45,
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
        phase: "drafting",
        latestPickN: 5,
        nextSeat: 5,
        recentPicks: [],
        seatNames: {},
        numSeats: 10,
        picksPerPlayer: 45,
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
        phase: "drafting",
        latestPickN: 5,
        nextSeat: 3,
        recentPicks: [],
        seatNames: {},
        numSeats: 10,
        picksPerPlayer: 45,
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    expect(useLiveStore.getState().isMyTurn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// consecutivePicks derived state
// ---------------------------------------------------------------------------
describe("liveStore — consecutivePicks", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts consecutive picks at snake turning point", async () => {
    // With the mock: derivePickSeat returns seat 1 for pickN <= 2, seat 2 otherwise
    // If latestPickN = 0 and mySeat = 1, then picks 1 and 2 are for seat 1
    useLiveStore.setState({ mySeat: 1 });
    useDraftStore.setState({
      liveDraftStatus: {
        phase: "drafting",
        latestPickN: 0,
        nextSeat: 1,
        recentPicks: [],
        seatNames: {},
        numSeats: 2,
        picksPerPlayer: 5,
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    // Pick 1 → seat 1, Pick 2 → seat 1, Pick 3 → seat 2 (stops)
    expect(useLiveStore.getState().consecutivePicks).toBe(2);
  });

  it("is 0 when it is not my turn", async () => {
    useLiveStore.setState({ mySeat: 2 });
    useDraftStore.setState({
      liveDraftStatus: {
        phase: "drafting",
        latestPickN: 0,
        nextSeat: 1,
        recentPicks: [],
        seatNames: {},
        numSeats: 2,
        picksPerPlayer: 5,
        matchCount: 0,
        totalMatches: 0,
      },
    });

    recomputePicking();

    expect(useLiveStore.getState().consecutivePicks).toBe(0);
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

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
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

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    expect(useLiveStore.getState().deckReady).toBe(false);

    await useLiveStore.getState().fetchDeckState();

    expect(useLiveStore.getState().deckReady).toBe(true);
  });

  it("handles 404 — stays with empty state and marks ready", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Not found", { status: 404 }),
    );

    useDraftStore.setState({ activeDraft: "draft-1" });
    useLiveStore.setState({ seatToken: "tok-abc" });

    await useLiveStore.getState().fetchDeckState();

    const s = useLiveStore.getState();
    expect(s.deckReady).toBe(true);
    // deckState remains empty
    expect(s.deckState.draftId).toBe("");
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
