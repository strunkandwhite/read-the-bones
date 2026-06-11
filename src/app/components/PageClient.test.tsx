// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { PageClient, type PageClientProps } from "./PageClient";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { useDraftStore, _resetPollingState } from "../stores/draftStore";
import { useCardStore, EMPTY_CARD_DATA, EMPTY_DRAFT_STATS, _resetSearchState } from "../stores/cardStore";
import { useLiveStore, _resetDeckState } from "../stores/liveStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

// Mock child components to simplify rendering
vi.mock("./CardTable", () => ({
  CardTable: () => <div data-testid="card-table" />,
}));
vi.mock("./ColorFilter", () => ({
  ColorFilter: () => <div data-testid="color-filter" />,
}));
vi.mock("./Settings", () => ({
  Settings: () => <div data-testid="settings" />,
}));
vi.mock("./StatsModal", () => ({
  StatsModal: () => <div data-testid="stats-modal" />,
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}));

const defaultDraftStats: DraftStatsResponse = {
  winRateBySeat: [],
  winRateByColor: [],
  ingestionHash: "abc12345",
};

function makeTestProps(overrides?: Partial<CardStatsResponse>): PageClientProps {
  return {
    initialCardData: {
      cards: [
        {
          cardName: "Lightning Bolt",
          weightedGeomean: 5.0,
          timesAvailable: 3,
          draftsPickedIn: 3,
          maxCopiesInDraft: 1,
          colors: ["R"],
        },
      ],
      draftCount: 2,
      cubeCopies: { "Lightning Bolt": 1 },
      draftIds: ["draft-a", "draft-b", "draft-c"],
      completedDraftIds: ["draft-a", "draft-b"],
      draftMetadata: {
        "draft-a": { name: "Draft A", date: "2026-01-01", numDrafters: 10 },
        "draft-b": { name: "Draft B", date: "2026-02-01", numDrafters: 10 },
        "draft-c": { name: "Draft C", date: "2026-03-01", numDrafters: 10 },
      },
      ingestionHash: "abc12345",
      ...overrides,
    },
    initialDraftStats: defaultDraftStats,
  };
}

/** Helper to simulate draft selection change (previously done via Settings prop) */
async function changeDraftSelection(newSelection: Set<string>) {
  useDraftStore.getState().setSelectedDrafts(newSelection);
  await useCardStore.getState().fetchCardData();
}

describe("PageClient", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  // ResizeObserver is not available in jsdom
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    // Provide a default fetch that returns empty-but-valid card data so background
    // subscription-triggered fetches don't throw or corrupt store state.
    // Use mockImplementation so each call gets a fresh Response body (cannot reuse one).
    const emptyCardData = JSON.stringify({
      cards: [],
      draftCount: 0,
      cubeCopies: {},
      draftIds: [],
      completedDraftIds: [],
      draftMetadata: {},
      ingestionHash: "default",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(emptyCardData, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    // Reset store state between tests
    _resetPollingState();
    _resetSearchState();
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
    });
    useCardStore.setState({
      cardData: EMPTY_CARD_DATA,
      draftStats: EMPTY_DRAFT_STATS,
      isLoading: false,
      searchQuery: "",
      colorFilter: [],
      colorFilterMode: "inclusive",
      scryfallMatchNames: null,
      selectedCard: null,
      cardStatsDetail: null,
      cardStatsLoading: false,
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
      pickError: null,
      isMyTurn: false,
      deckState: createEmptyDeckState("", 0),
      deckReady: false,
      deckSaveStatus: "idle",
      deckBuilderActive: false,
    });
  });

  it("shows precomputed data with default selection", () => {
    // Passes initialCardData with Lightning Bolt — after hydration the card table must
    // render (not the empty-state placeholder). The h1 "Read the Bones" is unconditional;
    // asserting the card table testid verifies data-dependent rendering.
    render(<PageClient {...makeTestProps()} />);
    expect(screen.getByTestId("card-table")).toBeDefined();
  });

  it("shows SSR data on initial render with default selection", async () => {
    // The selectedDrafts subscription auto-triggers a background fetch on hydration.
    // The beforeEach spy already provides a default 200 response; override it here
    // to return real card data so the card table renders.
    const data = JSON.stringify(makeTestProps().initialCardData);
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(data, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    await act(async () => {
      render(<PageClient {...makeTestProps()} />);
    });

    // SSR data (Lightning Bolt in initialCardData) drives the card table render.
    // An empty card list would show the empty-state placeholder instead.
    expect(screen.getByTestId("card-table")).toBeDefined();
  });

  it("fetches card data when custom draft selection is made", async () => {
    const mockResponse: CardStatsResponse = {
      ...makeTestProps().initialCardData,
      cards: [],
      draftCount: 1,
      cubeCopies: {},
    };

    const mockResponseJson = JSON.stringify(mockResponse);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(mockResponseJson, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    render(<PageClient {...makeTestProps()} />);

    // Call store actions directly (Settings now reads from stores)
    await act(async () => {
      await changeDraftSelection(new Set(["draft-a"]));
    });

    // Both card and stats endpoints must have been called at least once.
    // The exact call count may be higher than 2 when a pending re-run fires
    // after the first in-flight fetch completes (request-identity semantics).
    const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u: string) => u.includes("/api/cards?"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/api/draft-stats?"))).toBe(true);
  });

  it("logs error when fetch throws after custom draft selection", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    render(<PageClient {...makeTestProps()} />);

    // Call store actions directly
    await act(async () => {
      await changeDraftSelection(new Set(["draft-a"]));
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to fetch card data:",
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it("shows 'No card data available.' when initialCards is empty", () => {
    render(
      <PageClient {...makeTestProps({ cards: [], draftCount: 0 })} />
    );
    const matches = screen.getAllByText("No card data available.");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("shows 'No drafts selected' when selection is empty", async () => {
    // Override the default spy to return card data so the initial render succeeds
    const data = JSON.stringify(makeTestProps().initialCardData);
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(data, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    await act(async () => {
      render(<PageClient {...makeTestProps()} />);
    });

    // Call store actions directly
    await act(async () => {
      await changeDraftSelection(new Set());
    });

    expect(screen.getByText(/No drafts selected/)).toBeDefined();
  });

  it("recovers when returning to default selection after failed fetch", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // First fetch fails
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));

    render(<PageClient {...makeTestProps()} />);

    // Trigger fetch failure with custom selection
    await act(async () => {
      await changeDraftSelection(new Set(["draft-a"]));
    });

    // Now set up a successful response for returning to default
    const successResponseJson = JSON.stringify(makeTestProps().initialCardData);
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(successResponseJson, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    // Return to default selection (all completed drafts)
    await act(async () => {
      await changeDraftSelection(new Set(["draft-a", "draft-b"]));
    });

    // After recovering to default selection with a successful fetch,
    // displayCards is populated with Lightning Bolt — the card table renders,
    // not the empty-state placeholder. This verifies the recovery path actually
    // restores card data, not just the title which is always present.
    expect(screen.getByTestId("card-table")).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("filters out banned cards from display when active draft is selected", async () => {
    localStorage.setItem("activeDraft", "draft-c");

    const props = makeTestProps({
      bannedCardNames: ["Lightning Bolt"],
    });

    // Mock fetch to return the same card data (with banned cards) when
    // the activeDraft subscription triggers fetchCardData
    const propsJson = JSON.stringify(props.initialCardData);
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(new Response(propsJson, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    await act(async () => {
      render(<PageClient {...props} />);
    });

    // The only card is banned + filtered, so we should see the empty state
    const emptyState = screen.queryAllByText("No card data available.");
    expect(emptyState.length).toBeGreaterThan(0);

    localStorage.removeItem("activeDraft");
  });
});
