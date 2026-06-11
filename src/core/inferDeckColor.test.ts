import { describe, it, expect } from "vitest";
import { inferDeckColor } from "./inferDeckColor";

describe("inferDeckColor", () => {
  it("returns 'C' for empty color counts", () => {
    expect(inferDeckColor(new Map())).toBe("C");
  });

  it("returns single color for mono-color deck", () => {
    const counts = new Map([
      ["R", 40],
      ["U", 2],
    ]);
    expect(inferDeckColor(counts)).toBe("R");
  });

  it("returns two colors when second >= 30% of first", () => {
    const counts = new Map([
      ["R", 30],
      ["U", 15],
    ]);
    expect(inferDeckColor(counts)).toBe("UR");
  });

  it("sorts colors in WUBRG order", () => {
    const counts = new Map([
      ["G", 20],
      ["W", 20],
    ]);
    expect(inferDeckColor(counts)).toBe("WG");
  });

  it("returns single color when second < 30% of first", () => {
    const counts = new Map([
      ["R", 40],
      ["U", 10],
    ]);
    expect(inferDeckColor(counts)).toBe("R");
  });

  it("includes second color at exactly the 30% threshold (boundary — inclusive)", () => {
    // secondCount / topCount = 3 / 10 = 0.30 exactly → included
    const counts = new Map([
      ["R", 10],
      ["U", 3],
    ]);
    expect(inferDeckColor(counts)).toBe("UR");
  });

  it("excludes second color at just below the 30% threshold", () => {
    // secondCount / topCount = 2 / 10 = 0.20 < 0.30 → excluded
    const counts = new Map([
      ["R", 10],
      ["U", 2],
    ]);
    expect(inferDeckColor(counts)).toBe("R");
  });
});
