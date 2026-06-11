import { describe, it, expect } from "vitest";
import { normalizeColorIdentity } from "./manaColors";

describe("normalizeColorIdentity", () => {
  it('returns "C" for an empty array', () => {
    expect(normalizeColorIdentity([])).toBe("C");
  });

  it('returns "C" for undefined/null-ish input', () => {
    // The function guards against falsy values
    expect(normalizeColorIdentity(null as unknown as string[])).toBe("C");
    expect(normalizeColorIdentity(undefined as unknown as string[])).toBe("C");
  });

  it("returns the single color for a mono-color identity", () => {
    expect(normalizeColorIdentity(["U"])).toBe("U");
    expect(normalizeColorIdentity(["B"])).toBe("B");
    expect(normalizeColorIdentity(["G"])).toBe("G");
  });

  it("orders UB correctly: [U,B] → UB", () => {
    expect(normalizeColorIdentity(["U", "B"])).toBe("UB");
  });

  it("normalizes BU to WUBRG order: [B,U] → UB", () => {
    expect(normalizeColorIdentity(["B", "U"])).toBe("UB");
  });

  it("normalizes GW to WUBRG order: [G,W] → WG", () => {
    expect(normalizeColorIdentity(["G", "W"])).toBe("WG");
  });

  it("orders a five-color identity: [G,R,B,U,W] → WUBRG", () => {
    expect(normalizeColorIdentity(["G", "R", "B", "U", "W"])).toBe("WUBRG");
  });

  it("handles lowercase input by uppercasing", () => {
    expect(normalizeColorIdentity(["b", "u"])).toBe("UB");
  });

  it("does NOT mutate the input array", () => {
    const input = ["B", "U"];
    const copy = [...input];
    normalizeColorIdentity(input);
    expect(input).toEqual(copy);
  });

  it("does NOT mutate the input array for multi-color", () => {
    const input = ["G", "R", "W"];
    const original = [...input];
    normalizeColorIdentity(input);
    expect(input).toEqual(original);
  });
});
