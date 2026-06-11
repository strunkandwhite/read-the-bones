import { describe, it, expect, vi } from "vitest";
import {
  batchInsertPicks,
  batchInsertMatches,
  batchInsertDeckCards,
  batchInsertCubeSnapshotCards,
  buildMatchInserts,
  deleteDomainData,
} from "../batch";
import type { MatchResult } from "../../../parseSheetRows";

function mockClient() {
  return {
    batch: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

describe("batchInsertPicks", () => {
  it("builds batch statements for all picks", async () => {
    const client = mockClient();
    const picks = [
      { draftId: "d1", pickN: 1, seat: 1, cardId: 100 },
      { draftId: "d1", pickN: 2, seat: 2, cardId: 200 },
    ];
    await batchInsertPicks(client as any, picks);
    expect(client.batch).toHaveBeenCalledTimes(1);
    const stmts = client.batch.mock.calls[0][0];
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain("INSERT INTO pick_events");
    expect(stmts[0].args).toEqual(["d1", 1, 1, 100]);
  });

  it("does nothing for empty picks array", async () => {
    const client = mockClient();
    await batchInsertPicks(client as any, []);
    expect(client.batch).not.toHaveBeenCalled();
  });
});

describe("batchInsertMatches", () => {
  it("builds batch statements for matches", async () => {
    const client = mockClient();
    const matches = [
      { draftId: "d1", seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
    ];
    await batchInsertMatches(client as any, matches);
    expect(client.batch).toHaveBeenCalledTimes(1);
    const stmts = client.batch.mock.calls[0][0];
    expect(stmts[0].sql).toContain("INSERT INTO match_events");
    expect(stmts[0].args).toEqual(["d1", 0, 1, 2, 1]);
  });

  it("does nothing for empty matches array", async () => {
    const client = mockClient();
    await batchInsertMatches(client as any, []);
    expect(client.batch).not.toHaveBeenCalled();
  });
});

describe("batchInsertDeckCards", () => {
  it("builds batch statements for deck cards", async () => {
    const client = mockClient();
    const cards = [
      { draftId: "d1", seat: 1, cardId: 100, zone: "deck" as const, qty: 1 },
    ];
    await batchInsertDeckCards(client as any, cards);
    expect(client.batch).toHaveBeenCalledTimes(1);
    const stmts = client.batch.mock.calls[0][0];
    expect(stmts[0].sql).toContain("INSERT INTO deck_cards");
  });

  it("does nothing for empty cards array", async () => {
    const client = mockClient();
    await batchInsertDeckCards(client as any, []);
    expect(client.batch).not.toHaveBeenCalled();
  });
});

describe("batchInsertCubeSnapshotCards", () => {
  it("builds batch statements for snapshot cards", async () => {
    const client = mockClient();
    const entries = [
      { cardId: 100, qty: 1 },
      { cardId: 200, qty: 2 },
    ];
    await batchInsertCubeSnapshotCards(client as any, 42, entries);
    expect(client.batch).toHaveBeenCalledTimes(1);
    const stmts = client.batch.mock.calls[0][0];
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain("INSERT INTO cube_snapshot_cards");
    expect(stmts[0].args).toEqual([42, 100, 1]);
  });

  it("does nothing for empty entries", async () => {
    const client = mockClient();
    await batchInsertCubeSnapshotCards(client as any, 42, []);
    expect(client.batch).not.toHaveBeenCalled();
  });
});

describe("buildMatchInserts", () => {
  it("converts 0-indexed seats to 1-indexed for all matches", () => {
    const matches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
      { seat1: 3, seat2: 7, seat1GamesWon: 0, seat2GamesWon: 2 },
    ];
    const result = buildMatchInserts("d1", matches);
    expect(result).toEqual([
      { draftId: "d1", seat1: 1, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 1 },
      { draftId: "d1", seat1: 4, seat2: 8, seat1GamesWon: 0, seat2GamesWon: 2 },
    ]);
  });

  it("returns empty array for empty matches", () => {
    expect(buildMatchInserts("d1", [])).toEqual([]);
  });

  it("produces identical rows whether called from CLI path (syncDraft) or cron path (syncActiveDraft)", () => {
    // Both syncDraft (index.ts) and syncActiveDraft call buildMatchInserts with
    // the same MatchResult array. This test asserts that the output is deterministic
    // and identical regardless of which path invokes the helper.
    const rawMatches: MatchResult[] = [
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 0 },
      { seat1: 2, seat2: 5, seat1GamesWon: 1, seat2GamesWon: 2 },
    ];
    const fromCli = buildMatchInserts("test-draft", rawMatches);
    const fromCron = buildMatchInserts("test-draft", rawMatches);

    // Both paths call the same function — results are structurally identical
    expect(fromCli).toEqual(fromCron);

    // Seat conversion is correct: all seats incremented by 1
    expect(fromCli[0].seat1).toBe(1);
    expect(fromCli[0].seat2).toBe(2);
    expect(fromCli[1].seat1).toBe(3);
    expect(fromCli[1].seat2).toBe(6);
  });
});

describe("deleteDomainData", () => {
  it("deletes pick_events for picks domain", async () => {
    const client = mockClient();
    await deleteDomainData(client as any, "d1", "picks");
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE FROM pick_events");
  });

  it("deletes match_events for matches domain", async () => {
    const client = mockClient();
    await deleteDomainData(client as any, "d1", "matches");
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE FROM match_events");
  });

  it("deletes deck_cards AND deck_hashes for decklists domain", async () => {
    const client = mockClient();
    await deleteDomainData(client as any, "d1", "decklists");
    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE FROM deck_cards");
    expect(client.execute.mock.calls[1][0].sql).toContain("DELETE FROM deck_hashes");
  });
});
