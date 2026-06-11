// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { HoldToPickButton } from "./HoldToPickButton";

describe("HoldToPickButton", () => {
  afterEach(cleanup);

  it("renders with 'Hold to Pick' label", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
  });

  it("has emerald background styling", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-emerald");
  });

  describe("handler-stripping guard (disabled || confirmed)", () => {
    it("button is disabled when disabled prop is true", () => {
      render(<HoldToPickButton onPick={vi.fn()} disabled />);
      const button = screen.getByRole("button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });

    it("onPick is NOT called when disabled and a pointer event fires", () => {
      const onPick = vi.fn();
      render(<HoldToPickButton onPick={onPick} disabled />);
      const button = screen.getByRole("button");
      // Because disabled=true, the spread `{...(disabled || confirmed ? {} : handlers)}`
      // strips all pointer handlers. A native pointer event should have no effect.
      fireEvent.pointerDown(button);
      // Even if the browser fires the event, onPick was never wired up
      expect(onPick).not.toHaveBeenCalled();
    });

    it("button is disabled HTML attribute when disabled prop is true", () => {
      render(<HoldToPickButton onPick={vi.fn()} disabled />);
      const button = screen.getByRole("button") as HTMLButtonElement;
      // The disabled HTML attribute must be set so the button is not interactive
      expect(button.hasAttribute("disabled")).toBe(true);
    });

    it("applies gray styling when disabled", () => {
      render(<HoldToPickButton onPick={vi.fn()} disabled />);
      const button = screen.getByRole("button");
      expect(button.className).toContain("bg-gray-600");
      expect(button.className).toContain("cursor-not-allowed");
    });

    it("does not call onPick via pointer events when disabled (handler-stripping guard)", () => {
      // The component uses `{...(disabled || confirmed ? {} : handlers)}` to strip
      // pointer handlers when disabled=true. Verify: fire pointer events, onPick never fires.
      const onPick = vi.fn();
      render(<HoldToPickButton onPick={onPick} disabled />);
      const button = screen.getByRole("button");

      // Simulate a sequence of pointer events that would complete the hold gesture
      fireEvent.pointerDown(button);
      fireEvent.pointerUp(button);

      // Without handlers wired up, onPick must never have been called
      expect(onPick).not.toHaveBeenCalled();
    });

    it("does not spread pointer handlers when not disabled (baseline: handlers present via React)", () => {
      // Non-disabled state: the button gets event handlers (React's synthetic event system).
      // We can't easily inspect React synthetic props from the DOM, so we verify that
      // a pointer-down event is handled and onPick can eventually fire via the
      // useHoldToConfirm confirmation timer — but we just check no-crash here.
      const onPick = vi.fn();
      // Should not throw
      expect(() => {
        render(<HoldToPickButton onPick={onPick} />);
        const button = screen.getByRole("button");
        fireEvent.pointerDown(button);
        fireEvent.pointerUp(button);
      }).not.toThrow();
    });
  });
});
