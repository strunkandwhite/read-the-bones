// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeckBuilder } from "./useDeckBuilder";
import type { ScryCard } from "@/core/types";

const scryfallData = new Map<string, ScryCard>([
  ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
  ["Card B", { manaValue: 3, typeLine: "Instant" } as ScryCard],
]);

describe("useDeckBuilder", () => {
  beforeEach(() => localStorage.clear());

  it("initializes with empty state", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 }),
    );
    expect(result.current.state.draftId).toBe("tarkir");
    expect(result.current.state.seat).toBe(1);
  });

  it("initializes from picks", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 }),
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        picks: ["Card A", "Card B"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
    });

    expect(result.current.state.zones.deck["cmc-0-1"]).toContain(
      "Card A",
    );
    expect(result.current.state.zones.deck["cmc-3"]).toContain("Card B");
  });

  it("persists state to localStorage", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 }),
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        picks: ["Card A"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
    });

    const stored = localStorage.getItem("deckState:tarkir:1");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.zones.deck["cmc-0-1"]).toContain("Card A");
  });

  it("hydrates from localStorage on mount", () => {
    const savedState = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: {
          "cmc-0-1": ["Card A"],
          "cmc-2": [],
          "cmc-3": [],
          "cmc-4": [],
          "cmc-5": [],
          "cmc-6+": [],
          lands: [],
        },
        sideboard: {
          "cmc-0-1": [],
          "cmc-2": [],
          "cmc-3": [],
          "cmc-4": [],
          "cmc-5": [],
          "cmc-6+": [],
          lands: [],
        },
      },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };
    localStorage.setItem("deckState:tarkir:1", JSON.stringify(savedState));

    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1 }),
    );

    expect(result.current.state.zones.deck["cmc-0-1"]).toContain("Card A");
  });

  it("resets state when draft/seat changes", () => {
    const { result, rerender } = renderHook(
      ({ draftId, seat }) => useDeckBuilder({ draftId, seat }),
      { initialProps: { draftId: "tarkir", seat: 1 } },
    );

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        picks: ["Card A"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
    });

    rerender({ draftId: "dominaria", seat: 2 });

    expect(result.current.state.draftId).toBe("dominaria");
    expect(result.current.state.zones.sideboard["cmc-0-1"]).toEqual([]);
  });
});
