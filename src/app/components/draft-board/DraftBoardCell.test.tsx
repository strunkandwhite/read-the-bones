// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { DraftBoardCell } from "./DraftBoardCell";

// PickAutocomplete reads availableCardNames from cardStore. Stubbed so the
// click-to-pick-target tests below can observe whether it actually mounts.
vi.mock("@/app/stores/cardStore", () => ({
  useCardStore: (selector: (state: { availableCardNames: string[] }) => unknown) =>
    selector({ availableCardNames: ["Lightning Bolt", "Counterspell"] }),
}));

// jsdom does not implement scrollIntoView; PickAutocomplete calls it when its
// highlighted-option effect runs on mount.
Element.prototype.scrollIntoView = vi.fn();

describe("DraftBoardCell", () => {
  afterEach(() => {
    cleanup();
  });

  // --- Redaction marker: pickN <= latestPickN gate ------------------------

  it("renders [REDACTED] for a redacted seat's completed pick", () => {
    render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={3} latestPickN={10} />);
    expect(screen.getByText("[REDACTED]")).toBeTruthy();
  });

  it("leaves a redacted seat's future picks blank", () => {
    render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={30} latestPickN={10} />);
    expect(screen.queryByText("[REDACTED]")).toBeNull();
  });

  it("shows [REDACTED] exactly at the boundary (pickN === latestPickN)", () => {
    // Catches an off-by-one that used `pickN < latestPickN` instead of `<=`.
    render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={10} latestPickN={10} />);
    expect(screen.getByText("[REDACTED]")).toBeTruthy();
  });

  it("stays blank one pick past the boundary (pickN === latestPickN + 1)", () => {
    // Paired with the previous test: together they pin the comparison to
    // exactly `<=` rather than `<` (would fail this one) or `<=` with a
    // stray +1/-1 (would fail one of the two).
    render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={true} pickN={11} latestPickN={10} />);
    expect(screen.queryByText("[REDACTED]")).toBeNull();
  });

  it("never shows [REDACTED] for a non-redacted cell, regardless of pickN/latestPickN", () => {
    // Catches an implementation that dropped the `isRedacted &&` term.
    render(<DraftBoardCell cardName={null} colorIdentity={[]} isRedacted={false} pickN={3} latestPickN={10} />);
    expect(screen.queryByText("[REDACTED]")).toBeNull();
  });

  it("shows the real card name (not [REDACTED]) for a non-redacted cell with a pick", () => {
    render(<DraftBoardCell cardName="Lightning Bolt" colorIdentity={["R"]} isRedacted={false} pickN={3} latestPickN={10} />);
    expect(screen.getByText("Lightning Bolt")).toBeTruthy();
    expect(screen.queryByText("[REDACTED]")).toBeNull();
  });

  // --- Editability guard ---------------------------------------------------

  it("does not become a click-to-pick target for a redacted cell, even though cardName is null", () => {
    render(
      <DraftBoardCell
        cardName={null}
        colorIdentity={[]}
        isRedacted={true}
        pickN={3}
        latestPickN={10}
        isEditable={true}
        draftId="d1"
        nextPickN={3}
      />,
    );
    const cell = screen.getByText("[REDACTED]").closest("td")!;
    fireEvent.click(cell);
    // If the `!showRedacted` guard were missing from handleCellClick, this
    // click would flip isEditing and mount PickAutocomplete's combobox.
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("remains a click-to-pick target for an ordinary editable empty cell (control for the guard above)", () => {
    // Same isEditable/cardName-null shape as the previous test, minus
    // isRedacted — proves the guard is scoped to redacted cells rather than
    // having disabled click-to-pick entirely.
    render(
      <DraftBoardCell
        cardName={null}
        colorIdentity={[]}
        isRedacted={false}
        isEditable={true}
        draftId="d1"
        nextPickN={3}
      />,
    );
    const cell = document.querySelector("td")!;
    fireEvent.click(cell);
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
