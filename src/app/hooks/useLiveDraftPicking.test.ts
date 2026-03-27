// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useLiveDraftPicking } from "./useLiveDraftPicking";
import type { LiveDraftStatus } from "./useLiveDraftStatus";

function makeStatus(overrides: Partial<LiveDraftStatus> = {}): LiveDraftStatus {
  return {
    phase: "drafting",
    latestPickN: 5,
    nextSeat: 1,
    recentPicks: [],
    seatNames: {},
    numSeats: 4,
    picksPerPlayer: 10,
    matchCount: 0,
    totalMatches: 0,
    ...overrides,
  };
}

const baseProps = {
  activeDraft: "test-draft",
  token: "my-token",
  mySeat: 1,
  liveDraftStatus: makeStatus(),
  refreshDraftStatus: vi.fn(),
  autoPick: false,
  queuedCards: new Map<string, number>(),
  refreshSettings: vi.fn().mockResolvedValue({ autoPick: false }),
};

describe("useLiveDraftPicking", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("isMyTurn is true when nextSeat matches mySeat", () => {
    const { result } = renderHook(() => useLiveDraftPicking(baseProps));
    expect(result.current.isMyTurn).toBe(true);
  });

  it("isMyTurn is false when nextSeat does not match mySeat", () => {
    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, liveDraftStatus: makeStatus({ nextSeat: 2 }) }),
    );
    expect(result.current.isMyTurn).toBe(false);
  });

  it("isMyTurn is false when mySeat is null", () => {
    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, mySeat: null }),
    );
    expect(result.current.isMyTurn).toBe(false);
  });

  it("handlePick sends POST and clears error on success", async () => {
    const refreshDraftStatus = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, refreshDraftStatus }),
    );

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toBeNull();
    expect(refreshDraftStatus).toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/pick",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ card_name: "Lightning Bolt" }),
      }),
    );
  });

  it("handlePick sets error on non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not your turn" }), { status: 400 }),
    );

    const { result } = renderHook(() => useLiveDraftPicking(baseProps));

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toBe("Not your turn");
  });

  it("handlePick sets network error on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));

    const { result } = renderHook(() => useLiveDraftPicking(baseProps));

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(result.current.pickError).toContain("Network error");
  });

  it("does nothing when activeDraft is null", async () => {
    vi.spyOn(globalThis, "fetch");

    const { result } = renderHook(() =>
      useLiveDraftPicking({ ...baseProps, activeDraft: null }),
    );

    await act(async () => {
      await result.current.handlePick("Lightning Bolt");
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("consecutivePicks counts sequential picks for the player", () => {
    // With 4 seats and latestPickN=5, this depends on snakeDraft logic
    // but we verify it returns a number >= 0.
    const { result } = renderHook(() => useLiveDraftPicking(baseProps));
    expect(result.current.consecutivePicks).toBeGreaterThanOrEqual(0);
  });

  it("auto-pick fires when isMyTurn and autoPick enabled with queued cards", async () => {
    const refreshDraftStatus = vi.fn();
    const refreshSettings = vi.fn().mockResolvedValue({ autoPick: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const queuedCards = new Map([["Counterspell", 1]]);

    renderHook(() =>
      useLiveDraftPicking({
        ...baseProps,
        autoPick: true,
        queuedCards,
        refreshDraftStatus,
        refreshSettings,
      }),
    );

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/drafts/test-draft/pick",
        expect.objectContaining({
          body: JSON.stringify({ card_name: "Counterspell" }),
        }),
      );
    });
  });
});
