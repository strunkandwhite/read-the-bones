// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModalManagement } from "./useModalManagement";

describe("useModalManagement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("initializes with all modals closed", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(result.current.draftBoardOpen).toBe(false);
  });

  it("restores deck builder open state from localStorage", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(result.current.deckBuilderActive).toBe(true);
    expect(result.current.deckBuilderModalOpen).toBe(true);
  });

  it("does not restore if no active draft", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: null, selectedSeat: null }),
    );

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("persists modal open state to localStorage", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDeckBuilderModalOpen(true);
    });

    expect(localStorage.getItem("deckBuilderOpen")).toBe("true");

    act(() => {
      result.current.setDeckBuilderModalOpen(false);
    });

    expect(localStorage.getItem("deckBuilderOpen")).toBe("false");
  });

  it("closes modals when draft is deselected", () => {
    const { result, rerender } = renderHook(
      (props) => useModalManagement(props),
      { initialProps: { activeDraft: "draft-1" as string | null, selectedSeat: 1 as number | null } },
    );

    act(() => {
      result.current.setDeckBuilderActive(true);
      result.current.setDeckBuilderModalOpen(true);
    });

    expect(result.current.deckBuilderActive).toBe(true);

    rerender({ activeDraft: null, selectedSeat: null });

    expect(result.current.deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("closes deck builder modal on Escape key", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDeckBuilderModalOpen(true);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("closes draft board modal on Escape key", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      result.current.setDraftBoardOpen(true);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.draftBoardOpen).toBe(false);
  });
});
