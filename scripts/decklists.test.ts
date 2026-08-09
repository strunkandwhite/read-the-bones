import { describe, it, expect } from "vitest";
import { matchDecksToSeats, extractStoredCards, decideSeatWrite } from "./decklists";

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
    // Regression for the corruption bug. This submitter pasted the entire
    // remaining cube into sealeddeck's `hidden` zone. Building the entry through
    // extractStoredCards is the point: historically, before the precision gate
    // existed, a full-cube `hidden` zone scored 100% recall against every seat
    // and won on recall alone, so seat 1 was assigned a deck belonging to seat 2
    // — the actual corruption that misfiled three decklists. Against today's
    // code with `hidden` still (temporarily) leaking in, the precision gate
    // instead drops both seats to 50% precision, so nothing is assigned and
    // seat 2 — the true owner — gets no deck. Different failure, same root
    // cause: `hidden` must never enter the matching set.
    const storedCards = extractStoredCards({
      poolId: "x",
      deck: [
        { name: "Counterspell", count: 1 },
        { name: "Ponder", count: 1 },
        { name: "Preordain", count: 1 },
        { name: "Opt", count: 1 },
      ],
      sideboard: [],
      hidden: [
        // the whole cube — every card both seats drafted
        { name: "Bolt", count: 1 },
        { name: "Swords", count: 1 },
        { name: "Ragavan", count: 1 },
        { name: "Brainstorm", count: 1 },
        { name: "Counterspell", count: 1 },
        { name: "Ponder", count: 1 },
        { name: "Preordain", count: 1 },
        { name: "Opt", count: 1 },
      ],
    });

    const result = matchDecksToSeats(
      [{ ...entry("LZYpr4rjmH", []), storedCards }],
      seatPicks,
    );

    // The deck must land on its true owner, not merely fail to corrupt seat 1.
    // Asserting only the absence of corruption would also pass under a fix that
    // discards the submission entirely, which would leave seat 2 with no deck.
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

describe("decideSeatWrite", () => {
  it("writes a brand-new seat with no existing row", () => {
    const action = decideSeatWrite(undefined, "hash1", "aaa", false);
    expect(action).toBe("write");
  });

  it("writes when the hash matches but provenance is still NULL (backfill)", () => {
    // This is the state every seat was in before sealeddeck_id existed: the
    // hash already matches, so nothing about the deck changed, but there is
    // no recorded provenance yet. If this ever returned "unchanged", the
    // column would stay NULL forever and the later prune would have nothing
    // to query.
    const action = decideSeatWrite(
      { hash: "hash1", sealeddeckId: null },
      "hash1",
      "aaa",
      false,
    );
    expect(action).toBe("write");
  });

  it("is unchanged when both hash and provenance already match", () => {
    const action = decideSeatWrite(
      { hash: "hash1", sealeddeckId: "aaa" },
      "hash1",
      "aaa",
      false,
    );
    expect(action).toBe("unchanged");
  });

  it("skips a recovered deck without --force", () => {
    const action = decideSeatWrite(
      { hash: "hash1", sealeddeckId: "recovered:seat3.png" },
      "hash2",
      "aaa",
      false,
    );
    expect(action).toBe("skip-recovered");
  });

  it("overwrites a recovered deck when --force is passed", () => {
    // Same recovered row and a genuinely different incoming hash/id as the
    // "without force" case above — force flips skip-recovered into write.
    const action = decideSeatWrite(
      { hash: "hash1", sealeddeckId: "recovered:seat3.png" },
      "hash2",
      "aaa",
      true,
    );
    expect(action).toBe("write");
  });
});
