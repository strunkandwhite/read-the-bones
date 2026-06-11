import { describe, it, expect } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Tarkir Rotisserie")).toBe("tarkir-rotisserie");
  });

  it("collapses consecutive non-alphanumeric chars into a single hyphen", () => {
    expect(slugify("Draft #3 (Modern)")).toBe("draft-3-modern");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("-leading and trailing-")).toBe("leading-and-trailing");
  });

  it("preserves numbers", () => {
    expect(slugify("Draft 2024")).toBe("draft-2024");
  });

  it("handles names that are already slug-like", () => {
    expect(slugify("tarkir-rotisserie")).toBe("tarkir-rotisserie");
  });

  it("handles a single word", () => {
    expect(slugify("Tarkir")).toBe("tarkir");
  });

  it("handles apostrophes and special characters", () => {
    expect(slugify("Dominaria's Legacy")).toBe("dominaria-s-legacy");
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });
});
