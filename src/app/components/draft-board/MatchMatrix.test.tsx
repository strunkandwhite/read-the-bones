// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MatchMatrix } from "./MatchMatrix";

describe("MatchMatrix", () => {
  const defaultProps = {
    matches: [],
    numSeats: 3,
    seatNames: { "1": "Alice", "2": "Bob", "3": "Carol" },
    mySeat: 1,
    phase: "playing",
    onReportMatch: vi.fn(),
    onDeleteMatch: vi.fn(),
    onMatchReported: vi.fn(),
    onMatchReverted: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps the editor open, shows the error, and re-enables the input when delete fails", async () => {
    const onDeleteMatch = vi.fn().mockResolvedValue("Network error");
    render(
      <MatchMatrix
        {...defaultProps}
        matches={[{ seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 1 }]}
        onDeleteMatch={onDeleteMatch}
      />
    );

    fireEvent.click(screen.getByTestId("match-cell-1-2"));
    fireEvent.click(screen.getByTestId("match-delete"));

    await waitFor(() => expect(onDeleteMatch).toHaveBeenCalledWith(2));
    await waitFor(() => expect(screen.getByText("Network error")).toBeTruthy());

    // Editor stays open and the input is re-enabled, not left disabled from
    // the in-flight "saving" state.
    const input = screen.getByTestId("match-input") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });

  it("does not delete on Enter over an emptied input when the cell has no stored result", async () => {
    const onDeleteMatch = vi.fn();
    render(<MatchMatrix {...defaultProps} matches={[]} onDeleteMatch={onDeleteMatch} />);

    fireEvent.click(screen.getByTestId("match-cell-1-2"));
    const input = screen.getByTestId("match-input") as HTMLInputElement;
    expect(input.value).toBe("");

    // Type something then clear it, mirroring a user emptying the field.
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Falls through to the save path, which rejects the empty value.
    await waitFor(() =>
      expect(screen.getByText("Format: W-L (e.g. 2-1), one side must be 2")).toBeTruthy()
    );
    expect(onDeleteMatch).not.toHaveBeenCalled();
  });

  it("shows the delete button only when the cell being edited has a stored result", () => {
    render(<MatchMatrix {...defaultProps} matches={[]} />);
    fireEvent.click(screen.getByTestId("match-cell-1-2"));
    expect(screen.queryByTestId("match-delete")).toBeNull();

    cleanup();

    render(
      <MatchMatrix
        {...defaultProps}
        matches={[{ seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 }]}
      />
    );
    fireEvent.click(screen.getByTestId("match-cell-1-2"));
    expect(screen.getByTestId("match-delete")).toBeTruthy();
  });
});
