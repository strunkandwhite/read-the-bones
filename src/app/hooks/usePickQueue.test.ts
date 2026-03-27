// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePickQueue } from "./usePickQueue";

function makeQueueResponse(queue: Array<{ priority: number; cardId: number; cardName: string }>) {
  return new Response(JSON.stringify({ queue }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("usePickQueue", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty queue when no draftId", () => {
    const { result } = renderHook(() => usePickQueue(null, null, 0));
    expect(result.current.queue).toEqual([]);
    expect(result.current.queuedCards.size).toBe(0);
    expect(result.current.isLoading).toBe(false);
  });

  it("returns empty queue when no token", () => {
    const { result } = renderHook(() => usePickQueue("draft-1", null, 0));
    expect(result.current.queue).toEqual([]);
  });

  it("fetches queue on mount", async () => {
    const queueData = [
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeQueueResponse(queueData));

    const { result } = renderHook(() => usePickQueue("draft-1", "token-1", 0));

    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    expect(result.current.queue[0].cardName).toBe("Lightning Bolt");
    expect(result.current.queue[1].cardName).toBe("Counterspell");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/draft-1/queue",
      expect.objectContaining({
        headers: { "X-Seat-Token": "token-1" },
      }),
    );
  });

  it("builds queuedCards map from queue data", async () => {
    const queueData = [
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(makeQueueResponse(queueData));

    const { result } = renderHook(() => usePickQueue("draft-1", "token-1", 0));

    await waitFor(() => expect(result.current.queuedCards.size).toBe(2));
    expect(result.current.queuedCards.get("Lightning Bolt")).toBe(1);
    expect(result.current.queuedCards.get("Counterspell")).toBe(2);
  });

  it("addToQueue sends PUT with updated card list", async () => {
    const initialQueue = [{ priority: 1, cardId: 10, cardName: "Lightning Bolt" }];
    const updatedQueue = [
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ];

    vi.spyOn(globalThis, "fetch")
      // Initial fetch
      .mockResolvedValueOnce(makeQueueResponse(initialQueue))
      // PUT from addToQueue
      .mockResolvedValueOnce(makeQueueResponse(updatedQueue));

    const { result } = renderHook(() => usePickQueue("draft-1", "token-1", 0));

    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    await act(async () => {
      result.current.addToQueue("Counterspell");
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    // Verify the PUT call
    const putCall = vi.mocked(globalThis.fetch).mock.calls[1];
    expect(putCall[0]).toBe("/api/drafts/draft-1/queue");
    expect(putCall[1]).toMatchObject({
      method: "PUT",
      headers: { "X-Seat-Token": "token-1", "Content-Type": "application/json" },
    });
    const body = JSON.parse(putCall[1]!.body as string);
    expect(body).toEqual([
      { card_name: "Lightning Bolt" },
      { card_name: "Counterspell" },
    ]);
  });

  it("removeFromQueue sends PUT without the removed card", async () => {
    const initialQueue = [
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ];
    const updatedQueue = [{ priority: 1, cardId: 20, cardName: "Counterspell" }];

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeQueueResponse(initialQueue))
      .mockResolvedValueOnce(makeQueueResponse(updatedQueue));

    const { result } = renderHook(() => usePickQueue("draft-1", "token-1", 0));

    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    await act(async () => {
      result.current.removeFromQueue("Lightning Bolt");
    });

    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    expect(result.current.queue[0].cardName).toBe("Counterspell");

    const putCall = vi.mocked(globalThis.fetch).mock.calls[1];
    const body = JSON.parse(putCall[1]!.body as string);
    expect(body).toEqual([{ card_name: "Counterspell" }]);
  });

  it("refetches queue when dataChanged increments", async () => {
    const queue1 = [{ priority: 1, cardId: 10, cardName: "Lightning Bolt" }];
    const queue2 = [
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 30, cardName: "Dark Ritual" },
    ];

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeQueueResponse(queue1))
      .mockResolvedValueOnce(makeQueueResponse(queue2));

    const { result, rerender } = renderHook(
      ({ dataChanged }) => usePickQueue("draft-1", "token-1", dataChanged),
      { initialProps: { dataChanged: 0 } },
    );

    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    rerender({ dataChanged: 1 });

    await waitFor(() => expect(result.current.queue).toHaveLength(2));
  });

  it("handles failed fetch gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "fail" }), { status: 500 }),
    );

    const { result } = renderHook(() => usePickQueue("draft-1", "token-1", 0));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(result.current.queue).toEqual([]);
  });
});
