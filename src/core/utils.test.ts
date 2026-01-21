import { describe, it, expect } from "vitest";
import { wilsonInterval } from "./utils";

describe("wilsonInterval", () => {
  it("returns all zeros for 0 games", () => {
    const result = wilsonInterval(0, 0);
    expect(result).toEqual({ lower: 0, center: 0, upper: 0 });
  });

  it("pulls toward 0.5 for all wins (5/5)", () => {
    const result = wilsonInterval(5, 5);
    expect(result.center).toBeLessThan(1);
    expect(result.upper).toBeLessThanOrEqual(1);
    expect(result.lower).toBeGreaterThan(0);
  });

  it("pulls toward 0.5 for all losses (0/5)", () => {
    const result = wilsonInterval(0, 5);
    expect(result.lower).toBe(0);
    expect(result.center).toBeGreaterThan(0);
    expect(result.upper).toBeGreaterThan(0);
  });

  it("centers near 0.5 for a 50/50 split (5/10)", () => {
    const result = wilsonInterval(5, 10);
    expect(result.center).toBeGreaterThanOrEqual(0.4);
    expect(result.center).toBeLessThanOrEqual(0.6);
    expect(result.lower).toBeGreaterThanOrEqual(0);
    expect(result.upper).toBeLessThanOrEqual(1);
  });

  it("produces a wide interval for a single game win (1/1)", () => {
    const result = wilsonInterval(1, 1);
    const width = result.upper - result.lower;
    expect(width).toBeGreaterThan(0.5);
    expect(result.center).toBeLessThan(1);
    expect(result.lower).toBeGreaterThanOrEqual(0);
  });

  it("produces a narrow interval for a large sample (50/100)", () => {
    const result = wilsonInterval(50, 100);
    const width = result.upper - result.lower;
    expect(width).toBeLessThan(0.2);
    expect(result.center).toBeGreaterThanOrEqual(0.45);
    expect(result.center).toBeLessThanOrEqual(0.55);
    expect(result.lower).toBeGreaterThanOrEqual(0);
    expect(result.upper).toBeLessThanOrEqual(1);
  });
});
