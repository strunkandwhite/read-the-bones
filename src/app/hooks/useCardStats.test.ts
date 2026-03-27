// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCardStats } from "./useCardStats";

describe("useCardStats", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null data when cardName is null", () => {
    const { result } = renderHook(() => useCardStats(null));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("fetches stats when cardName is set", async () => {
    const statsData = {
      pick: { drafts_in_pool: 5, times_picked: 3, avg_pick: 10, median_pick: 9, geomean_pick: 9.5 },
      pick_history: [],
      pick_distribution: [],
      times_banned: 0,
      color_pair_breakdown: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(statsData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() => useCardStats("Lightning Bolt"));

    await waitFor(() => expect(result.current.data).toEqual(statsData));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/cards/stats?card_name=Lightning+Bolt"),
    );
  });

  it("handles fetch error (non-ok response)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );

    const { result } = renderHook(() => useCardStats("Unknown Card"));

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("clears data when cardName changes to null", async () => {
    const statsData = {
      pick: { drafts_in_pool: 1, times_picked: 1, avg_pick: 5, median_pick: 5, geomean_pick: 5 },
      pick_history: [],
      pick_distribution: [],
      times_banned: 0,
      color_pair_breakdown: [],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(statsData), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result, rerender } = renderHook(
      ({ name }) => useCardStats(name),
      { initialProps: { name: "Lightning Bolt" as string | null } },
    );

    await waitFor(() => expect(result.current.data).toEqual(statsData));

    rerender({ name: null });

    await waitFor(() => expect(result.current.data).toBeNull());
  });

  it("passes draftId and excludeDraftId as query params", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        pick: { drafts_in_pool: 1, times_picked: 1, avg_pick: 5, median_pick: 5, geomean_pick: 5 },
        pick_history: [],
        pick_distribution: [],
        times_banned: 0,
        color_pair_breakdown: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    renderHook(() => useCardStats("Bolt", "draft-1", "draft-2"));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    const calledUrl = vi.mocked(globalThis.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain("draft_id=draft-1");
    expect(calledUrl).toContain("exclude_draft_id=draft-2");
  });
});
