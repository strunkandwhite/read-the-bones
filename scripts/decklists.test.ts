import { describe, it, expect } from "vitest";
import { matchDecksToSeats } from "./decklists";

const entry = (id: string, cards: string[]) => ({
  sealeddeckId: id,
  url: `https://sealeddeck.tech/${id}`,
  pool: new Set(cards),
  deck: [],
  sideboard: [],
});

describe("matchDecksToSeats", () => {
  const seatPicks = new Map([
    [1, new Set(["bolt", "swords", "ragavan", "brainstorm"])],
    [2, new Set(["counterspell", "ponder", "preordain", "opt"])],
  ]);

  it("assigns a decklist to the seat it overlaps", () => {
    const result = matchDecksToSeats([entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"])], seatPicks);
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
});
