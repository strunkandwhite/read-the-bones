// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { InlineEditableName } from "./InlineEditableName";

describe("InlineEditableName", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders current name as text when not editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={false}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("renders current name as text when editable but not editing", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("enters edit mode on click when editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Alice");
  });

  it("does not enter edit mode on click when not editable", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={false}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("saves on Enter", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Bob"));
  });

  it("cancels on Escape and reverts to original value", () => {
    const onSave = vi.fn();
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onSave).not.toHaveBeenCalled();
    // Should exit edit mode and show original text
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Alice")).toBeTruthy();
  });

  it("saves on blur", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.blur(input);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Bob"));
  });

  it("does not call onSave when value unchanged", () => {
    const onSave = vi.fn();
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSave).not.toHaveBeenCalled();
  });

  it("calls onSave with empty string to clear name", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(""));
  });

  it("enforces 50 character max length", () => {
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.maxLength).toBe(50);
  });

  it("reverts display on save failure", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("fail"));
    render(
      <InlineEditableName
        currentName="Alice"
        seatNumber={1}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Alice"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Alice")).toBeTruthy());
  });

  it("does not call onSave when name is cleared while already at fallback 'Seat N'", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <InlineEditableName
        currentName="Seat 3"
        seatNumber={3}
        isEditable={true}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByText("Seat 3"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // Clearing when already at the fallback name is a no-op — no network call
    await waitFor(() => expect(onSave).not.toHaveBeenCalled());
    expect(screen.getByText("Seat 3")).toBeTruthy();
  });
});
