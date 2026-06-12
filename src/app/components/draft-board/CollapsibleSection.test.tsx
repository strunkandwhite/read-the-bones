// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CollapsibleSection } from "./CollapsibleSection";

describe("CollapsibleSection", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  function bodyWrapper(text: string): HTMLElement {
    const wrapper = screen.getByText(text).parentElement;
    if (!wrapper) throw new Error(`No body wrapper found for "${text}"`);
    return wrapper;
  }

  it("renders expanded by default", () => {
    render(
      <CollapsibleSection title="Draft Grid" storageKey="test:grid">
        <div>Grid body</div>
      </CollapsibleSection>,
    );
    expect(bodyWrapper("Grid body").hidden).toBe(false);
    const toggle = screen.getByRole("button", { name: "Draft Grid" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("collapses on header click, hiding the body", () => {
    render(
      <CollapsibleSection title="Draft Grid" storageKey="test:grid">
        <div>Grid body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft Grid" }));
    expect(bodyWrapper("Grid body").hidden).toBe(true);
    const toggle = screen.getByRole("button", { name: "Draft Grid" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("expands the body again on a second click", () => {
    render(
      <CollapsibleSection title="Draft Grid" storageKey="test:grid">
        <div>Grid body</div>
      </CollapsibleSection>,
    );
    const toggle = screen.getByRole("button", { name: "Draft Grid" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(bodyWrapper("Grid body").hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the body mounted while collapsed", () => {
    render(
      <CollapsibleSection title="Draft Grid" storageKey="test:grid">
        <div>Grid body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft Grid" }));
    // Content is still in the DOM (live updates keep flowing), just hidden.
    expect(screen.getByText("Grid body")).toBeTruthy();
  });

  it("restores the persisted collapsed state on remount", () => {
    const first = render(
      <CollapsibleSection title="Pick Queue" storageKey="test:queue">
        <div>Queue body</div>
      </CollapsibleSection>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick Queue" }));
    first.unmount();

    render(
      <CollapsibleSection title="Pick Queue" storageKey="test:queue">
        <div>Queue body</div>
      </CollapsibleSection>,
    );
    expect(bodyWrapper("Queue body").hidden).toBe(true);
  });

  it("tracks collapse state independently per storage key", () => {
    render(
      <>
        <CollapsibleSection title="Draft Grid" storageKey="test:grid">
          <div>Grid body</div>
        </CollapsibleSection>
        <CollapsibleSection title="Pick Queue" storageKey="test:queue">
          <div>Queue body</div>
        </CollapsibleSection>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft Grid" }));
    expect(bodyWrapper("Grid body").hidden).toBe(true);
    expect(bodyWrapper("Queue body").hidden).toBe(false);
  });

  it("applies expandedClassName only while expanded", () => {
    render(
      <CollapsibleSection
        title="Draft Grid"
        storageKey="test:grid"
        className="flex"
        expandedClassName="flex-1"
      >
        <div>Grid body</div>
      </CollapsibleSection>,
    );
    const section = screen.getByRole("button", { name: "Draft Grid" }).parentElement!;
    expect(section.className).toContain("flex-1");
    fireEvent.click(screen.getByRole("button", { name: "Draft Grid" }));
    expect(section.className).not.toContain("flex-1");
    expect(section.className).toContain("flex");
  });
});
