import { describe, it, expect } from "vitest";
import { detectNewPicks, detectDivergence } from "../sync";
import type { CardPick } from "../types";

// Helper to create a CardPick with required fields
function pick(name: string, position: number, seat: number): CardPick {
  return {
    cardName: name,
    pickPosition: position,
    seat,
    copyNumber: 1,
    wasPicked: true,
    draftId: "test-draft",
    color: "",
  };
}

describe("detectNewPicks", () => {
  it("returns only picks with pickPosition greater than currentMax", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
    ];
    const result = detectNewPicks(allPicks, 1);
    expect(result).toHaveLength(2);
    expect(result[0].cardName).toBe("Counterspell");
    expect(result[1].cardName).toBe("Swords to Plowshares");
  });

  it("returns all picks when currentMax is 0", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 0);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no new picks", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 5);
    expect(result).toHaveLength(0);
  });
});

describe("detectDivergence", () => {
  it("detects when CSV has fewer picks than database", () => {
    expect(detectDivergence(3, 5)).toBe(true);
  });

  it("no divergence when CSV has more picks", () => {
    expect(detectDivergence(5, 3)).toBe(false);
  });

  it("no divergence when counts are equal", () => {
    expect(detectDivergence(3, 3)).toBe(false);
  });
});
