import { describe, it, expect } from "vitest";
import {
  scoreAgainstSeat,
  isEligibleSeat,
  formatPct,
  SEAT_MATCH_PRECISION_THRESHOLD,
  SEAT_MATCH_RECALL_THRESHOLD,
} from "./deckMatching";

describe("scoreAgainstSeat", () => {
  it("scores a perfect match at 1.0 on both axes", () => {
    const cards = new Set(["bolt", "swords"]);
    const picks = new Set(["bolt", "swords"]);
    expect(scoreAgainstSeat(cards, picks)).toEqual({ overlap: 2, recall: 1, precision: 1 });
  });

  it("reports high precision and low recall when picks went unplaced", () => {
    // The seat drafted 4 cards but only placed 2. Every placed card is theirs.
    const cards = new Set(["bolt", "swords"]);
    const picks = new Set(["bolt", "swords", "ragavan", "brainstorm"]);
    const score = scoreAgainstSeat(cards, picks);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(0.5);
  });

  it("reports low precision when the list contains cards the seat never picked", () => {
    const cards = new Set(["bolt", "counterspell", "ponder", "opt"]);
    const picks = new Set(["bolt", "swords"]);
    const score = scoreAgainstSeat(cards, picks);
    expect(score.overlap).toBe(1);
    expect(score.precision).toBe(0.25);
  });

  it("returns zeros rather than NaN for empty inputs", () => {
    expect(scoreAgainstSeat(new Set(), new Set())).toEqual({ overlap: 0, recall: 0, precision: 0 });
  });
});

describe("isEligibleSeat", () => {
  it("requires both precision and recall above their thresholds", () => {
    expect(isEligibleSeat({ overlap: 40, recall: 0.9, precision: 1 })).toBe(true);
    // precision below floor: the list holds cards this seat never drafted
    expect(isEligibleSeat({ overlap: 40, recall: 0.9, precision: 0.5 })).toBe(false);
    // recall below floor: the list covers too little of the seat's pool
    expect(isEligibleSeat({ overlap: 5, recall: 0.1, precision: 1 })).toBe(false);
  });

  it("treats a score exactly on each threshold as eligible", () => {
    expect(
      isEligibleSeat({
        overlap: 1,
        recall: SEAT_MATCH_RECALL_THRESHOLD,
        precision: SEAT_MATCH_PRECISION_THRESHOLD,
      }),
    ).toBe(true);
  });
});

describe("formatPct", () => {
  it("renders a fraction as a one-decimal percentage", () => {
    expect(formatPct(0.9333)).toBe("93.3%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct(0)).toBe("0.0%");
  });
});
