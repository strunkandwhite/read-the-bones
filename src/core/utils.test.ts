import { describe, it, expect } from "vitest";
import { round3 } from "./utils";

describe("round3", () => {
  it("rounds to 3 decimal places", () => {
    expect(round3(0.12345)).toBe(0.123);
    expect(round3(0.6789)).toBe(0.679);
  });

  it("returns integers unchanged", () => {
    expect(round3(5)).toBe(5);
    expect(round3(0)).toBe(0);
  });

  it("handles values already at 3 or fewer decimals", () => {
    expect(round3(0.5)).toBe(0.5);
    expect(round3(0.12)).toBe(0.12);
    expect(round3(0.123)).toBe(0.123);
  });

  it("rounds 0.5 at the 4th decimal up", () => {
    expect(round3(0.1235)).toBe(0.124);
  });

  it("handles negative numbers", () => {
    expect(round3(-0.12345)).toBe(-0.123);
  });
});
