// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useLiveStore } from "./liveStore";
import { useDraftStore, _resetPollingState } from "./draftStore";

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));

function resetStores() {
  _resetPollingState();
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
