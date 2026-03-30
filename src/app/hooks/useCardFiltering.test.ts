// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCardFiltering } from "./useCardFiltering";
import type { CardStatsResponse } from "@/core/getCards";
import type { EnrichedCardStats } from "@/core/types";

function makeCard(name: string): EnrichedCardStats {
  return {
    cardName: name,
    weightedGeomean: 1,
    timesAvailable: 1,
    draftsPickedIn: 1,
    maxCopiesInDraft: 1,
    colors: ["W"],
  };
}

function makeCardData(
  overrides: Partial<CardStatsResponse> = {}
): CardStatsResponse {
  return {
    cards: [
      makeCard("Lightning Bolt"),
      makeCard("Counterspell"),
      makeCard("Swords to Plowshares"),
    ],
    draftCount: 1,
    cubeCopies: {},
    draftMetadata: {},
    draftIds: ["draft-1"],
    completedDraftIds: ["draft-1"],
    ingestionHash: "abc",
    ...overrides,
  };
}

describe("useCardFiltering", () => {
  it("filters banned cards when activeDraft is set", () => {
    const cardData = makeCardData({
      bannedCardNames: ["Counterspell"],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    expect(names).toContain("Lightning Bolt");
    expect(names).not.toContain("Counterspell");
    expect(names).toContain("Swords to Plowshares");
  });

  it("does NOT filter banned cards when no activeDraft", () => {
    const cardData = makeCardData({
      bannedCardNames: ["Counterspell"],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: null,
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    expect(result.current.displayCards).toHaveLength(3);
  });

  it("filters taken cards when hideTaken is true", () => {
    const cardData = makeCardData({
      takenCards: [{ name: "Lightning Bolt", seat: 1 }],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: true,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    expect(names).not.toContain("Lightning Bolt");
    expect(names).toContain("Counterspell");
  });

  it("does NOT filter taken cards when hideTaken is false", () => {
    const cardData = makeCardData({
      takenCards: [{ name: "Lightning Bolt", seat: 1 }],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    expect(names).toContain("Lightning Bolt");
  });

  it("filters searchFilteredCards by scryfallMatchNames", () => {
    const cardData = makeCardData();
    const matchNames = new Set(["Lightning Bolt"]);

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: null,
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "t:instant",
        scryfallMatchNames: matchNames,
      })
    );

    expect(result.current.searchFilteredCards).toHaveLength(1);
    expect(result.current.searchFilteredCards[0].cardName).toBe(
      "Lightning Bolt"
    );
  });

  it("filters searchFilteredCards by plain text name when no scryfallMatchNames", () => {
    const cardData = makeCardData();

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: null,
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "bolt",
        scryfallMatchNames: null,
      })
    );

    expect(result.current.searchFilteredCards).toHaveLength(1);
    expect(result.current.searchFilteredCards[0].cardName).toBe(
      "Lightning Bolt"
    );
  });

  it("returns all displayCards when no search query and no scryfallMatchNames", () => {
    const cardData = makeCardData();

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: null,
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    expect(result.current.searchFilteredCards).toHaveLength(3);
  });

  it("does NOT hide selected seat's cards when hideTaken is true", () => {
    const cardData = makeCardData({
      takenCards: [
        { name: "Lightning Bolt", seat: 1 },
        { name: "Counterspell", seat: 2 },
      ],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: true,
        selectedSeat: 1,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    expect(names).toContain("Lightning Bolt"); // seat 1's pick, kept
    expect(names).not.toContain("Counterspell"); // seat 2's pick, hidden
    expect(names).toContain("Swords to Plowshares"); // available
  });

  it("returns seatCardNames for selected seat", () => {
    const cardData = makeCardData({
      takenCards: [
        { name: "Lightning Bolt", seat: 1 },
        { name: "Counterspell", seat: 2 },
      ],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: false,
        selectedSeat: 1,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    expect(result.current.seatCardNames).toBeDefined();
    expect(result.current.seatCardNames!.has("Lightning Bolt")).toBe(true);
    expect(result.current.seatCardNames!.has("Counterspell")).toBe(false);
  });

  it("returns undefined seatCardNames when no seat selected", () => {
    const cardData = makeCardData({
      takenCards: [{ name: "Lightning Bolt", seat: 1 }],
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: false,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    expect(result.current.seatCardNames).toBeUndefined();
  });

  it("does not treat partially-taken multi-copy card as taken", () => {
    const cardData = makeCardData({
      takenCards: [{ name: "Lightning Bolt", seat: 1 }],
      cubeCopies: { "Lightning Bolt": 2 },
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: true,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    // 2 copies, only 1 taken — should still be visible
    expect(names).toContain("Lightning Bolt");
    // Should NOT be in takenCardNamesSet
    expect(result.current.takenCardNamesSet?.has("Lightning Bolt")).toBe(false);
  });

  it("treats fully-taken multi-copy card as taken", () => {
    const cardData = makeCardData({
      takenCards: [
        { name: "Lightning Bolt", seat: 1 },
        { name: "Lightning Bolt", seat: 2 },
      ],
      cubeCopies: { "Lightning Bolt": 2 },
    });

    const { result } = renderHook(() =>
      useCardFiltering({
        cardData,
        activeDraft: "draft-1",
        hideTaken: true,
        selectedSeat: null,
        searchQuery: "",
        scryfallMatchNames: null,
      })
    );

    const names = result.current.displayCards.map((c) => c.cardName);
    // 2 copies, 2 taken — should be hidden
    expect(names).not.toContain("Lightning Bolt");
    // Should be in takenCardNamesSet
    expect(result.current.takenCardNamesSet?.has("Lightning Bolt")).toBe(true);
  });
});
