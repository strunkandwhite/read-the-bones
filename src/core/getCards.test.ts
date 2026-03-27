import { describe, it, expect } from "vitest";
import { getCards } from "./getCards";

const hasTurso = !!process.env.TURSO_DATABASE_URL;

describe.skipIf(!hasTurso)("getCards", () => {
  it("returns card stats for all completed drafts by default", async () => {
    const result = await getCards({});

    expect(result.cards).toBeDefined();
    expect(Array.isArray(result.cards)).toBe(true);
    expect(result.draftCount).toBeGreaterThan(0);
    expect(result.ingestionHash).toBeDefined();
    expect(typeof result.ingestionHash).toBe("string");
    expect(result.completedDraftIds.length).toBe(result.draftCount);
    expect(result.cubeCopies).toBeDefined();
    expect(result.draftMetadata).toBeDefined();

    // Cards should have core stats
    if (result.cards.length > 0) {
      const card = result.cards[0];
      expect(card.cardName).toBeDefined();
      expect(card.weightedGeomean).toBeDefined();
      expect(card.scryfall).toBeDefined();
    }
  });

  it("filters by specific draft IDs", async () => {
    // First get all drafts to know valid IDs
    const all = await getCards({});
    const firstDraftId = all.completedDraftIds[0];

    const filtered = await getCards({
      draftIds: [firstDraftId],
    });

    expect(filtered.draftCount).toBe(1);
    expect(filtered.cards.length).toBeGreaterThan(0);
    // Fewer or equal cards compared to all drafts
    expect(filtered.cards.length).toBeLessThanOrEqual(all.cards.length);
  });

  it("returns ingestion hash", async () => {
    const result = await getCards({});
    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
  });
});
