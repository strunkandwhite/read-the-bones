// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ManaSymbols } from "./ManaSymbols";

afterEach(cleanup);

function renderedSymbols(): string[] {
  return [...document.querySelectorAll("img")].map((img) => img.getAttribute("alt") ?? "");
}

describe("ManaSymbols", () => {
  it("renders a single-face cost as its symbols", () => {
    render(<ManaSymbols cost="{2}{U}{U}" />);

    expect(renderedSymbols()).toEqual(["{2}", "{U}", "{U}"]);
    expect(screen.queryByText("//")).toBeNull();
  });

  it("separates the two halves of a multi-face cost", () => {
    render(<ManaSymbols cost="{2}{R} // {1}{R}" />);

    expect(renderedSymbols()).toEqual(["{2}", "{R}", "{1}", "{R}"]);
    expect(screen.getByText("//")).toBeTruthy();
  });

  it("keeps each face in its own unbreakable group", () => {
    const { container } = render(<ManaSymbols cost="{G} // {1}{B}" />);

    const faces = container.querySelectorAll("span.flex-nowrap");
    expect(faces.length).toBe(2);
    expect(faces[0].querySelectorAll("img").length).toBe(1);
    expect(faces[1].querySelectorAll("img").length).toBe(2);
  });

  it("renders a dash for an empty cost", () => {
    render(<ManaSymbols cost="" />);

    expect(screen.getByText("-")).toBeTruthy();
    expect(renderedSymbols()).toEqual([]);
  });
});
