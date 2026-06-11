// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSharedDeckLoader } from "./useSharedDeckLoader";
import { useLiveStore, _resetDeckState } from "@/app/stores/liveStore";
import { useDraftStore, _resetPollingState } from "@/app/stores/draftStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@/core/localSearch", () => ({ searchLocalCards: vi.fn(() => []) }));
vi.mock("@/core/searchUtils", () => ({ hasScryfallOperators: vi.fn(() => false) }));
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
    consecutivePicks: 0,
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
    viewingSharedDeck: false,
  });
}

describe("useSharedDeckLoader", () => {
  const defaultProps = {
    setDeckBuilderActive: vi.fn(),
    setDeckBuilderModalOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    mockSearchParams.delete("deck");
    defaultProps.setDeckBuilderActive = vi.fn();
    defaultProps.setDeckBuilderModalOpen = vi.fn();
    resetStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when no deck param present", () => {
    vi.spyOn(globalThis, "fetch");
    renderHook(() => useSharedDeckLoader(defaultProps));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches shared deck, sets activeDraft/seat via enterSharedView, and opens deck builder", async () => {
    mockSearchParams.set("deck", "abc123");

    const deckState = {
      draftId: "draft-1",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
    };

    // Stub all network calls: the shared-deck fetch returns the deckState;
    // other calls (hydrateToken side effects, fetchMySeat, etc.) return 401.
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(deckState), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValue(new Response("{}", { status: 401 }));

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(useDraftStore.getState().activeDraft).toBe("draft-1");
    });

    expect(useDraftStore.getState().selectedSeat).toBe(3);
    expect(defaultProps.setDeckBuilderActive).toHaveBeenCalledWith(true);
    expect(defaultProps.setDeckBuilderModalOpen).toHaveBeenCalledWith(true);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deck/abc123");
  });

  it("logs error on fetch failure and does not set state", async () => {
    mockSearchParams.set("deck", "bad-id");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load shared deck"),
      );
    });

    expect(useDraftStore.getState().activeDraft).toBe(null);
  });

  it("logs error on network failure", async () => {
    mockSearchParams.set("deck", "abc123");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to load shared deck:", expect.any(Error));
    });
  });

  // -----------------------------------------------------------------------
  // D3 regression: shared snapshot must NOT be replaced by viewer's WIP fetch
  // -----------------------------------------------------------------------
  it("viewer with a seat token: shared snapshot is NOT replaced by the WIP fetchDeckState response", async () => {
    mockSearchParams.set("deck", "snap-id");

    const sharedDeck = {
      draftId: "draft-42",
      seat: 2,
      zones: {
        deck: { "Lightning Bolt": { quantity: 1, scryfallData: null } },
        sideboard: {},
      },
    };

    const viewerWipDeck = {
      draftId: "draft-42",
      seat: 2,
      zones: {
        deck: { "Counterspell": { quantity: 1, scryfallData: null } },
        sideboard: {},
      },
    };

    // Pre-load: viewer has a token for this draft
    localStorage.setItem("seatToken:draft-42", "viewer-token-xyz");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/deck/snap-id") {
        return new Response(JSON.stringify(sharedDeck), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/deck-state")) {
        // Simulate the viewer's own WIP deck arriving asynchronously
        return new Response(JSON.stringify(viewerWipDeck), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // fetchMySeat, fetchQueue, etc.
      return new Response("{}", { status: 401 });
    });

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(useDraftStore.getState().activeDraft).toBe("draft-42");
    });

    // Give fetchDeckState a chance to resolve (it should bail because viewingSharedDeck=true)
    await new Promise((r) => setTimeout(r, 50));

    // viewingSharedDeck must still be true
    expect(useLiveStore.getState().viewingSharedDeck).toBe(true);

    // The deck state should reflect the SHARED snapshot, not the viewer's WIP deck.
    // The shared snapshot has Lightning Bolt in the deck zone; the WIP has Counterspell.
    const deckZone = useLiveStore.getState().deckState.zones.deck;
    expect("Lightning Bolt" in deckZone).toBe(true);
    expect("Counterspell" in deckZone).toBe(false);
  });

  // -----------------------------------------------------------------------
  // D3: editing while viewing shared deck must never PUT to the server.
  // This test exercises dispatchDeck's guard directly — no hook needed.
  // -----------------------------------------------------------------------
  it("editing while viewing a shared deck never triggers a PUT save", async () => {
    vi.useFakeTimers();

    // Set up as if enterSharedView already ran: viewing a shared deck
    useDraftStore.setState({ activeDraft: "draft-42" });
    useLiveStore.setState({
      seatToken: "viewer-token",
      viewingSharedDeck: true,
      deckState: createEmptyDeckState("draft-42", 2),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    // Dispatch a user edit action (non-snapshot)
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    // Advance past debounce interval
    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    // No PUT should have been made
    const putCalls = fetchSpy.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCalls).toHaveLength(0);

    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // D3: after leaving shared view (draft switch), normal fetch/sync resumes.
  // This test exercises the activeDraft subscription's viewingSharedDeck reset.
  // -----------------------------------------------------------------------
  it("switching away from shared view restores normal deck-save behavior", async () => {
    // Start in shared-view mode
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    useDraftStore.setState({ activeDraft: "draft-42" });
    useLiveStore.setState({
      seatToken: "my-token",
      viewingSharedDeck: true,
      deckState: createEmptyDeckState("draft-42", 2),
    });

    expect(useLiveStore.getState().viewingSharedDeck).toBe(true);

    // Switch to a different draft — the subscription resets viewingSharedDeck
    useDraftStore.getState().setActiveDraft("draft-99");

    // viewingSharedDeck must be cleared after the draft switch
    expect(useLiveStore.getState().viewingSharedDeck).toBe(false);

    // Now verify a user edit schedules a save normally
    vi.useFakeTimers();
    useLiveStore.setState({
      seatToken: "my-token",
      deckState: createEmptyDeckState("draft-99", 1),
    });

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    const putCalls = fetchSpy.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCalls).toHaveLength(1);

    vi.useRealTimers();
  });
});
