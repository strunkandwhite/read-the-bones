// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDraftSelection } from "./useDraftSelection";

describe("useDraftSelection", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes selectedDrafts from completedDraftIds", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: ["draft-a", "draft-b"] })
    );
    expect(result.current.selectedDrafts).toEqual(
      new Set(["draft-a", "draft-b"])
    );
  });

  it("initializes activeDraft as null, hideTaken as true", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );
    expect(result.current.activeDraft).toBeNull();
    expect(result.current.hideTaken).toBe(true);
  });

  it("sets hydrated to true after mount", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );
    // After the initial render + useEffect, hydrated should be true
    expect(result.current.hydrated).toBe(true);
  });

  it("hydrates activeDraft from localStorage", () => {
    localStorage.setItem("activeDraft", "stored-draft");

    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );
    expect(result.current.activeDraft).toBe("stored-draft");
  });

  it("hydrates hideTaken=false from localStorage", () => {
    localStorage.setItem("hideTaken", "false");

    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );
    expect(result.current.hideTaken).toBe(false);
  });

  it("persists activeDraft to localStorage after hydration", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    act(() => {
      result.current.setActiveDraft("new-draft");
    });

    expect(localStorage.getItem("activeDraft")).toBe("new-draft");
  });

  it("removes activeDraft from localStorage when set to null", () => {
    localStorage.setItem("activeDraft", "old-draft");

    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    act(() => {
      result.current.setActiveDraft(null);
    });

    expect(localStorage.getItem("activeDraft")).toBeNull();
  });

  it("persists hideTaken to localStorage after hydration", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    act(() => {
      result.current.setHideTaken(false);
    });

    expect(localStorage.getItem("hideTaken")).toBe("false");
  });

  it("initializes selectedSeat as null", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );
    expect(result.current.selectedSeat).toBeNull();
  });

  it("persists selectedSeat per draft in localStorage", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    act(() => {
      result.current.setActiveDraft("tarkir");
    });
    act(() => {
      result.current.setSelectedSeat(3);
    });

    const stored = JSON.parse(localStorage.getItem("selectedSeats")!);
    expect(stored).toEqual({ tarkir: 3 });
  });

  it("restores selectedSeat when switching back to a draft", () => {
    localStorage.setItem("selectedSeats", JSON.stringify({ tarkir: 5 }));
    localStorage.setItem("activeDraft", "tarkir");

    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    expect(result.current.selectedSeat).toBe(5);
  });

  it("clears selectedSeat when activeDraft is cleared", () => {
    const { result } = renderHook(() =>
      useDraftSelection({ completedDraftIds: [] })
    );

    act(() => {
      result.current.setActiveDraft("tarkir");
    });
    act(() => {
      result.current.setSelectedSeat(3);
    });
    act(() => {
      result.current.setActiveDraft(null);
    });

    expect(result.current.selectedSeat).toBeNull();
  });
});
