import { describe, it, expect } from "vitest";
import { matchDecksToSeats, extractStoredCards } from "./decklists";

const entry = (id: string, cards: string[]) => ({
  sealeddeckId: id,
  url: `https://sealeddeck.tech/${id}`,
  storedCards: new Set(cards),
  deck: [],
  sideboard: [],
});

describe("extractStoredCards", () => {
  it("excludes the hidden zone", () => {
    // Some submitters pasted the entire remaining cube into `hidden`. We never
    // store that zone, so it must not influence matching either.
    const stored = extractStoredCards({
      poolId: "x",
      deck: [{ name: "Lightning Bolt", count: 1 }],
      sideboard: [{ name: "Brainstorm", count: 1 }],
      hidden: [{ name: "Black Lotus", count: 1 }],
    });
    expect(stored).toEqual(new Set(["lightning bolt", "brainstorm"]));
  });

  it("excludes basic lands and normalizes names", () => {
    const stored = extractStoredCards({
      poolId: "x",
      deck: [
        { name: "Island", count: 8 },
        { name: "Scalding Tarn 2", count: 1 },
      ],
      sideboard: [],
    });
    expect(stored).toEqual(new Set(["scalding tarn"]));
  });
});

describe("matchDecksToSeats", () => {
  const seatPicks = new Map([
    [1, new Set(["bolt", "swords", "ragavan", "brainstorm"])],
    [2, new Set(["counterspell", "ponder", "preordain", "opt"])],
  ]);

  it("assigns a decklist to the seat it overlaps", () => {
    const result = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"])],
      seatPicks,
    );
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("skips a decklist that matches no seat above the threshold", () => {
    // an opted-out player's list: their seat has no picks, so it is absent
    // from seatPicks and this overlaps nobody
    const result = matchDecksToSeats([entry("zzz", ["llanowar elves", "giant growth"])], seatPicks);
    expect(result.size).toBe(0);
  });

  it("never overwrites a good assignment with a sub-threshold one", () => {
    const result = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"]), entry("zzz", ["bolt"])],
      seatPicks,
    );
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("never produces a seat -1 assignment", () => {
    const result = matchDecksToSeats([entry("zzz", ["nothing at all"])], seatPicks);
    expect(result.has(-1)).toBe(false);
  });

  it("assigns a full-cube submission to its true owner", () => {
    // Regression for the corruption bug. This submission carried the whole cube
    // in `hidden`, but its deck+sideboard belong to seat 2 and nobody else.
    // Asserting only "seat 1 is not corrupted" would pass under a fix that
    // merely skips the list; the point is that seat 2 gets its deck.
    const result = matchDecksToSeats(
      [entry("LZYpr4rjmH", ["counterspell", "ponder", "preordain", "opt"])],
      seatPicks,
    );
    expect(result.get(2)?.sealeddeckId).toBe("LZYpr4rjmH");
    expect(result.has(1)).toBe(false);
  });

  it("skips a list whose cards span two seats", () => {
    // Precision gate: a list half of whose cards were drafted by someone else
    // cannot belong to either seat. Recall against seat 1 is 0.5, which clears
    // the recall floor on its own — only precision rejects this.
    const result = matchDecksToSeats(
      [entry("mixed", ["bolt", "swords", "counterspell", "ponder"])],
      seatPicks,
    );
    expect(result.size).toBe(0);
  });
});
