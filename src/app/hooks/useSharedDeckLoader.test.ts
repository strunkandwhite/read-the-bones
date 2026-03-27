// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSharedDeckLoader } from "./useSharedDeckLoader";

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

describe("useSharedDeckLoader", () => {
  const defaultProps = {
    setActiveDraft: vi.fn(),
    setSelectedSeat: vi.fn(),
    loadSnapshot: vi.fn(),
    setDeckBuilderActive: vi.fn(),
    setDeckBuilderModalOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    // Reset search params
    mockSearchParams.delete("deck");
    defaultProps.setActiveDraft = vi.fn();
    defaultProps.setSelectedSeat = vi.fn();
    defaultProps.loadSnapshot = vi.fn();
    defaultProps.setDeckBuilderActive = vi.fn();
    defaultProps.setDeckBuilderModalOpen = vi.fn();
  });

  it("does nothing when no deck param present", () => {
    vi.spyOn(globalThis, "fetch");
    renderHook(() => useSharedDeckLoader(defaultProps));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches shared deck and sets up draft context", async () => {
    mockSearchParams.set("deck", "abc123");

    const deckState = {
      draftId: "draft-1",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(deckState), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(defaultProps.setActiveDraft).toHaveBeenCalledWith("draft-1");
    });

    expect(defaultProps.setSelectedSeat).toHaveBeenCalledWith(3);
    expect(defaultProps.loadSnapshot).toHaveBeenCalledWith(deckState);
    expect(defaultProps.setDeckBuilderActive).toHaveBeenCalledWith(true);
    expect(defaultProps.setDeckBuilderModalOpen).toHaveBeenCalledWith(true);

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/deck/abc123");
  });

  it("logs error on fetch failure and does not set state", async () => {
    mockSearchParams.set("deck", "bad-id");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load shared deck"),
      );
    });

    expect(defaultProps.setActiveDraft).not.toHaveBeenCalled();
  });

  it("logs error on network failure", async () => {
    mockSearchParams.set("deck", "abc123");

    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Network"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useSharedDeckLoader(defaultProps));

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Failed to load shared deck:", expect.any(Error));
    });
  });
});
