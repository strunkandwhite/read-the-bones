// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModalManagement } from "./useModalManagement";
import { useLiveStore, _resetDeckState } from "../stores/liveStore";

describe("useModalManagement", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    _resetDeckState();
    useLiveStore.setState({ deckBuilderActive: false });
  });

  it("initializes with all modals closed", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(result.current.draftBoardOpen).toBe(false);
  });

  it("restores deck builder open state from localStorage", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    expect(useLiveStore.getState().deckBuilderActive).toBe(true);
    expect(result.current.deckBuilderModalOpen).toBe(true);
  });

  it("does not restore if no active draft", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: null, selectedSeat: null }),
    );

    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
    expect(result.current.deckBuilderModalOpen).toBe(false);
  });

  it("restores deck builder after hydration — activeDraft/selectedSeat start null then become non-null", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    // Simulate pre-hydration: no draft or seat yet
    const { result, rerender } = renderHook(
      (props) => useModalManagement(props),
      { initialProps: { activeDraft: null as string | null, selectedSeat: null as number | null } },
    );

    // Pre-hydration: modal must stay closed
    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(useLiveStore.getState().deckBuilderActive).toBe(false);

    // Simulate store hydration populating activeDraft and selectedSeat
    act(() => {
      rerender({ activeDraft: "draft-1", selectedSeat: 1 });
    });

    // Post-hydration: restore fires and opens the builder
    expect(result.current.deckBuilderModalOpen).toBe(true);
    expect(useLiveStore.getState().deckBuilderActive).toBe(true);
  });

  it("does not re-open deck builder after user closes it (once-guard)", () => {
    localStorage.setItem("deckBuilderOpen", "true");

    const { result, rerender } = renderHook(
      (props) => useModalManagement(props),
      { initialProps: { activeDraft: "draft-1" as string | null, selectedSeat: 1 as number | null } },
    );

    // Initial restore fires on mount (activeDraft/selectedSeat provided from the start)
    expect(result.current.deckBuilderModalOpen).toBe(true);

    // User closes the modal — this writes "false" to localStorage
    act(() => {
      result.current.setDeckBuilderModalOpen(false);
    });

    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(localStorage.getItem("deckBuilderOpen")).toBe("false");

    // A re-render with same activeDraft/selectedSeat must NOT re-open the builder
    rerender({ activeDraft: "draft-1", selectedSeat: 1 });

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
      useLiveStore.getState().setDeckBuilderActive(true);
      result.current.setDeckBuilderModalOpen(true);
    });

    expect(useLiveStore.getState().deckBuilderActive).toBe(true);

    rerender({ activeDraft: null, selectedSeat: null });

    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
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

  it("deactivates deckBuilderActive when modal is closed via setDeckBuilderModalOpen", () => {
    // deckBuilderActive gates the poll→rebuild loop; leaving it true after close
    // causes unnecessary syncDeckWithPicks churn on every poll.
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    // Open the modal, setting deckBuilderActive=true
    act(() => {
      useLiveStore.getState().setDeckBuilderActive(true);
      result.current.setDeckBuilderModalOpen(true);
    });
    expect(useLiveStore.getState().deckBuilderActive).toBe(true);

    // Close the modal — deckBuilderActive must be reset to false
    act(() => {
      result.current.setDeckBuilderModalOpen(false);
    });
    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
  });

  it("deactivates deckBuilderActive when modal is closed via Escape key", () => {
    const { result } = renderHook(() =>
      useModalManagement({ activeDraft: "draft-1", selectedSeat: 1 }),
    );

    act(() => {
      useLiveStore.getState().setDeckBuilderActive(true);
      result.current.setDeckBuilderModalOpen(true);
    });
    expect(useLiveStore.getState().deckBuilderActive).toBe(true);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(result.current.deckBuilderModalOpen).toBe(false);
    expect(useLiveStore.getState().deckBuilderActive).toBe(false);
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
