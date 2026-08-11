// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueuePanel, reorderEntryToSlot } from "./QueuePanel";
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
    render(<QueuePanel {...defaultProps} takenCards={new Set(["Lightning Bolt"])} />);
    const bolt = screen.getByText("Lightning Bolt");
    expect(bolt.className).toContain("line-through");
  });

  it("does not apply strike-through to non-taken cards", () => {
    render(<QueuePanel {...defaultProps} takenCards={new Set(["Lightning Bolt"])} />);
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

  it("disables the group button on the first entry", () => {
    render(<QueuePanel {...defaultProps} />);
    const groupButtons = screen.getAllByLabelText("Group with card above");
    expect((groupButtons[0] as HTMLButtonElement).disabled).toBe(true);
    expect((groupButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("groups two single entries when the lower one's group button is clicked", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} onReorder={onReorder} />);
    // Click the group button on Counterspell (entry 1) → merge into Bolt (entry 0)
    const groupButtons = screen.getAllByLabelText("Group with card above");
    fireEvent.click(groupButtons[1]);
    expect(onReorder).toHaveBeenCalledWith([
      {
        mode: "pause", // keeps the upper entry's mode
        cards: [
          { cardId: 10, cardName: "Lightning Bolt" },
          { cardId: 20, cardName: "Counterspell" },
        ],
      },
    ]);
  });

  it("adds a single entry to the group above it", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} onReorder={onReorder} />);
    // Demonic Tutor (entry 1) grouped into the 3-card group above (entry 0)
    const groupButtons = screen.getAllByLabelText("Group with card above");
    fireEvent.click(groupButtons[1]);
    expect(onReorder).toHaveBeenCalledWith([
      {
        mode: "flow-through",
        cards: [
          { cardId: 10, cardName: "Counterspell" },
          { cardId: 20, cardName: "Mana Drain" },
          { cardId: 30, cardName: "Arcane Denial" },
          { cardId: 40, cardName: "Demonic Tutor" },
        ],
      },
    ]);
  });

  it("ejects a card from a group into its own entry after the group", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} onReorder={onReorder} />);
    fireEvent.click(screen.getByLabelText("Ungroup Mana Drain"));
    expect(onReorder).toHaveBeenCalledWith([
      {
        mode: "flow-through",
        cards: [
          { cardId: 10, cardName: "Counterspell" },
          { cardId: 30, cardName: "Arcane Denial" },
        ],
      },
      { mode: "pause", cards: [{ cardId: 20, cardName: "Mana Drain" }] },
      { mode: "pause", cards: [{ cardId: 40, cardName: "Demonic Tutor" }] },
    ]);
  });

  it("reorders cards within a group via the up/down buttons", () => {
    const onReorder = vi.fn();
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} onReorder={onReorder} />);
    // Group cards: Counterspell(0, up disabled), Mana Drain(1), Arcane Denial(2).
    // Move Mana Drain up → swaps with Counterspell.
    const upButtons = screen.getAllByLabelText("Move up");
    fireEvent.click(upButtons[1]);
    expect(onReorder).toHaveBeenCalledWith([
      {
        mode: "flow-through",
        cards: [
          { cardId: 20, cardName: "Mana Drain" },
          { cardId: 10, cardName: "Counterspell" },
          { cardId: 30, cardName: "Arcane Denial" },
        ],
      },
      { mode: "pause", cards: [{ cardId: 40, cardName: "Demonic Tutor" }] },
    ]);
  });

  it("collapses a two-card group to a single entry when one card is ejected", () => {
    const onReorder = vi.fn();
    const twoCardGroup: QueueGroupEntry[] = [
      {
        mode: "flow-through",
        cards: [
          { cardId: 10, cardName: "Counterspell" },
          { cardId: 20, cardName: "Mana Drain" },
        ],
      },
    ];
    render(<QueuePanel {...defaultProps} queue={twoCardGroup} onReorder={onReorder} />);
    fireEvent.click(screen.getByLabelText("Ungroup Mana Drain"));
    expect(onReorder).toHaveBeenCalledWith([
      { mode: "flow-through", cards: [{ cardId: 10, cardName: "Counterspell" }] },
      { mode: "pause", cards: [{ cardId: 20, cardName: "Mana Drain" }] },
    ]);
  });

  it("puts the drag activator on the grip handle rather than the row", () => {
    render(<QueuePanel {...defaultProps} />);
    const handle = screen.getByRole("button", { name: "Reorder Lightning Bolt" });
    expect(handle.getAttribute("aria-roledescription")).toBe("draggable");
  });

  it("exposes one draggable activator per entry, each a real button", () => {
    const { container } = render(<QueuePanel {...defaultProps} />);
    const activators = container.querySelectorAll('[aria-roledescription="draggable"]');
    expect(activators.length).toBe(singleEntryQueue.length);
    activators.forEach((el) => expect(el.tagName).toBe("BUTTON"));
  });

  it("labels the group handle with the group size", () => {
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} />);
    expect(screen.getByRole("button", { name: "Reorder group of 3 cards" })).toBeTruthy();
  });
});

describe("reorderEntryToSlot", () => {
  const q: QueueGroupEntry[] = [
    { mode: "pause", cards: [{ cardId: 1, cardName: "A" }] },
    { mode: "pause", cards: [{ cardId: 2, cardName: "B" }] },
    { mode: "pause", cards: [{ cardId: 3, cardName: "C" }] },
  ];
  const names = (queue: QueueGroupEntry[]) => queue.map((e) => e.cards[0].cardName);

  it("returns null for no-op drops (same position)", () => {
    expect(reorderEntryToSlot(q, 1, 1)).toBeNull(); // slot before self
    expect(reorderEntryToSlot(q, 1, 2)).toBeNull(); // slot just after self
  });

  it("moves an entry down (slot index decremented past the removed entry)", () => {
    // Move A (0) to the end slot (3) → B, C, A
    expect(names(reorderEntryToSlot(q, 0, 3)!)).toEqual(["B", "C", "A"]);
    // Move A (0) to slot 2 (before C) → B, A, C
    expect(names(reorderEntryToSlot(q, 0, 2)!)).toEqual(["B", "A", "C"]);
  });

  it("moves an entry up (slot index unchanged)", () => {
    // Move C (2) to slot 0 (top) → C, A, B
    expect(names(reorderEntryToSlot(q, 2, 0)!)).toEqual(["C", "A", "B"]);
  });

  it("does not mutate the input queue", () => {
    reorderEntryToSlot(q, 0, 3);
    expect(names(q)).toEqual(["A", "B", "C"]);
  });
});
