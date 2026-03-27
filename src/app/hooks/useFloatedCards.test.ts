// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useFloatedCards } from "./useFloatedCards";

describe("useFloatedCards", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches floated cards on mount", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ cards: ["Lightning Bolt"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token"),
    );

    await waitFor(() => {
      expect(result.current.floatedCards).toEqual(["Lightning Bolt"]);
    });

    expect(fetch).toHaveBeenCalledWith("/api/drafts/draft-1/float", {
      headers: { "X-Seat-Token": "test-token" },
    });
  });

  it("provides addFloat that calls PUT and updates local state", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cards: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token"),
    );

    await waitFor(() => expect(result.current.floatedCards).toEqual([]));

    await act(async () => {
      await result.current.addFloat("Counterspell");
    });

    expect(result.current.floatedCards).toContain("Counterspell");
    expect(fetch).toHaveBeenCalledWith("/api/drafts/draft-1/float", {
      method: "PUT",
      headers: {
        "X-Seat-Token": "test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ card_name: "Counterspell" }),
    });
  });

  it("provides removeFloat that calls DELETE and updates local state", async () => {
    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cards: ["Bolt"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const { result } = renderHook(() =>
      useFloatedCards("draft-1", "test-token"),
    );

    await waitFor(() => expect(result.current.floatedCards).toEqual(["Bolt"]));

    await act(async () => {
      await result.current.removeFloat("Bolt");
    });

    expect(result.current.floatedCards).not.toContain("Bolt");
    expect(fetch).toHaveBeenCalledWith("/api/drafts/draft-1/float", {
      method: "DELETE",
      headers: {
        "X-Seat-Token": "test-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ card_name: "Bolt" }),
    });
  });
});
