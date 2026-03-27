// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useDeckBuilder } from "./useDeckBuilder";
import type { DeckState, ScryCard } from "@/core/types";

// Mock global fetch
const mockFetch = vi.fn() as Mock;
global.fetch = mockFetch;

const scryfallData = new Map<string, ScryCard>([
  ["Card A", { manaValue: 1, typeLine: "Creature" } as ScryCard],
  ["Card B", { manaValue: 3, typeLine: "Instant" } as ScryCard],
]);

const savedState: DeckState = {
  draftId: "tarkir",
  seat: 1,
  zones: {
    deck: { "mv-0-1": ["Card A"], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
    sideboard: { "mv-0-1": [], "mv-2": [], "mv-3": [], "mv-4": [], "mv-5": [], "mv-6+": [], lands: [] },
  },
  basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
};

describe("useDeckBuilder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("initializes with empty state before API fetch resolves", () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    expect(result.current.state.draftId).toBe("tarkir");
    expect(result.current.ready).toBe(false);
  });

  it("hydrates from API on mount and sets ready", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.state.zones.deck["mv-0-1"]).toEqual(["Card A"]);
  });

  it("sets ready=true on 404 (no saved WIP)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(Object.values(result.current.state.zones.deck).flat()).toHaveLength(0);
  });

  it("does not fetch when token is null", () => {
    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: null }),
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it("debounces saves to PUT endpoint", async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 404 }) // initial GET
      .mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }); // PUTs

    const { result } = renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    act(() => {
      result.current.dispatch({
        type: "INIT_FROM_PICKS",
        picks: ["Card A"],
        scryfallData,
        draftId: "tarkir",
        seat: 1,
      });
    });

    // No PUT yet (debounce not elapsed)
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the GET

    // Advance past debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });

    // Now the PUT should have fired
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const putCall = mockFetch.mock.calls[1];
    expect(putCall[0]).toContain("/deck-state");
    expect(putCall[1].method).toBe("PUT");

    vi.useRealTimers();
  });

  it("does not save when state has not changed", async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });

    renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    // No actions dispatched, advance past debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });

    // Only the initial GET, no PUT
    expect(mockFetch).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not touch localStorage", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => savedState,
    });
    renderHook(() =>
      useDeckBuilder({ draftId: "tarkir", seat: 1, token: "tok" }),
    );
    await waitFor(() => {});
    expect(localStorage.getItem("deckState:tarkir:1")).toBeNull();
  });
});
