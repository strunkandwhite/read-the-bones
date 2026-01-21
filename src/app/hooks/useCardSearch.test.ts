// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCardSearch } from "./useCardSearch";
import type { EnrichedCardStats, ScryCard } from "@/core/types";

vi.mock("@/core/localSearch", () => ({
  searchLocalCards: vi.fn((_query: string, _cards: ScryCard[]) => [
    { name: "Lightning Bolt" } as ScryCard,
  ]),
}));

function makeCard(name: string): EnrichedCardStats {
  return {
    cardName: name,
    weightedGeomean: 1,
    totalPicks: 1,
    timesAvailable: 1,
    draftsPickedIn: 1,
    timesUnpicked: 0,
    maxCopiesInDraft: 1,
    colors: ["R"],
    scoreHistory: [],
    pickDistribution: [],
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
  };
}

describe("useCardSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const cards = [makeCard("Lightning Bolt"), makeCard("Counterspell")];

  it("initializes with empty state", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    expect(result.current.searchQuery).toBe("");
    expect(result.current.colorFilter).toEqual([]);
    expect(result.current.scryfallMatchNames).toBeNull();
  });

  it("clearSearch resets search state", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    act(() => {
      result.current.setSearchQuery("t:creature");
    });

    act(() => {
      result.current.clearSearch();
    });

    expect(result.current.searchQuery).toBe("");
    expect(result.current.scryfallMatchNames).toBeNull();
  });

  it("triggers structured search for Scryfall operators after debounce", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    act(() => {
      result.current.setSearchQuery("t:instant");
    });

    // Before debounce fires, no results yet
    expect(result.current.scryfallMatchNames).toBeNull();

    // Advance past the 500ms debounce
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current.scryfallMatchNames).not.toBeNull();
    expect(result.current.scryfallMatchNames!.has("Lightning Bolt")).toBe(true);
  });

  it("does NOT trigger structured search for plain text", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    act(() => {
      result.current.setSearchQuery("Lightning Bolt");
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    // Plain text queries skip Scryfall search
    expect(result.current.scryfallMatchNames).toBeNull();
  });

  it("updates color filter state", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    act(() => {
      result.current.setColorFilter(["R", "U"]);
    });

    expect(result.current.colorFilter).toEqual(["R", "U"]);
  });

  it("updates color filter mode", () => {
    const { result } = renderHook(() => useCardSearch({ cards }));

    expect(result.current.colorFilterMode).toBe("inclusive");

    act(() => {
      result.current.setColorFilterMode("exclusive");
    });

    expect(result.current.colorFilterMode).toBe("exclusive");
  });
});
