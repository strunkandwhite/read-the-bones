// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueuePanel } from "./QueuePanel";
import type { QueueGroupEntry } from "../../stores/liveStore";

describe("QueuePanel", () => {
  const singleEntryQueue: QueueGroupEntry[] = [
    { mode: "pause", cards: [{ cardId: 10, cardName: "Lightning Bolt" }] },
    { mode: "flow-through", cards: [{ cardId: 20, cardName: "Counterspell" }] },
  ];

  const groupEntryQueue: QueueGroupEntry[] = [
    {
      mode: "flow-through",
      cards: [
        { cardId: 10, cardName: "Counterspell" },
        { cardId: 20, cardName: "Mana Drain" },
        { cardId: 30, cardName: "Arcane Denial" },
      ],
    },
    { mode: "pause", cards: [{ cardId: 40, cardName: "Demonic Tutor" }] },
  ];

  const defaultProps = {
    queue: singleEntryQueue,
    autoPick: true,
    onReorder: vi.fn(),
    onRemove: vi.fn(),
    onToggleAutoPick: vi.fn(),
    onSetEntryMode: vi.fn(),
  };

  afterEach(() => {
    cleanup();
  });

  it("renders single-card entries", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText("Lightning Bolt")).toBeTruthy();
    expect(screen.getByText("Counterspell")).toBeTruthy();
  });

  it("renders group entries with all cards", () => {
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} />);
    expect(screen.getByText("Counterspell")).toBeTruthy();
    expect(screen.getByText("Mana Drain")).toBeTruthy();
    expect(screen.getByText("Arcane Denial")).toBeTruthy();
    expect(screen.getByText("Demonic Tutor")).toBeTruthy();
    // Group header should indicate 3 cards
    expect(screen.getByText(/Group \(3\)/i)).toBeTruthy();
  });

  it("shows mode indicator on entries", () => {
    render(<QueuePanel {...defaultProps} />);
    // Lightning Bolt is "pause" → ⏸
    // Counterspell is "flow-through" → ⏩
    const pauseButtons = screen.getAllByTitle(/Pause/i);
    const flowButtons = screen.getAllByTitle(/Flow-through/i);
    expect(pauseButtons.length).toBeGreaterThan(0);
    expect(flowButtons.length).toBeGreaterThan(0);
  });

  it("calls onSetEntryMode when mode toggled", () => {
    const onSetEntryMode = vi.fn();
    render(<QueuePanel {...defaultProps} onSetEntryMode={onSetEntryMode} />);
    // Click the mode toggle on Lightning Bolt (index 0, currently "pause" → toggle to "flow-through")
    const modeButtons = screen.getAllByTitle(/Pause/i);
    fireEvent.click(modeButtons[0]);
    expect(onSetEntryMode).toHaveBeenCalledWith(0, "flow-through");
  });

  it("calls onRemove when remove button clicked", () => {
    const onRemove = vi.fn();
    render(<QueuePanel {...defaultProps} onRemove={onRemove} />);
    const removeButtons = screen.getAllByRole("button", { name: /remove lightning bolt/i });
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("Lightning Bolt");
  });

  it("shows empty state", () => {
    render(<QueuePanel {...defaultProps} queue={[]} />);
    expect(screen.getByText(/empty/i)).toBeTruthy();
  });

  it("shows auto-pick toggle", () => {
    render(<QueuePanel {...defaultProps} />);
    expect(screen.getByText(/Auto-pick/i)).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("calls onToggleAutoPick when checkbox clicked", () => {
    const onToggleAutoPick = vi.fn();
    render(<QueuePanel {...defaultProps} onToggleAutoPick={onToggleAutoPick} />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onToggleAutoPick).toHaveBeenCalled();
  });

  it("renders taken cards with strike-through", () => {
    render(
      <QueuePanel
        {...defaultProps}
        takenCards={new Set(["Lightning Bolt"])}
      />
    );
    const bolt = screen.getByText("Lightning Bolt");
    expect(bolt.className).toContain("line-through");
  });

  it("does not apply strike-through to non-taken cards", () => {
    render(
      <QueuePanel
        {...defaultProps}
        takenCards={new Set(["Lightning Bolt"])}
      />
    );
    const counterspell = screen.getByText("Counterspell");
    expect(counterspell.className).not.toContain("line-through");
  });

  it("flow-through mode toggle calls onSetEntryMode with pause", () => {
    const onSetEntryMode = vi.fn();
    render(<QueuePanel {...defaultProps} onSetEntryMode={onSetEntryMode} />);
    // Counterspell is at index 1, currently "flow-through" → toggle to "pause"
    const flowButtons = screen.getAllByTitle(/Flow-through/i);
    fireEvent.click(flowButtons[0]);
    expect(onSetEntryMode).toHaveBeenCalledWith(1, "pause");
  });
});
