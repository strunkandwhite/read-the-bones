// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HoldToPickButton } from "./HoldToPickButton";

describe("HoldToPickButton", () => {
  afterEach(cleanup);

  it("renders with 'Hold to Pick' label", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    expect(screen.getByText("Hold to Pick")).toBeTruthy();
  });

  it("has green background styling", () => {
    render(<HoldToPickButton onPick={vi.fn()} />);
    const button = screen.getByRole("button");
    expect(button.className).toContain("bg-green");
  });
});
