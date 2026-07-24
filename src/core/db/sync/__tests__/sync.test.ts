// src/core/db/sync/__tests__/sync.test.ts
import { describe, it, expect, vi } from "vitest";
import { syncDraft } from "../index";
import { CardCache } from "../card-cache";
import type { DraftSheetRawData } from "../../../sheets";

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type MockExecuteHandler = (params: { sql: string; args: unknown[] }) => {
  rows: Record<string, unknown>[];
  lastInsertRowid?: bigint;
};

function mockClient(handler?: MockExecuteHandler) {
  const defaultHandler: MockExecuteHandler = () => ({ rows: [] });
  const executeHandler = handler ?? defaultHandler;

  return {
    execute: vi.fn().mockImplementation((params: { sql: string; args: unknown[] }) => {
      return Promise.resolve(executeHandler(params));
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Test data builders
// ---------------------------------------------------------------------------

function buildPoolRows(cardNames: string[]): string[][] {
  return [
    ["", "Card Name", "", "Color"], // header
    ...cardNames.map((name) => ["", name, "", ""]),
  ];
}

function buildPickRows(
  drafterNames: string[],
  picks: string[][], // rows of [roundNum, arrow, ...cardNames, ...colors]
): string[][] {
  return [
    [], // row 0
    [], // row 1
    ["", "", ...drafterNames, "↩"], // row 2: drafter names
    ...picks, // row 3+: pick data
  ];
}

function buildMatchRows(
  matchData: Array<[string, number, string, number]>,
): string[][] {
  return [
    [], // row 0
    [], // row 1
    [], // row 2
    ...matchData.map(([p1, p1wins, p2, p2wins]) => [
      "",
      p1,
      String(p1wins),
      "VS",
      String(p2wins),
      p2,
    ]),
  ];
}

// Pre-populate a card cache with known cards
function populatedCache(entries: Array<[string, number]>): CardCache {
  const cache = new CardCache();
  for (const [name, id] of entries) {
    cache.set(name, id);
  }
  return cache;
}

const emptyScryfallCache = new Map();
const emptyOptOuts = new Set<string>();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncDraft", () => {
  describe("skip behavior when hashes match", () => {
    it("skips all domains when hashes match", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: null,
      };

      // Pre-compute the expected hashes to return from the mock
      const { hashPool, hashPicks } = await import("../domains");
      const { parsePoolRows, parsePickRows } = await import("../../../parseSheetRows");

      const poolNames = parsePoolRows(rawData.pool!);
      const poolHash = hashPool(poolNames);
      const parsed = parsePickRows(rawData.picks!, "test-draft");
      const pickedCards = parsed.picks.filter((p) => p.wasPicked);
      const picksHash = hashPicks(pickedCards);

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash,
              picks_hash: picksHash,
              matches_hash: null,
            }],
          };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.poolAction).toBe("skip");
      expect(result.picksAction).toBe("skip");
      expect(result.matchesAction).toBe("skip");

      // No DELETE calls should have been made
      const executeCalls = client.execute.mock.calls.map(
        (c: any[]) => c[0].sql as string,
      );
      const deleteCalls = executeCalls.filter((sql: string) =>
        sql.includes("DELETE"),
      );
      expect(deleteCalls).toHaveLength(0);

      // No batch INSERT calls for picks/matches
      expect(client.batch).not.toHaveBeenCalled();
    });
  });

  describe("replace behavior when hashes differ", () => {
    it("replaces picks when pick hash differs", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: null,
      };

      // Return matching pool hash but mismatched picks hash
      const { hashPool } = await import("../domains");
      const { parsePoolRows } = await import("../../../parseSheetRows");
      const poolNames = parsePoolRows(rawData.pool!);
      const poolHash = hashPool(poolNames);

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash,
              picks_hash: "stale-hash",
              matches_hash: null,
            }],
          };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [{ cube_snapshot_id: 1 }] };
        }
        if (params.sql.includes("SELECT card_id, qty FROM cube_snapshot_cards")) {
          return {
            rows: [
              { card_id: 1, qty: 1 },
              { card_id: 2, qty: 1 },
            ],
          };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.poolAction).toBe("skip");
      expect(result.picksAction).toBe("replace");
      expect(result.picksCount).toBe(2);

      // Verify DELETE was called for picks
      const executeCalls = client.execute.mock.calls.map(
        (c: any[]) => c[0].sql as string,
      );
      expect(executeCalls.some((sql: string) => sql.includes("DELETE FROM pick_events"))).toBe(true);

      // Verify batch INSERT was called
      expect(client.batch).toHaveBeenCalled();
      const batchStmts = client.batch.mock.calls[0][0];
      expect(batchStmts.length).toBe(2);
      expect(batchStmts[0].sql).toContain("INSERT INTO pick_events");
    });

    it("replaces matches when match hash differs", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: buildMatchRows([
          ["Alice", 2, "Bob", 1],
        ]),
      };

      const { hashPool, hashPicks } = await import("../domains");
      const { parsePoolRows, parsePickRows } = await import("../../../parseSheetRows");
      const poolNames = parsePoolRows(rawData.pool!);
      const poolHash = hashPool(poolNames);
      const parsed = parsePickRows(rawData.picks!, "test-draft");
      const pickedCards = parsed.picks.filter((p) => p.wasPicked);
      const picksHash = hashPicks(pickedCards);

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash,
              picks_hash: picksHash,
              matches_hash: "stale-match-hash",
            }],
          };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.matchesAction).toBe("replace");
      expect(result.matchesCount).toBe(1);

      // Verify the match insert used 1-indexed seats
      const batchStmts = client.batch.mock.calls[0][0];
      expect(batchStmts[0].args[1]).toBe(1); // seat1: 0+1
      expect(batchStmts[0].args[2]).toBe(2); // seat2: 1+1
    });
  });

  describe("first sync with null hashes", () => {
    it("replaces all domains when stored hashes are null", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "", "R", ""],
        ]),
        matches: buildMatchRows([["Alice", 2, "Bob", 0]]),
      };

      const client = mockClient((params) => {
        // No stored hashes — first sync
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: null,
              picks_hash: null,
              matches_hash: null,
            }],
          };
        }
        // ensureCubeSnapshot: no existing snapshot
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        // INSERT cube_snapshots returns new ID
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(42) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([["Lightning Bolt", 1]]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.poolAction).toBe("replace");
      expect(result.picksAction).toBe("replace");
      expect(result.matchesAction).toBe("replace");
    });

    it("returns skip for domains with no data even on first sync", async () => {
      // No pool, no picks, no matches
      const rawData: DraftSheetRawData = {
        pool: null,
        picks: null,
        matches: null,
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        return { rows: [] };
      });

      const cache = new CardCache();

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.poolAction).toBe("skip");
      expect(result.picksAction).toBe("skip");
      expect(result.matchesAction).toBe("skip");
    });
  });

  describe("completion detection", () => {
    it("marks draft as complete when picks indicate completion", async () => {
      // Build picks with ✪ marker in last row and filled picks
      const picksRows = [
        [], // row 0
        [], // row 1
        ["", "", "Alice", "Bob", "↩"], // row 2: drafter names
        ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"], // row 3: pick
        ["✪", "→", "Dark Ritual", "Swords to Plowshares", "B", "W"], // ✪ row with picks = complete
      ];

      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell", "Dark Ritual", "Swords to Plowshares"]),
        picks: picksRows,
        matches: null,
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
        ["Dark Ritual", 3],
        ["Swords to Plowshares", 4],
      ]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.markedComplete).toBe(true);

      // Verify phase was set to 'complete'
      const executeCalls = client.execute.mock.calls;
      const completionUpdate = executeCalls.find(
        (c: any[]) => (c[0].sql as string).includes("UPDATE drafts SET phase"),
      );
      expect(completionUpdate).toBeDefined();
      expect(completionUpdate![0].args[0]).toBe('complete');
    });
  });

  describe("phase protection — never demote playing/complete", () => {
    function buildCompletePickRows(): string[][] {
      // ✪ marker in last row = draft complete
      return [
        [],
        [],
        ["", "", "Alice", "Bob", "↩"],
        ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ["✪", "→", "Dark Ritual", "Swords to Plowshares", "B", "W"],
      ];
    }

    function buildIncompletePickRows(): string[][] {
      // No ✪ marker = still drafting
      return [
        [],
        [],
        ["", "", "Alice", "Bob", "↩"],
        ["1", "→", "Lightning Bolt", "", "R", ""],
      ];
    }

    it("does NOT demote a 'playing' draft back to 'drafting' on re-sync", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildIncompletePickRows(), // picks not complete → sync would write 'drafting'
        matches: null,
      };

      const { hashPool: hp, hashPicks: hpk } = await import("../domains");
      const { parsePoolRows: ppr, parsePickRows: ppkr } = await import("../../../parseSheetRows");
      const poolHash = hp(ppr(rawData.pool!));
      const parsed = ppkr(rawData.picks!, "test-draft");
      const picksHash = hpk(parsed.picks.filter((p) => p.wasPicked));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          // Current phase is 'playing' — matches ongoing
          return { rows: [{ pool_hash: poolHash, picks_hash: picksHash, matches_hash: null, phase: "playing" }] };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      await syncDraft(client as any, "test-draft", rawData, cache, emptyScryfallCache, emptyOptOuts);

      // The UPDATE drafts SET phase must NOT have been called with 'drafting'
      const executeCalls = client.execute.mock.calls;
      const demotionCall = executeCalls.find(
        (c: any[]) =>
          (c[0].sql as string).includes("UPDATE drafts SET phase") &&
          c[0].args[0] === "drafting",
      );
      expect(demotionCall).toBeUndefined();
    });

    it("does NOT demote a 'complete' draft back to 'drafting' on re-sync", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildIncompletePickRows(),
        matches: null,
      };

      const { hashPool: hp } = await import("../domains");
      const { parsePoolRows: ppr } = await import("../../../parseSheetRows");
      const poolHash = hp(ppr(rawData.pool!));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: poolHash, picks_hash: "some-hash", matches_hash: null, phase: "complete" }] };
        }
        return { rows: [] };
      });

      const cache = populatedCache([["Lightning Bolt", 1]]);

      await syncDraft(client as any, "test-draft", rawData, cache, emptyScryfallCache, emptyOptOuts);

      const executeCalls = client.execute.mock.calls;
      const demotionCall = executeCalls.find(
        (c: any[]) =>
          (c[0].sql as string).includes("UPDATE drafts SET phase") &&
          c[0].args[0] === "drafting",
      );
      expect(demotionCall).toBeUndefined();
    });

    it("DOES mark a 'playing' draft as 'complete' when picks are finished", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell", "Dark Ritual", "Swords to Plowshares"]),
        picks: buildCompletePickRows(), // ✪ marker = complete
        matches: null,
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          // Draft is currently 'playing' (matches in progress)
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null, phase: "playing" }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
        ["Dark Ritual", 3],
        ["Swords to Plowshares", 4],
      ]);

      const result = await syncDraft(
        client as any, "test-draft", rawData, cache, emptyScryfallCache, emptyOptOuts,
      );

      expect(result.markedComplete).toBe(true);

      const executeCalls = client.execute.mock.calls;
      const completionUpdate = executeCalls.find(
        (c: any[]) => (c[0].sql as string).includes("UPDATE drafts SET phase"),
      );
      expect(completionUpdate).toBeDefined();
      expect(completionUpdate![0].args[0]).toBe("complete");
    });
  });

  describe("seat indexing", () => {
    it("converts 0-indexed seats to 1-indexed for picks", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: null,
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      // Find the batch call for picks
      const batchCalls = client.batch.mock.calls;
      const picksBatch = batchCalls.find((c: any[]) =>
        c[0]?.[0]?.sql?.includes("INSERT INTO pick_events"),
      );
      expect(picksBatch).toBeDefined();

      // Alice (seat 0) should be seat 1 in the DB
      const alicePick = picksBatch![0].find(
        (s: any) => s.args[3] === 1, // card_id for Lightning Bolt
      );
      expect(alicePick.args[2]).toBe(1); // seat = 0 + 1

      // Bob (seat 1) should be seat 2 in the DB
      const bobPick = picksBatch![0].find(
        (s: any) => s.args[3] === 2, // card_id for Counterspell
      );
      expect(bobPick.args[2]).toBe(2); // seat = 1 + 1
    });
  });

  describe("opt-outs", () => {
    it("applies opt-outs for matching drafter names", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "", "R", ""],
        ]),
        matches: null,
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      const cache = populatedCache([["Lightning Bolt", 1]]);
      const optOuts = new Set(["alice"]); // lowercase

      await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        optOuts,
      );

      // Verify insertOptOuts was called (it runs INSERT OR IGNORE)
      const executeCalls = client.execute.mock.calls;
      const optOutCall = executeCalls.find(
        (c: any[]) => (c[0].sql as string).includes("privacy_opt_outs"),
      );
      expect(optOutCall).toBeDefined();
    });
  });

  describe("error handling", () => {
    it("returns error in result without throwing", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildPickRows(["Alice"], [
          ["1", "→", "Lightning Bolt", "R"],
        ]),
        matches: null,
      };

      // Client that throws on certain operations
      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          throw new Error("DB connection failed");
        }
        return { rows: [] };
      });

      const cache = populatedCache([["Lightning Bolt", 1]]);

      // Should not throw
      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.error).toBe("DB connection failed");
      expect(result.draftId).toBe("test-draft");
    });
  });

  describe("dryRun mode", () => {
    it("computes hashes but does not write anything", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: buildMatchRows([["Alice", 2, "Bob", 0]]),
      };

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
        { dryRun: true },
      );

      // Should report replace actions
      expect(result.poolAction).toBe("replace");
      expect(result.picksAction).toBe("replace");
      expect(result.matchesAction).toBe("replace");

      // But no writes should have happened
      // Only the initial getDomainHashes SELECT should have been called
      expect(client.execute).toHaveBeenCalledTimes(1);
      expect(client.batch).not.toHaveBeenCalled();
    });
  });

  describe("partial-failure invariant: hash NOT updated when batch insert throws", () => {
    it("does not call updateDomainHashes when batchInsertPicks throws", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildPickRows(["Alice"], [
          ["1", "→", "Lightning Bolt", "R"],
        ]),
        matches: null,
      };

      // Return mismatched picks hash to trigger a replace
      const { hashPool: hp } = await import("../domains");
      const { parsePoolRows: ppr } = await import("../../../parseSheetRows");
      const poolHash = hp(ppr(rawData.pool!));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash,
              picks_hash: "stale-picks-hash", // mismatch triggers replace
              matches_hash: null,
            }],
          };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [{ cube_snapshot_id: 1 }] };
        }
        if (params.sql.includes("SELECT card_id, qty FROM cube_snapshot_cards")) {
          return { rows: [{ card_id: 1, qty: 1 }] };
        }
        return { rows: [] };
      });

      // Make batch() throw after deleteDomainData succeeds — simulates a DB
      // error during the pick batch insert
      client.batch.mockRejectedValue(new Error("batch insert failed"));

      const cache = populatedCache([["Lightning Bolt", 1]]);

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      // Error is captured in result, not thrown
      expect(result.error).toContain("batch insert failed");

      // updateDomainHashes must NOT have been called — the hash UPDATE SQL
      // contains "pool_hash" / "picks_hash" / "matches_hash" SET clauses
      const executeCalls = client.execute.mock.calls.map(
        (c: any[]) => c[0].sql as string,
      );
      // The only execute call that writes hashes uses SET picks_hash / pool_hash
      const hashUpdateCalls = executeCalls.filter(
        (sql: string) =>
          sql.includes("SET") &&
          (sql.includes("picks_hash") || sql.includes("pool_hash") || sql.includes("matches_hash")),
      );
      expect(hashUpdateCalls).toHaveLength(0);
    });
  });

  describe("hash-persistence invariant: updateDomainHashes called with new hash after replace", () => {
    it("calls updateDomainHashes with the newly computed picks hash after a successful replace", async () => {
      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt", "Counterspell"]),
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
        ]),
        matches: null,
      };

      const { hashPool: hp, hashPicks: hpk } = await import("../domains");
      const { parsePoolRows: ppr, parsePickRows: ppkr } = await import("../../../parseSheetRows");
      const poolHash = hp(ppr(rawData.pool!));
      const parsed = ppkr(rawData.picks!, "test-draft");
      const expectedPicksHash = hpk(parsed.picks.filter((p) => p.wasPicked));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash, // pool unchanged
              picks_hash: "stale-picks-hash", // triggers replace
              matches_hash: null,
            }],
          };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [{ cube_snapshot_id: 1 }] };
        }
        if (params.sql.includes("SELECT card_id, qty FROM cube_snapshot_cards")) {
          return {
            rows: [
              { card_id: 1, qty: 1 },
              { card_id: 2, qty: 1 },
            ],
          };
        }
        return { rows: [] };
      });

      const cache = populatedCache([
        ["Lightning Bolt", 1],
        ["Counterspell", 2],
      ]);

      await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      // Find the execute call that writes the hash update
      const executeCalls = client.execute.mock.calls;
      const hashUpdateCall = executeCalls.find(
        (c: any[]) =>
          (c[0].sql as string).includes("SET") &&
          (c[0].sql as string).includes("picks_hash"),
      );

      expect(hashUpdateCall).toBeDefined();
      // The args for the UPDATE must contain the NEW picks hash, not the stale one
      const updateArgs = hashUpdateCall![0].args as unknown[];
      expect(updateArgs).toContain(expectedPicksHash);
      expect(updateArgs).not.toContain("stale-picks-hash");
    });

    it("does NOT call updateDomainHashes when the domain is skipped (hashes match)", async () => {
      const { hashPool: hp, hashPicks: hpk } = await import("../domains");
      const { parsePoolRows: ppr, parsePickRows: ppkr } = await import("../../../parseSheetRows");

      const rawData: DraftSheetRawData = {
        pool: buildPoolRows(["Lightning Bolt"]),
        picks: buildPickRows(["Alice"], [
          ["1", "→", "Lightning Bolt", "R"],
        ]),
        matches: null,
      };

      const poolHash = hp(ppr(rawData.pool!));
      const parsed = ppkr(rawData.picks!, "test-draft");
      const picksHash = hpk(parsed.picks.filter((p) => p.wasPicked));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return {
            rows: [{
              pool_hash: poolHash,
              picks_hash: picksHash, // matches current → skip
              matches_hash: null,
            }],
          };
        }
        return { rows: [] };
      });

      const cache = populatedCache([["Lightning Bolt", 1]]);

      await syncDraft(
        client as any,
        "test-draft",
        rawData,
        cache,
        emptyScryfallCache,
        emptyOptOuts,
      );

      const executeCalls = client.execute.mock.calls.map(
        (c: any[]) => c[0].sql as string,
      );
      const hashUpdateCalls = executeCalls.filter(
        (sql: string) =>
          sql.includes("SET") &&
          (sql.includes("picks_hash") || sql.includes("pool_hash") || sql.includes("matches_hash")),
      );
      // No hash update — domain was skipped
      expect(hashUpdateCalls).toHaveLength(0);
    });
  });

  describe("double-pick boundary persistence", () => {
    function findDoublePickUpdate(client: ReturnType<typeof mockClient>) {
      return client.execute.mock.calls.find((c: any[]) =>
        (c[0].sql as string).includes("double_pick_after_round"),
      );
    }

    it("writes the sheet's Double Picks After value even when picks are skipped", async () => {
      const rawData: DraftSheetRawData = {
        pool: null,
        picks: buildPickRows(["Alice", "Bob"], [
          ["1", "→", "Lightning Bolt", "Counterspell", "R", "U"],
          ["", "", "", "", "", "", "", "Double Picks After:", "25"],
        ]),
        matches: null,
      };

      // Return the current picks hash so the picks domain is skipped
      const { hashPicks } = await import("../domains");
      const { parsePickRows } = await import("../../../parseSheetRows");
      const parsed = parsePickRows(rawData.picks!, "test-draft");
      const picksHash = hashPicks(parsed.picks.filter((p) => p.wasPicked));

      const client = mockClient((params) => {
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: picksHash, matches_hash: null }] };
        }
        return { rows: [] };
      });

      const result = await syncDraft(
        client as any,
        "test-draft",
        rawData,
        populatedCache([["Lightning Bolt", 1], ["Counterspell", 2]]),
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(result.picksAction).toBe("skip");
      const update = findDoublePickUpdate(client);
      expect(update).toBeDefined();
      expect(update![0].args).toEqual([25, "test-draft"]);
    });

    it("does not touch double_pick_after_round when the Draft tab is missing", async () => {
      const rawData: DraftSheetRawData = { pool: null, picks: null, matches: null };
      const client = mockClient();

      await syncDraft(
        client as any,
        "test-draft",
        rawData,
        populatedCache([]),
        emptyScryfallCache,
        emptyOptOuts,
      );

      expect(findDoublePickUpdate(client)).toBeUndefined();
    });
  });
});
