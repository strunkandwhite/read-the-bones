import { describe, it, expect } from "vitest";
import { wilsonInterval } from "./wilsonInterval";

describe("wilsonInterval", () => {
  it("should return [0, 0] for zero trials", () => {
    expect(wilsonInterval(0, 0)).toEqual([0, 0]);
  });

  it("should return a narrow interval for large sample", () => {
    const [lower, upper] = wilsonInterval(500, 1000);
    // 50% win rate with 1000 games should be tight
    expect(lower).toBeGreaterThan(0.46);
    expect(upper).toBeLessThan(0.54);
  });

  it("should return a wide interval for small sample", () => {
    const [lower, upper] = wilsonInterval(3, 5);
    // 60% win rate with 5 games should be very wide
    expect(lower).toBeLessThan(0.25);
    expect(upper).toBeGreaterThan(0.85);
  });

  it("should handle all wins", () => {
    const [lower, upper] = wilsonInterval(10, 10);
    expect(upper).toBe(1);
    expect(lower).toBeGreaterThan(0.65);
  });

  it("should handle all losses", () => {
    const [lower, upper] = wilsonInterval(0, 10);
    expect(lower).toBe(0);
    expect(upper).toBeLessThan(0.35);
  });

  it("should clamp bounds to [0, 1]", () => {
    const [lower, upper] = wilsonInterval(1, 1);
    expect(lower).toBeGreaterThanOrEqual(0);
    expect(upper).toBeLessThanOrEqual(1);
  });
});
