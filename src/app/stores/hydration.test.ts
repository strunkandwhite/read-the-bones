// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHydration } from "./hydration";
import { useDraftStore, _resetPollingState } from "./draftStore";
import { useCardStore, EMPTY_CARD_DATA, EMPTY_DRAFT_STATS, _resetSearchState } from "./cardStore";

vi.mock("@vercel/analytics/react", () => ({ track: vi.fn() }));
vi.mock("@/core/isLocal", () => ({ isLocalClient: () => false }));
vi.mock("@/core/localSearch", () => ({ searchLocalCards: vi.fn(() => []) }));
vi.mock("@/core/searchUtils", () => ({ hasScryfallOperators: vi.fn(() => false) }));

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
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
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

const mockCardData = {
  ...EMPTY_CARD_DATA,
  draftCount: 2,
  draftIds: ["d1", "d2"],
  completedDraftIds: ["d1", "d2"],
  ingestionHash: "test-hash",
};

const mockDraftStats = {
  ...EMPTY_DRAFT_STATS,
  ingestionHash: "test-hash",
};

describe("useHydration", () => {
  beforeEach(resetStores);

  it("hydrates cardStore on mount", () => {
    renderHook(() =>
      useHydration({
        cardData: mockCardData,
        draftStats: mockDraftStats,
        completedDraftIds: ["d1", "d2"],
      }),
    );

    const state = useCardStore.getState();
    expect(state.cardData.draftCount).toBe(2);
    expect(state.cardData.ingestionHash).toBe("test-hash");
    expect(state.draftStats.ingestionHash).toBe("test-hash");
  });

  it("hydrates draftStore on mount", () => {
    renderHook(() =>
      useHydration({
        cardData: mockCardData,
        draftStats: mockDraftStats,
        completedDraftIds: ["d1", "d2"],
      }),
    );

    const state = useDraftStore.getState();
    expect(state.completedDraftIds).toEqual(["d1", "d2"]);
    expect(state.selectedDrafts).toEqual(new Set(["d1", "d2"]));
    expect(state.hydrated).toBe(true);
  });

  it("returns false before hydration, true after", () => {
    const { result } = renderHook(() =>
      useHydration({
        cardData: mockCardData,
        draftStats: mockDraftStats,
        completedDraftIds: ["d1"],
      }),
    );

    // After mount, useEffect fires synchronously in act — hydrated should be true
    expect(result.current).toBe(true);
  });

  it("uses initialDraftId when provided", () => {
    renderHook(() =>
      useHydration({
        cardData: mockCardData,
        draftStats: mockDraftStats,
        completedDraftIds: ["d1"],
        initialDraftId: "d1",
      }),
    );

    expect(useDraftStore.getState().activeDraft).toBe("d1");
  });

  it("reads activeDraft from localStorage when initialDraftId is not provided", () => {
    localStorage.setItem("activeDraft", "d2");

    renderHook(() =>
      useHydration({
        cardData: mockCardData,
        draftStats: mockDraftStats,
        completedDraftIds: ["d1", "d2"],
      }),
    );

    expect(useDraftStore.getState().activeDraft).toBe("d2");
  });

  it("only runs once (idempotent) even if props change", () => {
    const hydrateCardSpy = vi.spyOn(useCardStore.getState(), "hydrate");
    const hydrateDraftSpy = vi.spyOn(useDraftStore.getState(), "hydrate");

    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useHydration({
          cardData: mockCardData,
          draftStats: mockDraftStats,
          completedDraftIds: ids,
        }),
      { initialProps: { ids: ["d1"] } },
    );

    act(() => {
      rerender({ ids: ["d1", "d2"] });
    });

    // Both hydrate methods should only have been called once despite rerender
    expect(hydrateCardSpy).toHaveBeenCalledTimes(1);
    expect(hydrateDraftSpy).toHaveBeenCalledTimes(1);

    hydrateCardSpy.mockRestore();
    hydrateDraftSpy.mockRestore();
  });
});
