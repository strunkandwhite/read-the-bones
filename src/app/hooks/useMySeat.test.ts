// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useMySeat } from "./useMySeat";

describe("useMySeat", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null seat when no draftId", () => {
    const { result } = renderHook(() => useMySeat(null, null));
    expect(result.current.mySeat).toBeNull();
    expect(result.current.displayName).toBeNull();
  });

  it("returns null seat when no token", () => {
    const { result } = renderHook(() => useMySeat("test-draft", null));
    expect(result.current.mySeat).toBeNull();
  });

  it("fetches seat from /me endpoint", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seat: 3, autoPick: true, displayName: "Alice" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(3));
    expect(result.current.autoPick).toBe(true);
    expect(result.current.displayName).toBe("Alice");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/me",
      expect.objectContaining({
        headers: { "X-Seat-Token": "my-token" },
      }),
    );
  });

  it("stays null on failed fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid" }), { status: 401 }),
    );

    const { result } = renderHook(() => useMySeat("test-draft", "bad-token"));

    // Give it time to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.mySeat).toBeNull();
  });

  it("stays null on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await new Promise((r) => setTimeout(r, 50));
    expect(result.current.mySeat).toBeNull();
  });

  it("toggleAutoPick sends PUT and updates state", async () => {
    // Initial fetch
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      // toggleAutoPick response
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(1));
    expect(result.current.autoPick).toBe(true);

    await act(async () => {
      await result.current.toggleAutoPick();
    });

    expect(result.current.autoPick).toBe(false);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ auto_pick: false }),
      }),
    );
  });

  it("toggleAutoPick does not update state on failed PUT", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "fail" }), { status: 500 }),
      );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(1));

    await act(async () => {
      await result.current.toggleAutoPick();
    });

    // Should remain true since the PUT failed
    expect(result.current.autoPick).toBe(true);
  });

  it("updateDisplayName sends PUT and updates state", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(1));
    expect(result.current.displayName).toBe("Bob");

    await act(async () => {
      await result.current.updateDisplayName("Alice");
    });

    expect(result.current.displayName).toBe("Alice");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ display_name: "Alice" }),
      }),
    );
  });

  it("updateDisplayName does not update state on failed PUT", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "fail" }), { status: 500 }),
      );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(1));

    await act(async () => {
      await result.current.updateDisplayName("Alice");
    });

    expect(result.current.displayName).toBe("Bob");
  });

  it("updateDisplayName clears name when given empty string", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ seat: 1, autoPick: true, displayName: "Bob" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const { result } = renderHook(() => useMySeat("test-draft", "my-token"));

    await waitFor(() => expect(result.current.mySeat).toBe(1));

    await act(async () => {
      await result.current.updateDisplayName("");
    });

    expect(result.current.displayName).toBeNull();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/drafts/test-draft/seat-settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ display_name: "" }),
      }),
    );
  });
});
