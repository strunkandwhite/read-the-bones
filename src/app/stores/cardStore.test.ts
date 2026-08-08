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
import type { WorthCard } from "@/core/worthModel";

// Default to a non-local client; worth-table tests flip this to true.
const { isLocalClientMock } = vi.hoisted(() => ({
  isLocalClientMock: vi.fn(() => false),
}));
vi.mock("@/core/isLocal", () => ({ isLocalClient: isLocalClientMock }));
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
    pickVersion: 0,
    dataVersion: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: {
      lastSyncedAt: "0",
      syncInProgress: false,
      activeDrafts: [],
    },
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
    worthCards: new Map(),
    worthModel: null,
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

  it("uses server ingestionHash from syncStatus as v param when available", async () => {
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "client-hash" },
    });
    useDraftStore.setState({
      selectedDrafts: new Set(["d1"]),
      syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [], ingestionHash: "server-hash" },
    });

    await useCardStore.getState().fetchCardData();

    const cardsUrl = String(fetchSpy.mock.calls[0][0]);
    // Server hash takes precedence — busts toward new data rather than re-requesting old data
    expect(cardsUrl).toContain("v=server-hash");
  });

  it("pick-driven fetch (includeDraftStats=false) only calls /api/cards, not /api/draft-stats", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    // Wait for any subscription-triggered fetch to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));
    fetchSpy.mockClear();

    await useCardStore.getState().fetchCardData({ includeDraftStats: false });

    const urls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u: string) => u.includes("/api/cards"))).toBe(true);
    expect(urls.every((u: string) => !u.includes("/api/draft-stats"))).toBe(true);
  });

  it("default fetch (includeDraftStats=true) calls both /api/cards and /api/draft-stats", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    // Wait for any subscription-triggered fetch to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));
    fetchSpy.mockClear();

    await useCardStore.getState().fetchCardData();

    const urls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u: string) => u.includes("/api/cards"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/api/draft-stats"))).toBe(true);
  });

  it("pickVersion bump does NOT call /api/cards — taken state is derived from board.picks instead", async () => {
    // Populate card data with a card + cube copies so taken-state computation is meaningful.
    useCardStore.setState({
      cardData: {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Lightning Bolt")],
        cubeCopies: { "Lightning Bolt": 1 },
      },
    });
    useDraftStore.setState({
      selectedDrafts: new Set(["d1"]),
      activeDraft: "d1",
    });

    // Wait for subscription-triggered fetch to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));
    fetchSpy.mockClear();

    // Simulate a pick landing: board.picks gets Lightning Bolt for seat 1
    const boardWithPick = {
      picks: [{ pickN: 1, seat: 1, cardName: "Lightning Bolt", oracleId: "oid", colorIdentity: ["R"], manaCost: "{R}" }],
      numSeats: 10,
      picksPerPlayer: 45,
      doublePickAfterRound: null,
      phase: "drafting",
      seatNames: {},
      bannedCards: [],
      isSheetDraft: false,
      redactedSeats: [],
    };
    useDraftStore.setState({ board: boardWithPick, pickVersion: 1 });

    // Give the subscription a tick to run
    await Promise.resolve();

    // No fetch should have been made — pick-driven state is local
    expect(fetchSpy).not.toHaveBeenCalled();

    // Taken state should now reflect the pick from board.picks
    const state = useCardStore.getState();
    expect(state.takenCardNamesSet?.has("Lightning Bolt")).toBe(true);
    expect(state.takenCardCounts?.get("Lightning Bolt")).toBe(1);
  });

  it("dataVersion bump triggers both card and draft-stats fetch", async () => {
    useDraftStore.setState({ selectedDrafts: new Set(["d1"]) });

    // Wait for subscription-triggered fetch to settle
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));
    fetchSpy.mockClear();

    // Bump dataVersion (simulates ingestion/sync change)
    useDraftStore.setState({ dataVersion: 1 });

    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));

    const urls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(urls.some((u: string) => u.includes("/api/cards"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/api/draft-stats"))).toBe(true);
  });

  it("discards a stale response when a newer fetch supersedes it — committed state reflects the LATEST selection", async () => {
    // Two overlapping fetches: first for draft A, second for draft B.
    // The first fetch resolves AFTER the second (out of order).
    // Only draft B's data must be committed.

    const responseA = {
      ...mockCardsResponse,
      cards: [{ cardName: "Draft-A Card" }],
      draftIds: ["dA"],
    };
    const responseB = {
      ...mockCardsResponse,
      cards: [{ cardName: "Draft-B Card" }],
      draftIds: ["dB"],
    };
    const statsResponse = mockStatsResponse;

    let resolveA!: (v: Response) => void;
    let resolveB!: (v: Response) => void;

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/draft-stats")) {
        return new Response(JSON.stringify(statsResponse));
      }
      if (urlStr.includes("drafts=dA")) {
        return new Promise<Response>((res) => { resolveA = res; });
      }
      if (urlStr.includes("drafts=dB")) {
        return new Promise<Response>((res) => { resolveB = res; });
      }
      return new Response("", { status: 404 });
    });

    // Start fetch A (draft A is selected).
    useDraftStore.setState({ selectedDrafts: new Set(["dA"]) });
    // The subscription triggers fetchCardData for dA; it's now in-flight.
    // Give the microtask queue a tick so fetchInFlight is set.
    await Promise.resolve();

    // While fetch A is still in flight, change to draft B.
    // The subscription fires but fetchInFlight is true → pendingFetch = true.
    useDraftStore.setState({ selectedDrafts: new Set(["dB"]) });
    await Promise.resolve();

    // Resolve A first (stale — should be discarded).
    resolveA(new Response(JSON.stringify(responseA)));

    // Wait for fetch A's finally block to run and kick off fetch B.
    await vi.waitFor(() =>
      expect(fetchSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("drafts=dB"))).toBe(true)
    );

    // Now resolve B.
    resolveB(new Response(JSON.stringify(responseB)));

    // Wait for all fetches to settle.
    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));

    // The committed cardData must be from draft B, not draft A.
    const finalCards = useCardStore.getState().cardData.cards;
    expect(finalCards).toHaveLength(1);
    expect(finalCards[0]).toEqual({ cardName: "Draft-B Card" });
  });

  it("a trigger during an in-flight fetch is not lost — final state corresponds to the final selection", async () => {
    // Setup: start with draft A selected and a fetch in flight.
    // Trigger arrives for draft B mid-flight (pendingFetch becomes true).
    // After fetch A resolves, a new fetch for draft B runs automatically.

    const responseA = { ...mockCardsResponse, draftIds: ["dA"], cards: [{ cardName: "Card A" }] };
    const responseB = { ...mockCardsResponse, draftIds: ["dB"], cards: [{ cardName: "Card B" }] };
    const statsResponse = mockStatsResponse;

    let resolveA!: (v: Response) => void;
    let resolveB!: (v: Response) => void;
    let bFetchStarted = false;

    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      const urlStr = String(url);
      if (urlStr.includes("/api/draft-stats")) {
        return new Response(JSON.stringify(statsResponse));
      }
      if (urlStr.includes("drafts=dA")) {
        return new Promise<Response>((res) => { resolveA = res; });
      }
      if (urlStr.includes("drafts=dB")) {
        bFetchStarted = true;
        return new Promise<Response>((res) => { resolveB = res; });
      }
      return new Response("", { status: 404 });
    });

    // Trigger fetch A.
    useDraftStore.setState({ selectedDrafts: new Set(["dA"]) });
    await Promise.resolve();

    // Change selection to B while A is in-flight — should queue a pending fetch.
    useDraftStore.setState({ selectedDrafts: new Set(["dB"]) });
    await Promise.resolve();

    // The pending fetch has NOT fired yet (A is still in-flight).
    expect(bFetchStarted).toBe(false);

    // Resolve A.
    resolveA(new Response(JSON.stringify(responseA)));

    // After A's finally block runs, the pending fetch for B should start.
    await vi.waitFor(() => expect(bFetchStarted).toBe(true));

    // Resolve B.
    resolveB(new Response(JSON.stringify(responseB)));

    await vi.waitFor(() => expect(useCardStore.getState().isLoading).toBe(false));

    // Final committed state must be B's data.
    const finalCards = useCardStore.getState().cardData.cards;
    expect(finalCards).toHaveLength(1);
    expect(finalCards[0]).toEqual({ cardName: "Card B" });
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

  it("displayCards filters out all taken cards when hideTaken is true, including the selected seat's own picks", () => {
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
    // Bolt is taken by seat 1 (selected seat) — now hidden too
    expect(names).not.toContain("Bolt");
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

  it("cache hit: reopening the same card does not refetch", async () => {
    // Establish a consistent ingestionHash so cache key is stable
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
    });

    // First open — fetches from network
    await useCardStore.getState().selectCard("Lightning Bolt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Second open — same name + same ingestionHash → cache hit, no fetch
    await useCardStore.getState().selectCard("Lightning Bolt");
    expect(fetchSpy).not.toHaveBeenCalled();

    // The result is still present
    expect(useCardStore.getState().cardStatsDetail).toEqual(mockStatsData);
  });

  it("cache is invalidated when ingestionHash changes (dataVersion bump)", async () => {
    // Use mockImplementation so each fetch call gets a fresh Response body
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(mockStatsData)))
    );

    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
    });

    // First fetch — populates cache for hash-v1
    await useCardStore.getState().selectCard("Lightning Bolt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Simulate ingestion: ingestionHash changes (as would arrive after fetchCardData)
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v2" },
    });

    // Cache miss on hash-v2 → must refetch
    await useCardStore.getState().selectCard("Lightning Bolt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("cache is keyed by name + excludeDraftId independently", async () => {
    // Use mockImplementation so each fetch call gets a fresh Response body
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(mockStatsData)))
    );

    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
    });

    // Fetch without excludeDraftId
    await useCardStore.getState().selectCard("Lightning Bolt");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Fetch with a different excludeDraftId — different cache key, must refetch
    await useCardStore.getState().selectCard("Lightning Bolt", "draft-xyz");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockClear();

    // Repeat with the same excludeDraftId — cache hit, no fetch
    await useCardStore.getState().selectCard("Lightning Bolt", "draft-xyz");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Worth table (dev-only)
// ---------------------------------------------------------------------------

describe("cardStore — worth table", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const mockWorthCard: WorthCard = {
    card_name: "Lightning Bolt",
    colors: "R",
    is_land: false,
    in_current_cube: true,
    geomean: 4.2,
    games: 33,
    wins: 20,
    losses: 13,
    wr: 0.606,
    se: 0.085,
    delta: 0.05,
    expected: 0.003,
    pvi: 0.021,
    worth: 0.047,
    prior_only: false,
    no_data: false,
    act_by: 17,
  };

  const mockWorthResponse = {
    cards: [mockWorthCard],
    model: {
      a: 0.0255,
      b: -0.007,
      tau: 0.035,
      sigma: 0.51,
      tau_a: 0.0187,
      kappa: 0.5,
      baselines: { R: 0.52 },
      pair_edges: { UR: 0.0271 },
    },
  };

  beforeEach(() => {
    resetStores();
    isLocalClientMock.mockReturnValue(true);
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: string | URL | Request) => {
      if (String(url).includes("/api/cards/worth")) {
        return new Response(JSON.stringify(mockWorthResponse));
      }
      return new Response("", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    isLocalClientMock.mockReturnValue(false);
  });

  it("hydration triggers the worth fetch and stores cards keyed by card_name plus the model", async () => {
    useCardStore
      .getState()
      .hydrate(
        { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
        EMPTY_DRAFT_STATS,
      );

    await vi.waitFor(() =>
      expect(useCardStore.getState().worthCards.size).toBe(1),
    );

    expect(fetchSpy).toHaveBeenCalledWith("/api/cards/worth");
    const state = useCardStore.getState();
    expect(state.worthCards.get("Lightning Bolt")).toEqual(mockWorthCard);
    expect(state.worthModel).toEqual(mockWorthResponse.model);
  });

  it("does not fetch when not a local client (production route 404s)", async () => {
    isLocalClientMock.mockReturnValue(false);

    await useCardStore.getState().fetchWorthTable();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useCardStore.getState().worthCards.size).toBe(0);
  });

  it("caches by ingestionHash: repeat calls with the same hash do not refetch", async () => {
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
    });
    await vi.waitFor(() =>
      expect(useCardStore.getState().worthCards.size).toBe(1),
    );
    fetchSpy.mockClear();

    await useCardStore.getState().fetchWorthTable();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refetches when the ingestionHash changes", async () => {
    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v1" },
    });
    await vi.waitFor(() =>
      expect(useCardStore.getState().worthCards.size).toBe(1),
    );
    fetchSpy.mockClear();

    useCardStore.setState({
      cardData: { ...EMPTY_CARD_DATA, ingestionHash: "hash-v2" },
    });

    await vi.waitFor(() =>
      expect(
        fetchSpy.mock.calls.some((c: unknown[]) =>
          String(c[0]).includes("/api/cards/worth"),
        ),
      ).toBe(true),
    );
  });

  it("swallows network errors into an empty state, then retries on the next call", async () => {
    fetchSpy.mockRejectedValue(new Error("dev server mid-compile"));

    await useCardStore.getState().fetchWorthTable();

    expect(useCardStore.getState().worthCards.size).toBe(0);
    expect(useCardStore.getState().worthModel).toBeNull();

    // The cache marker was cleared on failure, so a retry actually fetches.
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify(mockWorthResponse)),
    );
    await useCardStore.getState().fetchWorthTable();

    expect(useCardStore.getState().worthCards.size).toBe(1);
  });

  it("treats a non-ok response as an error (empty state, no throw)", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("", { status: 404 }),
    );

    await useCardStore.getState().fetchWorthTable();

    expect(useCardStore.getState().worthCards.size).toBe(0);
    expect(useCardStore.getState().worthModel).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Analytics debounce (Q11)
// ---------------------------------------------------------------------------

describe("cardStore — analytics debounce for plain-name search", () => {
  let trackMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    resetStores();
    vi.useFakeTimers();
    const mod = await import("@vercel/analytics/react");
    trackMock = mod.track as ReturnType<typeof vi.fn>;
    trackMock.mockClear();

    // Seed a card so searchFilteredCards has a real count
    useCardStore.setState({
      cardData: {
        ...EMPTY_CARD_DATA,
        cards: [makeCard("Lightning Bolt"), makeCard("Counterspell")],
      },
      searchFilteredCards: [makeCard("Lightning Bolt")],
      displayCards: [makeCard("Lightning Bolt"), makeCard("Counterspell")],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetSearchState();
  });

  it("fires exactly one analytics event after the debounce settles", () => {
    // Type 3 characters quickly
    useCardStore.getState().setSearchQuery("l");
    useCardStore.getState().setSearchQuery("li");
    useCardStore.getState().setSearchQuery("lig");
    expect(trackMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("search", expect.objectContaining({ query_type: "name" }));
  });

  it("cancels pending analytics event when query changes", () => {
    useCardStore.getState().setSearchQuery("bol");
    vi.advanceTimersByTime(200); // Not settled yet
    useCardStore.getState().setSearchQuery("bolt");
    vi.advanceTimersByTime(500); // Only the second event should fire
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it("result_count reflects settled searchFilteredCards length (not -1)", () => {
    // searchFilteredCards is pre-seeded with 1 card above
    useCardStore.getState().setSearchQuery("bolt");
    vi.advanceTimersByTime(500);
    expect(trackMock).toHaveBeenCalledWith(
      "search",
      expect.objectContaining({ result_count: expect.not.stringMatching(/-1/) }),
    );
    // result_count should be a number (not the old -1 placeholder)
    const call = trackMock.mock.calls[0][1] as { result_count: unknown };
    expect(typeof call.result_count).toBe("number");
    expect(call.result_count).not.toBe(-1);
  });
});

describe("cardStore — setDesirePickOverride", () => {
  it("stores valid picks, flooring fractional input", () => {
    useCardStore.getState().setDesirePickOverride(120);
    expect(useCardStore.getState().desirePickOverride).toBe(120);
    useCardStore.getState().setDesirePickOverride(45.7);
    expect(useCardStore.getState().desirePickOverride).toBe(45);
  });

  it("normalizes null, NaN, and sub-1 picks to null (automatic)", () => {
    useCardStore.getState().setDesirePickOverride(120);
    useCardStore.getState().setDesirePickOverride(null);
    expect(useCardStore.getState().desirePickOverride).toBeNull();
    useCardStore.getState().setDesirePickOverride(Number.NaN);
    expect(useCardStore.getState().desirePickOverride).toBeNull();
    useCardStore.getState().setDesirePickOverride(0);
    expect(useCardStore.getState().desirePickOverride).toBeNull();
    useCardStore.getState().setDesirePickOverride(-3);
    expect(useCardStore.getState().desirePickOverride).toBeNull();
  });
});
