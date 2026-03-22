// src/core/db/sync/__tests__/domains.test.ts
import { describe, it, expect } from "vitest";
import {
  hashPicks,
  hashPool,
  hashMatches,
  compareDomainHash,
} from "../domains";
import type { CardPick, MatchResult } from "../../../parseSheetRows";

describe("hashPool", () => {
  it("produces consistent hash for same cards regardless of order", () => {
    const a = hashPool(["Bolt", "Counterspell", "Ritual"]);
    const b = hashPool(["Ritual", "Bolt", "Counterspell"]);
    expect(a).toBe(b);
  });

  it("produces different hash for different pools", () => {
    const a = hashPool(["Bolt", "Counterspell"]);
    const b = hashPool(["Bolt", "Ritual"]);
    expect(a).not.toBe(b);
  });
});

describe("hashPicks", () => {
  it("produces consistent hash for same picks", () => {
    const picks: CardPick[] = [
      {
        cardName: "Bolt",
        pickPosition: 1,
        seat: 0,
        copyNumber: 1,
        wasPicked: true,
        draftId: "d",
        color: "R",
      },
      {
        cardName: "Counter",
        pickPosition: 2,
        seat: 1,
        copyNumber: 1,
        wasPicked: true,
        draftId: "d",
        color: "U",
      },
    ];
    expect(hashPicks(picks)).toBe(hashPicks([...picks]));
  });

  it("detects changed pick data", () => {
    const a: CardPick[] = [
      {
        cardName: "Bolt",
        pickPosition: 1,
        seat: 0,
        copyNumber: 1,
        wasPicked: true,
        draftId: "d",
        color: "R",
      },
    ];
    const b: CardPick[] = [
      {
        cardName: "Bolt",
        pickPosition: 1,
        seat: 1,
        copyNumber: 1,
        wasPicked: true,
        draftId: "d",
        color: "R",
      },
    ];
    expect(hashPicks(a)).not.toBe(hashPicks(b));
  });
});

describe("hashMatches", () => {
  it("produces consistent hash for same matches regardless of order", () => {
    const matches: MatchResult[] = [
      { seat1: 1, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 1 },
      { seat1: 1, seat2: 3, seat1GamesWon: 0, seat2GamesWon: 2 },
    ];
    const reversed = [...matches].reverse();
    expect(hashMatches(matches)).toBe(hashMatches(reversed));
  });
});

describe("compareDomainHash", () => {
  it("returns 'skip' when hashes match", () => {
    expect(compareDomainHash("abc123", "abc123")).toBe("skip");
  });

  it("returns 'replace' when hashes differ", () => {
    expect(compareDomainHash("abc123", "def456")).toBe("replace");
  });

  it("returns 'replace' when stored hash is null (first sync)", () => {
    expect(compareDomainHash("abc123", null)).toBe("replace");
  });
});
