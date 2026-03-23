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

    expect(result.current.state.zones.deck["mv-0-1"]).toContain(
      "Card A",
    );
    expect(result.current.state.zones.deck["mv-3"]).toContain("Card B");
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
    expect(parsed.zones.deck["mv-0-1"]).toContain("Card A");
  });

  it("hydrates from localStorage on mount", () => {
    const savedState = {
      draftId: "tarkir",
      seat: 1,
      zones: {
        deck: {
          "mv-0-1": ["Card A"],
          "mv-2": [],
          "mv-3": [],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
          lands: [],
        },
        sideboard: {
          "mv-0-1": [],
          "mv-2": [],
          "mv-3": [],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
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

    expect(result.current.state.zones.deck["mv-0-1"]).toContain("Card A");
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
    expect(result.current.state.zones.sideboard["mv-0-1"]).toEqual([]);
  });

  it("loadSnapshot survives draft/seat prop change without being overwritten", () => {
    // Simulate: user is on draft A, then loads a shared deck from draft B.
    // The shared deck snapshot must survive the draft/seat prop change.
    const sharedDeck = {
      draftId: "terminate",
      seat: 7,
      zones: {
        deck: {
          "mv-0-1": ["Card A"],
          "mv-2": [],
          "mv-3": ["Card B"],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
          lands: [],
        },
        sideboard: {
          "mv-0-1": [],
          "mv-2": [],
          "mv-3": [],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
          lands: [],
        },
      },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };

    // Start on a different draft
    const { result, rerender } = renderHook(
      ({ draftId, seat }) => useDeckBuilder({ draftId, seat }),
      { initialProps: { draftId: "maelstrom-pulse", seat: 3 } },
    );

    // Load the shared deck snapshot (before props change)
    act(() => {
      result.current.loadSnapshot(sharedDeck);
    });

    // Props change to match the shared deck's draft/seat
    rerender({ draftId: "terminate", seat: 7 });

    // The shared deck must not be overwritten by localStorage or empty state
    expect(result.current.state.draftId).toBe("terminate");
    expect(result.current.state.seat).toBe(7);
    expect(result.current.state.zones.deck["mv-0-1"]).toEqual(["Card A"]);
    expect(result.current.state.zones.deck["mv-3"]).toEqual(["Card B"]);
  });

  it("loadSnapshot overwrites stale localStorage for the target draft/seat", () => {
    // Simulate corrupted localStorage from a prior session
    const staleState = {
      draftId: "terminate",
      seat: 7,
      zones: {
        deck: {
          "mv-0-1": ["Stale Card"],
          "mv-2": [],
          "mv-3": [],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
          lands: [],
        },
        sideboard: {
          "mv-0-1": [],
          "mv-2": [],
          "mv-3": [],
          "mv-4": [],
          "mv-5": [],
          "mv-6+": [],
          lands: [],
        },
      },
      speculativeCards: [],
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };
    localStorage.setItem("deckState:terminate:7", JSON.stringify(staleState));

    const sharedDeck = { ...staleState, zones: {
      ...staleState.zones,
      deck: { ...staleState.zones.deck, "mv-0-1": ["Card A"] },
    }};

    const { result, rerender } = renderHook(
      ({ draftId, seat }) => useDeckBuilder({ draftId, seat }),
      { initialProps: { draftId: "maelstrom-pulse", seat: 3 } },
    );

    act(() => {
      result.current.loadSnapshot(sharedDeck);
    });

    rerender({ draftId: "terminate", seat: 7 });

    // Should show the shared deck, not the stale localStorage data
    expect(result.current.state.zones.deck["mv-0-1"]).toEqual(["Card A"]);
    expect(result.current.state.zones.deck["mv-0-1"]).not.toContain("Stale Card");
  });
});
