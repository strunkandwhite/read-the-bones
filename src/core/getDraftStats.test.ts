import { describe, it, expect } from "vitest";
import { getDraftStats } from "./getDraftStats";

const hasTurso = !!process.env.TURSO_DATABASE_URL;

describe.skipIf(!hasTurso)("getDraftStats", () => {
  it("returns win rate by seat across all drafts", async () => {
    const result = await getDraftStats();

    expect(result.winRateBySeat.length).toBeGreaterThan(0);
    for (const seat of result.winRateBySeat) {
      expect(seat.seat).toBeGreaterThan(0);
      expect(seat.wins + seat.losses).toBeGreaterThan(0);
      expect(seat.winRate).toBeGreaterThanOrEqual(0);
      expect(seat.winRate).toBeLessThanOrEqual(1);
    }
  });

  it("returns win rate by color", async () => {
    const result = await getDraftStats();

    expect(result.winRateByColor.length).toBeGreaterThan(0);
    for (const color of result.winRateByColor) {
      expect(color.color).toBeDefined();
      expect(color.wins + color.losses).toBeGreaterThan(0);
      expect(color.winRate).toBeGreaterThanOrEqual(0);
      expect(color.winRate).toBeLessThanOrEqual(1);
    }
  });

  // Filtering by draftIds requires known draft IDs from a live database,
  // so it's not feasible to test here without hardcoding test data.

  it("returns ingestion hash", async () => {
    const result = await getDraftStats();
    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
  });
});
