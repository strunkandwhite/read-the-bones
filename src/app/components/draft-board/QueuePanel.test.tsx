// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueuePanel } from "./QueuePanel";

describe("QueuePanel", () => {
  const defaultProps = {
    queue: [
      { cardName: "Lightning Bolt", position: 1 },
      { cardName: "Counterspell", position: 2 },
    ],
    autoPick: true,
    autoPickMode: "resilient" as const,
    onReorder: vi.fn(),
    onRemove: vi.fn(),
    onToggleAutoPick: vi.fn(),
    onChangeAutoPickMode: vi.fn(),
  };

  afterEach(() => {
    cleanup();
  });

  it("renders queued cards in order", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText("Lightning Bolt")).toBeTruthy();
    expect(screen.getByText("Counterspell")).toBeTruthy();
  });

  it("shows auto-pick toggle", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText(/Auto-pick/i)).toBeTruthy();
  });

  it("shows mode selector when auto-pick is on", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText(/Resilient/i)).toBeTruthy();
    expect(screen.getByText(/Cautious/i)).toBeTruthy();
  });

  it("hides mode selector when auto-pick is off", () => {
    render(<QueuePanel {...defaultProps} autoPick={false} />);
    expect(screen.queryByText(/Resilient/i)).toBeNull();
  });

  it("shows empty state when queue is empty", () => {
    render(<QueuePanel {...defaultProps} queue={[]} />);
    expect(screen.getByText(/empty/i)).toBeTruthy();
  });

  it("calls onRemove when remove button is clicked", () => {
    const onRemove = vi.fn();
    render(<QueuePanel {...defaultProps} onRemove={onRemove} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("Lightning Bolt");
  });

  it("calls onReorder when up button is clicked", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} onReorder={onReorder} />);
    // Click up on Counterspell (second item) — should move it before Lightning Bolt
    const upButtons = screen.getAllByRole("button", { name: /move up/i });
    fireEvent.click(upButtons[1]); // second item's up button
    expect(onReorder).toHaveBeenCalledWith(["Counterspell", "Lightning Bolt"]);
  });

  it("calls onReorder when down button is clicked", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} onReorder={onReorder} />);
    // Click down on Lightning Bolt (first item) — should move it after Counterspell
    const downButtons = screen.getAllByRole("button", { name: /move down/i });
    fireEvent.click(downButtons[0]); // first item's down button
    expect(onReorder).toHaveBeenCalledWith(["Counterspell", "Lightning Bolt"]);
  });

  it("calls onToggleAutoPick when toggle is clicked", () => {
    const onToggleAutoPick = vi.fn();
    render(<QueuePanel {...defaultProps} onToggleAutoPick={onToggleAutoPick} />);
    const toggle = screen.getByRole("checkbox");
    fireEvent.click(toggle);
    expect(onToggleAutoPick).toHaveBeenCalled();
  });

  it("calls onChangeAutoPickMode when mode button is clicked", () => {
    const onChangeAutoPickMode = vi.fn();
    render(
      <QueuePanel
        {...defaultProps}
        autoPickMode="resilient"
        onChangeAutoPickMode={onChangeAutoPickMode}
      />,
    );
    fireEvent.click(screen.getByText(/Cautious/i));
    expect(onChangeAutoPickMode).toHaveBeenCalledWith("cautious");
  });

  it("renders taken cards with strike-through styling", () => {
    render(
      <QueuePanel
        {...defaultProps}
        queue={[
          { cardName: "Lightning Bolt", position: 1, taken: true },
          { cardName: "Counterspell", position: 2 },
        ]}
      />,
    );
    const bolt = screen.getByText("Lightning Bolt");
    expect(bolt.style.textDecoration).toContain("line-through");
  });

  it("disables up button for first item", () => {
    render(<QueuePanel {...defaultProps} />);
    const upButtons = screen.getAllByRole("button", { name: /move up/i });
    expect(upButtons[0]).toBeInstanceOf(HTMLButtonElement);
    expect((upButtons[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables down button for last item", () => {
    render(<QueuePanel {...defaultProps} />);
    const downButtons = screen.getAllByRole("button", { name: /move down/i });
    expect((downButtons[downButtons.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });
});
