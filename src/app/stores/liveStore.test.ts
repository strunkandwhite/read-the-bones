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
  });
});
