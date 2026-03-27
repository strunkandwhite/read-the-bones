// src/core/db/sync/__tests__/domains.test.ts
import { describe, it, expect } from "vitest";
import {
  sha256Short,
  computeIngestionHash,
  hashPicks,
  hashPool,
  hashMatches,
  compareDomainHash,
} from "../domains";
import type { CardPick, MatchResult } from "../../../parseSheetRows";

describe("sha256Short", () => {
  it("returns a 16-character hex string", () => {
    const result = sha256Short("test input");
    expect(result).toHaveLength(16);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });
  it("returns same hash for same input", () => {
    expect(sha256Short("hello")).toBe(sha256Short("hello"));
  });
  it("returns different hash for different input", () => {
    expect(sha256Short("a")).not.toBe(sha256Short("b"));
  });
});

describe("computeIngestionHash", () => {
  it("computes hash from draft domain hashes", () => {
    const rows = [{ pool_hash: "abc", picks_hash: "def", matches_hash: "ghi" }];
    const hash = computeIngestionHash(rows);
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });
  it("handles null hashes", () => {
    const rows = [{ pool_hash: null, picks_hash: null, matches_hash: null }];
    const hash = computeIngestionHash(rows);
    expect(hash).toHaveLength(16);
  });
  it("returns different hash for different inputs", () => {
    const rows1 = [{ pool_hash: "a", picks_hash: "b", matches_hash: "c" }];
    const rows2 = [{ pool_hash: "x", picks_hash: "y", matches_hash: "z" }];
    expect(computeIngestionHash(rows1)).not.toBe(computeIngestionHash(rows2));
  });
});

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
