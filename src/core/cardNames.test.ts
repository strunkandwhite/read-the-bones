import { describe, it, expect } from "vitest";
import { getFrontFace } from "./cardNames";

describe("getFrontFace", () => {
  it("returns front face of a double-faced card", () => {
    expect(getFrontFace("Bonecrusher Giant // Stomp")).toBe("Bonecrusher Giant");
  });

  it("returns null for a single-faced card", () => {
    expect(getFrontFace("Lightning Bolt")).toBeNull();
  });

  it("handles DFC with longer names on both sides", () => {
    expect(getFrontFace("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")).toBe(
      "Fable of the Mirror-Breaker"
    );
  });

  it("does not split on // without surrounding spaces", () => {
    expect(getFrontFace("Some//Card")).toBeNull();
  });
});
