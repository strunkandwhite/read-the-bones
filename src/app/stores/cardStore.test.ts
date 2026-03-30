// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useDraftStore, _resetPollingState } from "./draftStore";
import { useCardStore, EMPTY_CARD_DATA, EMPTY_DRAFT_STATS } from "./cardStore";

vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));

function resetStores() {
  _resetPollingState();
  localStorage.clear();

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

  useCardStore.setState({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,
  });
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

describe("cardStore — hydration", () => {
  beforeEach(resetStores);

  it("hydrate sets cardData and draftStats from SSR props", () => {
    const mockCards = {
      ...EMPTY_CARD_DATA,
      cards: [{ cardName: "Bolt" }],
      draftCount: 3,
      ingestionHash: "abc",
    };
    const mockStats = {
      winRateBySeat: [{ seat: 1, wins: 5, losses: 2, winRate: 0.71, ciLower: 0.4, ciUpper: 0.9 }],
      winRateByColor: [],
      ingestionHash: "abc",
    };

    useCardStore.getState().hydrate(mockCards as never, mockStats);

    const state = useCardStore.getState();
    expect(state.cardData.cards).toHaveLength(1);
    expect(state.cardData.draftCount).toBe(3);
    expect(state.draftStats.winRateBySeat).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fetchCardData
// ---------------------------------------------------------------------------

describe("cardStore — fetchCardData", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockCardsResponse = {
    cards: [{ cardName: "Bolt" }],
    draftCount: 1,
    cubeCopies: {},
    draftMetadata: {},
    draftIds: ["d1"],
    completedDraftIds: ["d1"],
    ingestionHash: "abc",
  };

  const mockStatsResponse = {
    winRateBySeat: [],
    winRateByColor: [],
    ingestionHash: "abc",
  };

  beforeEach(() => {
    resetStores();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/cards")) {
        return new Response(JSON.stringify(mockCardsResponse));
      }
      if (urlStr.includes("/api/draft-stats")) {
        return new Response(JSON.stringify(mockStatsResponse));
      }
      return new Response("", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("reads selectedDrafts, activeDraft, poolAsOfDraft from draftStore", async () => {
    useDraftStore.setState({
      selectedDrafts: new Set(["d1", "d2"]),
      activeDraft: "d1",
      poolAsOfDraft: "d2",
    });

    // Wait for any subscription-triggered fetches to settle
    await vi.waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(0));
    fetchSpy.mockClear();

    await useCardStore.getState().fetchCardData();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const cardsUrl = String(fetchSpy.mock.calls[0][0]);
    expect(cardsUrl).toContain("drafts=d1%2Cd2");
    expect(cardsUrl).toContain("activeDraft=d1");
    // effectivePool = activeDraft ?? poolAsOfDraft = "d1"
    expect(cardsUrl).toContain("poolAsOfDraft=d1");
  });

  it("sets isLoading during fetch", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    const loadingStates: boolean[] = [];
    const unsub = useCardStore.subscribe(
      (state) => state.isLoading,
      (loading) => loadingStates.push(loading),
    );

    await useCardStore.getState().fetchCardData();
    unsub();

    // Should have gone true then false
    expect(loadingStates).toEqual([true, false]);
  });

  it("clears cards when selectedDrafts is empty", async () => {
    // Pre-populate some card data
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, cards: [{ cardName: "Bolt" }] as never[], draftCount: 1 },
    });

    useDraftStore.setState({ selectedDrafts: new Set() });

    await useCardStore.getState().fetchCardData();

    const state = useCardStore.getState();
    expect(state.cardData.cards).toEqual([]);
    expect(state.cardData.draftCount).toBe(0);
    expect(state.cardData.cubeCopies).toEqual({});
    // Should not have called fetch
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses effectivePoolAsOfDraft = activeDraft ?? poolAsOfDraft", async () => {
    // When activeDraft is null, effectivePool should use poolAsOfDraft
    useDraftStore.setState({
      selectedDrafts: new Set(["d1"]),
      activeDraft: null,
      poolAsOfDraft: "d2",
    });

    await useCardStore.getState().fetchCardData();

    const cardsUrl = String(fetchSpy.mock.calls[0][0]);
    expect(cardsUrl).toContain("poolAsOfDraft=d2");
    expect(cardsUrl).not.toContain("activeDraft=");
  });

  it("updates cardData and draftStats on successful fetch", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    await useCardStore.getState().fetchCardData();

    const state = useCardStore.getState();
    expect(state.cardData.cards).toEqual([{ cardName: "Bolt" }]);
    expect(state.cardData.ingestionHash).toBe("abc");
    expect(state.draftStats.ingestionHash).toBe("abc");
  });

  it("handles fetch error gracefully", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await useCardStore.getState().fetchCardData();

    expect(consoleSpy).toHaveBeenCalledWith("Failed to fetch card data:", expect.any(Error));
    expect(useCardStore.getState().isLoading).toBe(false);

    consoleSpy.mockRestore();
  });

  it("passes ingestionHash as v param", async () => {
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash123" },
    });
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    await useCardStore.getState().fetchCardData();

    const cardsUrl = String(fetchSpy.mock.calls[0][0]);
    expect(cardsUrl).toContain("v=hash123");
    const statsUrl = String(fetchSpy.mock.calls[1][0]);
    expect(statsUrl).toContain("v=hash123");
  });
});
