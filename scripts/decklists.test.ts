import { describe, it, expect } from "vitest";
import {
  matchDecksToSeats,
  extractStoredCards,
  decideSeatWrite,
  parseDecklistArgs,
  assertSeatNotOptedOut,
} from "./decklists";
import { cardNameKey } from "../src/core/parseSheetRows";

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

  it("folds a double-faced card to its front face", () => {
    // pick_events stores "Claim // Fame"; sealeddeck returns whichever face the
    // submitter typed. Both sides key through cardNameKey, so the card counts
    // as the match it is instead of denting precision and recall on a list the
    // write path would resolve without complaint.
    const stored = extractStoredCards({
      poolId: "x",
      deck: [{ name: "Claim", count: 1 }],
      sideboard: [{ name: "Commit // Memory", count: 1 }],
    });
    expect(stored).toEqual(new Set(["claim", "commit"]));
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
    const { assignments } = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"])],
      seatPicks,
    );
    expect(assignments.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("skips a decklist that matches no seat above the threshold", () => {
    // an opted-out player's list: their seat has no picks, so it is absent
    // from seatPicks and this overlaps nobody
    const { assignments, skippedBelowThreshold } = matchDecksToSeats(
      [entry("zzz", ["llanowar elves", "giant growth"])],
      seatPicks,
    );
    expect(assignments.size).toBe(0);
    expect(skippedBelowThreshold).toBe(1);
  });

  it("never overwrites a good assignment with a sub-threshold one", () => {
    const { assignments } = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"]), entry("zzz", ["bolt"])],
      seatPicks,
    );
    expect(assignments.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("never produces a seat -1 assignment", () => {
    const { assignments } = matchDecksToSeats([entry("zzz", ["nothing at all"])], seatPicks);
    expect(assignments.has(-1)).toBe(false);
  });

  it("assigns a full-cube submission to its true owner", () => {
    // Regression for the corruption bug. This submitter pasted the entire
    // remaining cube into sealeddeck's `hidden` zone. Building the entry through
    // extractStoredCards is the point: historically, before the precision gate
    // existed, a full-cube `hidden` zone scored 100% recall against every seat
    // and won on recall alone, so seat 1 was assigned a deck belonging to seat 2
    // — the actual corruption that misfiled three decklists. extractStoredCards
    // now drops `hidden`, so the list is matched on the four cards it will
    // actually store and lands on seat 2, its true owner.
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

    const { assignments } = matchDecksToSeats(
      [{ ...entry("LZYpr4rjmH", []), storedCards }],
      seatPicks,
    );

    // The deck must land on its true owner, not merely fail to corrupt seat 1.
    // Asserting only the absence of corruption would also pass under a fix that
    // discards the submission entirely, which would leave seat 2 with no deck.
    expect(assignments.get(2)?.sealeddeckId).toBe("LZYpr4rjmH");
    expect(assignments.has(1)).toBe(false);
  });

  it("matches a list that names only the front face of a split card", () => {
    // seatPicks is keyed exactly as getSeatPicks keys it — cardNameKey over the
    // name in `cards`. Production holds four split cards in pick_events; at 41
    // cards a list, four names counted as misses would spend the entire 0.9
    // precision budget on cards that write correctly.
    const picks = new Map([
      [
        3,
        new Set(
          ["Claim // Fame", "Commit // Memory", "Life // Death", "Counterspell"].map(cardNameKey),
        ),
      ],
    ]);
    const storedCards = extractStoredCards({
      poolId: "x",
      deck: [
        { name: "Claim", count: 1 },
        { name: "Commit", count: 1 },
        { name: "Life", count: 1 },
        { name: "Counterspell", count: 1 },
      ],
      sideboard: [],
    });

    const { assignments } = matchDecksToSeats([{ ...entry("split", []), storedCards }], picks);
    expect(assignments.get(3)?.sealeddeckId).toBe("split");
  });

  it("skips a list whose cards span two seats", () => {
    // Precision gate: a list half of whose cards were drafted by someone else
    // cannot belong to either seat. Recall against seat 1 is 0.5, which clears
    // the recall floor on its own — only precision rejects this.
    const { assignments, skippedBelowThreshold } = matchDecksToSeats(
      [entry("mixed", ["bolt", "swords", "counterspell", "ponder"])],
      seatPicks,
    );
    expect(assignments.size).toBe(0);
    expect(skippedBelowThreshold).toBe(1);
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

describe("assertSeatNotOptedOut", () => {
  it("refuses to write a deck for a seat that opted out", () => {
    expect(() => assertSeatNotOptedOut(2, new Set([2]), "tarkir")).toThrow(
      /seat 2 .*opted out/i,
    );
  });

  it("allows a seat that did not opt out", () => {
    expect(() => assertSeatNotOptedOut(3, new Set([2]), "tarkir")).not.toThrow();
  });
});

describe("parseDecklistArgs", () => {
  it("defaults to no filter and both flags off", () => {
    expect(parseDecklistArgs([])).toEqual({
      filterDraft: undefined,
      force: false,
      dryRun: false,
    });
  });

  it("picks up a draft label alongside recognized flags", () => {
    expect(parseDecklistArgs(["tarkir", "--dry-run", "--force"])).toEqual({
      filterDraft: "tarkir",
      force: true,
      dryRun: true,
    });
  });

  it("recognizes --dry-run and --force regardless of order", () => {
    expect(parseDecklistArgs(["--force", "--dry-run"])).toEqual({
      filterDraft: undefined,
      force: true,
      dryRun: true,
    });
  });

  it("throws on an unrecognized flag instead of silently dropping it", () => {
    // A typo like --dry-rn must not fall through to a full destructive run —
    // there is one database and no undo.
    expect(() => parseDecklistArgs(["--dry-rn"])).toThrow("Unrecognized flag: --dry-rn");
  });

  it("throws on an unrecognized flag even when a valid flag is also present", () => {
    expect(() => parseDecklistArgs(["--dry-run", "--forc"])).toThrow(
      "Unrecognized flag: --forc",
    );
  });
});
