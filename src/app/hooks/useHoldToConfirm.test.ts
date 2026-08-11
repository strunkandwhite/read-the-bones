// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHoldToConfirm } from "./useHoldToConfirm";

describe("useHoldToConfirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onConfirm after holding for the full duration", async () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    await act(async () => {
      result.current.handlers.onPointerDown({} as PointerEvent);
    });
    expect(result.current.progress).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("resets on early release", async () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    await act(async () => {
      result.current.handlers.onPointerDown({} as PointerEvent);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      result.current.handlers.onPointerUp();
    });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(result.current.isHolding).toBe(false);
  });

  it("exposes progress advancing from 0 toward 1 while holding", async () => {
    const onConfirm = vi.fn();
    const { result } = renderHook(() => useHoldToConfirm({ onConfirm, duration: 1500 }));

    await act(async () => {
      result.current.handlers.onPointerDown({} as PointerEvent);
    });
    expect(result.current.progress).toBe(0);

    await act(async () => {
      vi.advanceTimersByTime(750);
    });
    // After half the duration, progress should be between 0 and 1
    expect(result.current.progress).toBeGreaterThan(0);
    expect(result.current.progress).toBeLessThan(1);
    expect(result.current.isHolding).toBe(true);
  });
});
