// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useDraftStore, _resetPollingState } from "./draftStore";
import {
  useCardStore,
  EMPTY_CARD_DATA,
  EMPTY_DRAFT_STATS,
  _resetSearchState,
  type CardStatsData,
} from "./cardStore";
import type { EnrichedCardStats } from "@/core/types";

vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/localSearch", () => ({
  searchLocalCards: vi.fn(() => []),
}));
vi.mock("@/core/searchUtils", () => ({
  hasScryfallOperators: vi.fn(() => false),
}));

function makeCard(
  name: string,
  opts?: { scryfall?: boolean },
): EnrichedCardStats {
  return {
    cardName: name,
    weightedGeomean: 5,
    timesAvailable: 3,
    draftsPickedIn: 1,
    maxCopiesInDraft: 1,
    colors: ["R"],
    ...(opts?.scryfall !== false
      ? {
          scryfall: {
            name,
            imageUri: "",
            manaCost: "{R}",
            manaValue: 1,
            typeLine: "Instant",
            colors: ["R"],
            colorIdentity: ["R"],
            oracleText: "Deal 3 damage.",
          },
        }
      : {}),
  };
}

function resetStores() {
  _resetPollingState();
  _resetSearchState();
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
    syncStatus: {
      lastSyncedAt: "0",
      syncInProgress: false,
      activeDrafts: [],
    },
    manualSyncInFlight: false,
  });

  useCardStore.setState({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,
    searchQuery: "",
    colorFilter: [],
    colorFilterMode: "inclusive",
    scryfallMatchNames: null,
    scryfallDataMap: new Map(),
    cardStatsMap: new Map(),
    takenCardNamesSet: undefined,
    takenCardCounts: undefined,
    seatCardNames: undefined,
    seatCardList: undefined,
    bannedCardNamesSet: undefined,
    displayCards: [],
    searchFilteredCards: [],
    availableCount: 0,
    drafts: [],
    selectedCard: null,
    cardStatsDetail: null,
    cardStatsLoading: false,
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
      winRateBySeat: [
        {
          seat: 1,
          wins: 5,
          losses: 2,
          winRate: 0.71,
          ciLower: 0.4,
          ciUpper: 0.9,
        },
      ],
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

    // Wait for any subscription-triggered fetches to fully settle (including in-flight guard release)
    await vi.waitFor(() =>
      expect(useCardStore.getState().isLoading).toBe(false),
    );
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

    // Wait for the subscription-triggered fetch to settle before subscribing
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));
    fetchSpy.mockClear();

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
      cardData: {
        ...EMPTY_CARD_DATA,
        cards: [{ cardName: "Bolt" }] as never[],
        draftCount: 1,
      },
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

    // Wait for the subscription-triggered fetch to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));

    const state = useCardStore.getState();
    expect(state.cardData.cards).toEqual([{ cardName: "Bolt" }]);
    expect(state.cardData.ingestionHash).toBe("abc");
    expect(state.draftStats.ingestionHash).toBe("abc");
  });

  it("handles fetch error gracefully", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    // Wait for the subscription-triggered fetch (with the valid mock) to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));

    // Now swap in the failing mock and trigger a fresh fetch
    fetchSpy.mockRejectedValue(new Error("Network error"));
    fetchSpy.mockClear();

    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await useCardStore.getState().fetchCardData();

    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to fetch card data:",
      expect.any(Error),
    );
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

// ---------------------------------------------------------------------------
// Search actions
// ---------------------------------------------------------------------------

describe("cardStore — search actions", () => {
  beforeEach(resetStores);

  it("setSearchQuery updates searchQuery immediately", () => {
    useCardStore.getState().setSearchQuery("bolt");
    expect(useCardStore.getState().searchQuery).toBe("bolt");
  });

  it("clearSearch resets searchQuery", () => {
    useCardStore.getState().setSearchQuery("bolt");
    useCardStore.getState().clearSearch();
    const state = useCardStore.getState();
    expect(state.searchQuery).toBe("");
    expect(state.scryfallMatchNames).toBeNull();
  });

  it("setColorFilter updates colorFilter", () => {
    useCardStore.getState().setColorFilter(["W", "U"]);
    expect(useCardStore.getState().colorFilter).toEqual(["W", "U"]);
  });

  it("setColorFilterMode updates colorFilterMode", () => {
    useCardStore.getState().setColorFilterMode("exclusive");
    expect(useCardStore.getState().colorFilterMode).toBe("exclusive");
  });
});

// ---------------------------------------------------------------------------
// Derived state
// ---------------------------------------------------------------------------

describe("cardStore — derived state", () => {
  beforeEach(resetStores);

  it("scryfallDataMap computed from cardData.cards", () => {
    const bolt = makeCard("Lightning Bolt");
    const noScry = makeCard("Mystery Card", { scryfall: false });

    useCardStore.getState().hydrate(
      { ...EMPTY_CARD_DATA, cards: [bolt, noScry] },
      EMPTY_DRAFT_STATS,
    );

    const map = useCardStore.getState().scryfallDataMap;
    expect(map.size).toBe(1);
    expect(map.get("Lightning Bolt")?.name).toBe("Lightning Bolt");
    expect(map.has("Mystery Card")).toBe(false);
  });

  it("cardStatsMap computed from cardData.cards", () => {
    const bolt = makeCard("Lightning Bolt");
    const path = makeCard("Path to Exile");

    useCardStore.getState().hydrate(
      { ...EMPTY_CARD_DATA, cards: [bolt, path] },
      EMPTY_DRAFT_STATS,
    );

    const map = useCardStore.getState().cardStatsMap;
    expect(map.size).toBe(2);
    expect(map.get("Lightning Bolt")?.cardName).toBe("Lightning Bolt");
    expect(map.get("Path to Exile")?.cardName).toBe("Path to Exile");
  });

  it("takenCardNamesSet: fully-taken cards only (respects cubeCopies)", () => {
    const bolt = makeCard("Lightning Bolt");
    const path = makeCard("Path to Exile");

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [bolt, path],
        cubeCopies: { "Lightning Bolt": 2, "Path to Exile": 1 },
        takenCards: [
          { name: "Lightning Bolt", seat: 1 },
          { name: "Path to Exile", seat: 2 },
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    const state = useCardStore.getState();
    // Bolt has 2 copies, only 1 taken — not fully taken
    expect(state.takenCardNamesSet?.has("Lightning Bolt")).toBe(false);
    // Path has 1 copy, 1 taken — fully taken
    expect(state.takenCardNamesSet?.has("Path to Exile")).toBe(true);
  });

  it("takenCardCounts computed from cardData.takenCards", () => {
    const bolt = makeCard("Lightning Bolt");

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [bolt],
        takenCards: [
          { name: "Lightning Bolt", seat: 1 },
          { name: "Lightning Bolt", seat: 2 },
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    const counts = useCardStore.getState().takenCardCounts;
    expect(counts?.get("Lightning Bolt")).toBe(2);
  });

  it("seatCardNames computed from takenCards filtered by selectedSeat", () => {
    useDraftStore.setState({ selectedSeat: 1 });

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Bolt"), makeCard("Path")],
        takenCards: [
          { name: "Bolt", seat: 1 },
          { name: "Path", seat: 2 },
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    const state = useCardStore.getState();
    expect(state.seatCardNames?.has("Bolt")).toBe(true);
    expect(state.seatCardNames?.has("Path")).toBe(false);
  });

  it("seatCardList computed from takenCards filtered by selectedSeat (ordered)", () => {
    useDraftStore.setState({ selectedSeat: 1 });

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Bolt"), makeCard("Path"), makeCard("Snap")],
        takenCards: [
          { name: "Bolt", seat: 1 },
          { name: "Path", seat: 2 },
          { name: "Snap", seat: 1 },
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    expect(useCardStore.getState().seatCardList).toEqual(["Bolt", "Snap"]);
  });

  it("displayCards filters out banned cards when active draft is selected", () => {
    useDraftStore.setState({ activeDraft: "d1" });

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Bolt"), makeCard("Path"), makeCard("Snap")],
        bannedCardNames: ["Path"],
      },
      EMPTY_DRAFT_STATS,
    );

    const names = useCardStore
      .getState()
      .displayCards.map((c) => c.cardName);
    expect(names).toContain("Bolt");
    expect(names).toContain("Snap");
    expect(names).not.toContain("Path");
  });

  it("displayCards filters out taken cards when hideTaken is true, but keeps selected seat's cards", () => {
    useDraftStore.setState({
      activeDraft: "d1",
      hideTaken: true,
      selectedSeat: 1,
    });

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Bolt"), makeCard("Path"), makeCard("Snap")],
        cubeCopies: { Bolt: 1, Path: 1, Snap: 1 },
        takenCards: [
          { name: "Bolt", seat: 1 },
          { name: "Path", seat: 2 },
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    const names = useCardStore
      .getState()
      .displayCards.map((c) => c.cardName);
    // Bolt is taken by seat 1 (selected seat) — should be kept
    expect(names).toContain("Bolt");
    // Path is taken by seat 2 — should be filtered out
    expect(names).not.toContain("Path");
    // Snap is not taken — should be kept
    expect(names).toContain("Snap");
  });

  it("searchFilteredCards applies Scryfall filter on top of displayCards", () => {
    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Bolt"), makeCard("Path"), makeCard("Snap")],
      },
      EMPTY_DRAFT_STATS,
    );

    // Simulate scryfallMatchNames being set (as if a Scryfall search ran)
    useCardStore.setState({
      scryfallMatchNames: new Set(["Bolt", "Snap"]),
    });
    // Trigger recompute by calling a no-op action
    useCardStore.getState().setColorFilter([]);

    const names = useCardStore
      .getState()
      .searchFilteredCards.map((c) => c.cardName);
    expect(names).toContain("Bolt");
    expect(names).toContain("Snap");
    expect(names).not.toContain("Path");
  });

  it("searchFilteredCards applies name filter when no Scryfall operators", () => {
    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [
          makeCard("Lightning Bolt"),
          makeCard("Path to Exile"),
          makeCard("Snapcaster Mage"),
        ],
      },
      EMPTY_DRAFT_STATS,
    );

    useCardStore.getState().setSearchQuery("bolt");

    const names = useCardStore
      .getState()
      .searchFilteredCards.map((c) => c.cardName);
    expect(names).toEqual(["Lightning Bolt"]);
  });

  it("availableCount excludes banned and taken cards (with front-face DFC check)", () => {
    useDraftStore.setState({ activeDraft: "d1" });

    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        cards: [
          makeCard("Bolt"),
          makeCard("Path"),
          makeCard("Snap"),
          makeCard("Delver // Insectile"),
        ],
        cubeCopies: { Bolt: 1, Path: 1, Snap: 1, "Delver // Insectile": 1 },
        takenCards: [{ name: "Bolt", seat: 1 }],
        bannedCardNames: ["Delver"],
      },
      EMPTY_DRAFT_STATS,
    );

    // Available: Path, Snap (Bolt taken, Delver banned via front face)
    expect(useCardStore.getState().availableCount).toBe(2);
  });

  it("drafts array built from cardData.draftIds + draftMetadata", () => {
    useCardStore.getState().hydrate(
      {
        ...EMPTY_CARD_DATA,
        draftIds: ["d1", "d2"],
        completedDraftIds: ["d1"],
        draftMetadata: {
          d1: { name: "Alpha", date: "2026-01-01", numDrafters: 8 },
          d2: { name: "Beta", date: "2026-02-01", numDrafters: 10 },
        },
      },
      EMPTY_DRAFT_STATS,
    );

    const drafts = useCardStore.getState().drafts;
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual({
      id: "d1",
      name: "Alpha",
      date: "2026-01-01",
      isComplete: true,
      numDrafters: 8,
    });
    expect(drafts[1]).toEqual({
      id: "d2",
      name: "Beta",
      date: "2026-02-01",
      isComplete: false,
      numDrafters: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Card stats modal
// ---------------------------------------------------------------------------

describe("cardStore — card stats modal", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockStatsData: CardStatsData = {
    pick: {
      drafts_in_pool: 5,
      times_picked: 3,
      avg_pick: 4.2,
      median_pick: 4,
      geomean_pick: 4.0,
    },
    pick_history: [],
    pick_distribution: [],
    times_banned: 0,
    color_pair_breakdown: [],
  };

  beforeEach(() => {
    resetStores();
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValue(new Response(JSON.stringify(mockStatsData)));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("selectCard sets selectedCard and fetches /api/cards/stats", async () => {
    await useCardStore.getState().selectCard("Lightning Bolt");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("/api/cards/stats");
    expect(url).toContain("card_name=Lightning+Bolt");

    const state = useCardStore.getState();
    expect(state.selectedCard).toBe("Lightning Bolt");
    expect(state.cardStatsDetail).toEqual(mockStatsData);
  });

  it("selectCard passes excludeDraftId when provided", async () => {
    await useCardStore.getState().selectCard("Snapcaster Mage", "draft-123");

    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("exclude_draft_id=draft-123");
  });

  it("clearSelectedCard resets selectedCard and cardStatsDetail", async () => {
    await useCardStore.getState().selectCard("Lightning Bolt");

    useCardStore.getState().clearSelectedCard();

    const state = useCardStore.getState();
    expect(state.selectedCard).toBeNull();
    expect(state.cardStatsDetail).toBeNull();
  });

  it("cardStatsLoading is true during fetch", async () => {
    const loadingStates: boolean[] = [];
    const unsub = useCardStore.subscribe(
      (state) => state.cardStatsLoading,
      (loading) => loadingStates.push(loading),
    );

    await useCardStore.getState().selectCard("Path to Exile");
    unsub();

    expect(loadingStates).toEqual([true, false]);
  });
});
