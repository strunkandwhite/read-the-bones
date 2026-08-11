/**
 * Tests for incremental pick ingestion and sync lock management.
 * These functions live in core/db/sync/incremental.ts and core/db/sync/lock.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectNewPicks,
  detectRemovedPicks,
  detectChangedPicks,
  getDbPicks,
  resolveCardNameToId,
  insertNewPicks,
  applyChangedPicks,
  setDraftPhase,
  incrementalIngest,
} from "../db/sync/incremental";
import { fetchCard } from "../scryfallApi";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getSyncStatus,
  getActiveDrafts,
  completeAgedPlayingDrafts,
} from "../db/sync/lock";
import type { CardPick } from "../types";

// Mock Scryfall fetch to avoid network calls in tests
vi.mock("../scryfallApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../scryfallApi")>();
  return {
    ...actual,
    fetchCard: vi.fn().mockResolvedValue(null),
    fetchCardFuzzy: vi.fn().mockResolvedValue(null),
  };
});

// Replace the real 75ms Scryfall rate-limit sleep with a no-op so tests run at
// full speed without depending on real wall-clock time.
vi.mock("../utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils")>();
  return { ...actual, sleep: vi.fn().mockResolvedValue(undefined) };
});

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
  it("returns only picks whose positions are not already in the database", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
    ];
    const result = detectNewPicks(allPicks, new Set([1]));
    expect(result).toHaveLength(2);
    expect(result[0].cardName).toBe("Counterspell");
    expect(result[1].cardName).toBe("Swords to Plowshares");
  });

  it("includes back-filled picks in gaps below the database max", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
      pick("Path to Exile", 4, 1),
    ];
    const result = detectNewPicks(allPicks, new Set([1, 2, 4]));
    expect(result).toHaveLength(1);
    expect(result[0].cardName).toBe("Swords to Plowshares");
    expect(result[0].pickPosition).toBe(3);
  });

  it("returns all picks when the database has none", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, new Set());
    expect(result).toHaveLength(1);
  });

  it("returns empty array when all positions are present", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, new Set([1, 2, 3, 4, 5]));
    expect(result).toHaveLength(0);
  });
});

describe("detectRemovedPicks", () => {
  it("returns DB positions missing from the sheet", () => {
    expect(detectRemovedPicks(new Set([1, 2]), [1, 2, 3, 5])).toEqual([3, 5]);
  });

  it("returns empty when the sheet covers every DB position", () => {
    expect(detectRemovedPicks(new Set([1, 2, 3]), [1, 2])).toEqual([]);
  });
});

describe("getDbPicks", () => {
  it("returns empty map when no picks exist", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await getDbPicks(client as any, "draft-1")).toEqual(new Map());
  });

  it("returns stored picks keyed by position with seat, card id, and name", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" },
          { pick_n: 2, seat: 2, card_id: 20, name: "Counterspell" },
        ],
      }),
    };
    const result = await getDbPicks(client as any, "draft-1");
    expect(result.get(1)).toEqual({ seat: 1, cardId: 10, cardName: "Lightning Bolt" });
    expect(result.get(2)).toEqual({ seat: 2, cardId: 20, cardName: "Counterspell" });
  });
});

describe("detectChangedPicks", () => {
  // Structurally matches the module-internal DbPick shape
  const db = (seat: number, cardId: number, cardName: string) => ({
    seat,
    cardId,
    cardName,
  });

  it("flags a position whose card name changed in the sheet", () => {
    const changes = detectChangedPicks(
      [pick("Fiery Islet", 342, 4)],
      new Map([[342, db(5, 99, "Thundering Falls")]])
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].pick.cardName).toBe("Fiery Islet");
    expect(changes[0].dbCardId).toBe(99);
  });

  it("does not flag unchanged picks (case-insensitive)", () => {
    expect(
      detectChangedPicks(
        [pick("lightning bolt", 1, 0)],
        new Map([[1, db(1, 10, "Lightning Bolt")]])
      )
    ).toEqual([]);
  });

  it("does not flag a front-face name against a stored DFC name", () => {
    expect(
      detectChangedPicks(
        [pick("Brazen Borrower", 1, 0)],
        new Map([[1, db(1, 10, "Brazen Borrower // Petty Theft")]])
      )
    ).toEqual([]);
  });

  it("flags a seat change even when the card matches", () => {
    const changes = detectChangedPicks(
      [pick("Lightning Bolt", 1, 3)], // sheet drafter index 3 → stored seat 4, DB has seat 1
      new Map([[1, db(1, 10, "Lightning Bolt")]])
    );
    expect(changes).toHaveLength(1);
  });

  it("ignores positions not in the database", () => {
    expect(detectChangedPicks([pick("Lightning Bolt", 7, 0)], new Map())).toEqual([]);
  });
});

describe("applyChangedPicks", () => {
  it("updates card_id and seat when the resolved card differs", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Fiery Islet", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 1, unresolved: 0 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events")
    );
    expect(updateCall![0].sql).toContain("SET card_id = ?, seat = ?");
    expect(updateCall![0].args).toEqual([55, 5, "draft-1", 342]);
  });

  it("is a no-op when the sheet name resolves to the stored card (alias)", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 99 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Fiery Islet", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 0, unresolved: 0 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events")
    );
    expect(updateCall).toBeUndefined();
  });

  it("counts unresolvable names without updating", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    const result = await applyChangedPicks(client as any, "draft-1", [
      { pick: pick("Not A Real Card", 342, 4), dbCardId: 99, dbSeat: 5 },
    ]);
    expect(result).toEqual({ updated: 0, unresolved: 1 });
  });
});

describe("resolveCardNameToId", () => {
  it("returns card_id for exact match", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ card_id: 123 }] }),
    };
    expect(await resolveCardNameToId(client as any, "Lightning Bolt")).toBe(123);
  });

  it("falls back to front-face DFC match", async () => {
    const client = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [{ card_id: 456 }] }), // front-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Fable of the Mirror-Breaker")).toBe(456);
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to back-face DFC match", async () => {
    const client = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
        .mockResolvedValueOnce({ rows: [{ card_id: 789 }] }), // back-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Death")).toBe(789);
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it("falls back to alias table lookup", async () => {
    const client = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
        .mockResolvedValueOnce({ rows: [] }) // back-face DFC fails
        .mockResolvedValueOnce({ rows: [{ card_id: 101 }] }), // alias match
    };
    expect(await resolveCardNameToId(client as any, "troll of khazad-dum")).toBe(101);
    expect(client.execute).toHaveBeenCalledTimes(4);
  });

  it("returns null when all lookups fail", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    expect(await resolveCardNameToId(client as any, "Not A Card")).toBeNull();
    // 4 DB queries: exact, front-face DFC, back-face DFC, alias table
    expect(client.execute).toHaveBeenCalledTimes(4);
  });

  describe("Scryfall fallback alias persistence", () => {
    beforeEach(() => {
      vi.mocked(fetchCard).mockResolvedValue({ name: "Ragavan, Nimble Pilferer" } as any);
    });

    it("persists the resolved alias by default", async () => {
      const client = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // exact match fails
          .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
          .mockResolvedValueOnce({ rows: [] }) // back-face DFC fails
          .mockResolvedValueOnce({ rows: [] }) // alias table fails
          .mockResolvedValueOnce({ rows: [{ card_id: 555 }] }) // Scryfall name found in cards
          .mockResolvedValueOnce({ rows: [] }), // INSERT OR IGNORE INTO card_aliases
      };
      const cardId = await resolveCardNameToId(client as any, "ragavan nimble pilfrer");
      expect(cardId).toBe(555);
      expect(client.execute).toHaveBeenCalledTimes(6);
      const aliasInsert = client.execute.mock.calls[5][0];
      expect(aliasInsert.sql).toContain("INSERT OR IGNORE INTO card_aliases");
    });

    it("does not persist the alias when persistAlias is false, e.g. under --dry-run", async () => {
      const client = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // exact match fails
          .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
          .mockResolvedValueOnce({ rows: [] }) // back-face DFC fails
          .mockResolvedValueOnce({ rows: [] }) // alias table fails
          .mockResolvedValueOnce({ rows: [{ card_id: 555 }] }), // Scryfall name found in cards
      };
      const cardId = await resolveCardNameToId(client as any, "ragavan nimble pilfrer", false);
      // Resolution still succeeds — a dry run must still be able to report
      // the card as resolved — but no INSERT is issued.
      expect(cardId).toBe(555);
      expect(client.execute).toHaveBeenCalledTimes(5);
      const sqlCalls = client.execute.mock.calls.map((call) => call[0].sql);
      expect(sqlCalls.some((sql: string) => sql.includes("INSERT"))).toBe(false);
    });
  });
});

// Helper to create a mock client for the DB-backed functions
function createMockClient() {
  return {
    execute: vi.fn(),
    batch: vi.fn(),
  };
}

describe("insertNewPicks", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    vi.clearAllMocks();
  });

  it("returns 0 when newPicks is empty", async () => {
    const result = await insertNewPicks(client as any, "draft-1", []);
    expect(result).toEqual({ inserted: 0, unresolved: 0 });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("batch-resolves card names and inserts picks", async () => {
    // 1. Batch name resolution query
    client.execute.mockResolvedValueOnce({
      rows: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    // 2. batch() for inserting picks
    client.batch.mockResolvedValueOnce(undefined);

    const picks: CardPick[] = [pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)];
    const result = await insertNewPicks(client as any, "draft-1", picks);

    expect(result).toEqual({ inserted: 2, unresolved: 0 });
    expect(client.batch).toHaveBeenCalledTimes(1);
    const batchArgs = client.batch.mock.calls[0][0];
    expect(batchArgs).toHaveLength(2);
    // Seats are converted from 0-indexed to 1-indexed
    expect(batchArgs[0].args).toEqual(["draft-1", 1, 1, 10, "sheet"]);
    expect(batchArgs[1].args).toEqual(["draft-1", 2, 2, 20, "sheet"]);
  });

  it("stamps sheet provenance and a created_at timestamp on every insert", async () => {
    // This is the statement the every-minute cron sync (syncActiveDraft ->
    // incrementalIngest -> insertNewPicks) actually executes, so a NULL here
    // means sheet drafts never get provenance in production.
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    client.batch.mockResolvedValueOnce(undefined);

    await insertNewPicks(client as any, "draft-1", [pick("Lightning Bolt", 1, 0)]);

    const stmt = client.batch.mock.calls[0][0][0];
    expect(stmt.sql).toContain("source, created_at");
    expect(stmt.sql).toContain("datetime('now')");
    expect(stmt.args).toEqual(["draft-1", 1, 1, 10, "sheet"]);
  });

  it("falls back to fuzzy resolution, and counts picks unresolved when that also fails", async () => {
    // Exact-match batch query returns only Lightning Bolt; "Mystery Card"
    // must go through resolveCardNameToId (whose Scryfall fallback is mocked
    // to return null), landing in unresolved.
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("IN (")) {
          return Promise.resolve({ rows: [{ card_id: 1, name: "Lightning Bolt" }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await insertNewPicks(client as any, "test-draft", [
      pick("Lightning Bolt", 1, 0),
      pick("Mystery Card", 2, 1),
    ]);
    expect(result).toEqual({ inserted: 1, unresolved: 1 });
    expect(client.batch.mock.calls[0][0]).toHaveLength(1);
  });

  it("inserts via the fuzzy resolver when the exact batch query misses", async () => {
    // Batch query misses, but the per-name exact lookup inside
    // resolveCardNameToId hits — e.g. stored DFC name "Front // Back".
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("IN (")) return Promise.resolve({ rows: [] });
        if (sql.includes("LIKE LOWER(? || ' // %')")) {
          return Promise.resolve({ rows: [{ card_id: 42 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await insertNewPicks(client as any, "test-draft", [
      pick("Brazen Borrower", 1, 0),
    ]);
    expect(result).toEqual({ inserted: 1, unresolved: 0 });
    expect(client.batch.mock.calls[0][0][0].args).toEqual(["test-draft", 1, 1, 42, "sheet"]);
  });
});

describe("setDraftPhase", () => {
  it("writes the given phase for the draft", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    await setDraftPhase(client as any, "test-draft", "playing");
    expect(client.execute).toHaveBeenCalledWith({
      sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
      args: ["playing", "test-draft"],
    });
  });
});

describe("incrementalIngest", () => {
  function parsed(picks: CardPick[], isComplete = false) {
    return {
      picks,
      numDrafters: 2,
      drafterNames: ["Alice", "Bob"],
      isComplete,
      doublePickStartsAfterRound: null,
      picksPerPlayer: 1,
    };
  }

  // Routes the mock client by SQL shape: stored picks, exact-name batch
  // resolution, and a call log for inserts/updates/hash writes.
  function reconcilingClient(opts: {
    dbPicks: Array<{ pick_n: number; seat: number; card_id: number; name: string }>;
    cards: Array<{ card_id: number; name: string }>;
  }) {
    return {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("JOIN cards")) return Promise.resolve({ rows: opts.dbPicks });
        if (sql.includes("IN (")) return Promise.resolve({ rows: opts.cards });
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
  }

  it("returns no_change without touching the DB when the picks hash matches", async () => {
    const { hashPicks } = await import("../db/sync/domains");
    const picks = [pick("Lightning Bolt", 1, 0)];
    const client = reconcilingClient({ dbPicks: [], cards: [] });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed(picks),
      hashPicks(picks)
    );
    expect(result).toEqual({ status: "no_change", picksInserted: 0, picksUpdated: 0 });
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("returns no_change when the sheet has no picks", async () => {
    const client = reconcilingClient({ dbPicks: [], cards: [] });
    const result = await incrementalIngest(client as any, "test-draft", parsed([]), null);
    expect(result.status).toBe("no_change");
    expect(client.execute).not.toHaveBeenCalled();
  });

  it("returns diverged when the DB has positions the sheet lost", async () => {
    const client = reconcilingClient({
      dbPicks: [
        { pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_id: 20, name: "Counterspell" },
      ],
      cards: [],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0)]),
      null
    );
    expect(result.status).toBe("diverged");
    expect(client.batch).not.toHaveBeenCalled();
  });

  it("inserts missing picks and updates the stored picks hash", async () => {
    const client = reconcilingClient({
      dbPicks: [{ pick_n: 1, seat: 1, card_id: 10, name: "Lightning Bolt" }],
      cards: [{ card_id: 20, name: "Counterspell" }],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)]),
      "stale-hash"
    );
    expect(result).toEqual({ status: "updated", picksInserted: 1, picksUpdated: 0 });
    const hashWrite = client.execute.mock.calls.find(([p]: any[]) => p.sql.includes("picks_hash"));
    expect(hashWrite).toBeDefined();
  });

  it("updates a position whose card changed in the sheet", async () => {
    const client = {
      execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
        if (sql.includes("JOIN cards")) {
          return Promise.resolve({
            rows: [{ pick_n: 342, seat: 5, card_id: 99, name: "Thundering Falls" }],
          });
        }
        if (sql.includes("LOWER(name) = LOWER(?)")) {
          return Promise.resolve({ rows: [{ card_id: 55 }] });
        }
        return Promise.resolve({ rows: [] });
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Fiery Islet", 342, 4)]),
      "stale-hash"
    );
    expect(result).toEqual({ status: "updated", picksInserted: 0, picksUpdated: 1 });
    const updateCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE pick_events")
    );
    expect(updateCall![0].args).toEqual([55, 5, "test-draft", 342]);
  });

  it("does not persist the picks hash while any pick is unresolved", async () => {
    const client = reconcilingClient({
      dbPicks: [],
      cards: [], // nothing resolves; Scryfall fallback mocked to null
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Mystery Card", 1, 0)]),
      "stale-hash"
    );
    expect(result.picksInserted).toBe(0);
    const hashWrite = client.execute.mock.calls.find(([p]: any[]) => p.sql.includes("picks_hash"));
    expect(hashWrite).toBeUndefined();
  });

  it("does not write any phase — the caller owns the lifecycle decision", async () => {
    const client = reconcilingClient({
      dbPicks: [],
      cards: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    const result = await incrementalIngest(
      client as any,
      "test-draft",
      parsed([pick("Lightning Bolt", 1, 0), pick("Counterspell", 2, 1)], true),
      null
    );
    expect(result.status).toBe("updated");
    const phaseCall = client.execute.mock.calls.find(([p]: any[]) =>
      p.sql.includes("UPDATE drafts SET phase")
    );
    expect(phaseCall).toBeUndefined();
  });
});

describe("acquireSyncLock", () => {
  it("returns true when lock is acquired (rowsAffected > 0)", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    expect(await acquireSyncLock(client as any)).toBe(true);
  });

  it("returns false when lock is held by another sync", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 0 });

    expect(await acquireSyncLock(client as any)).toBe(false);
  });
});

describe("releaseSyncLock", () => {
  it("clears the sync_lock value", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    await releaseSyncLock(client as any);

    expect(client.execute).toHaveBeenCalledWith({
      sql: "UPDATE ingestion_meta SET value = '' WHERE key = 'sync_lock'",
      args: [],
    });
  });
});

describe("updateLastSyncedAt", () => {
  it("updates the last_synced_at timestamp and returns it", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    const result = await updateLastSyncedAt(client as any);

    expect(typeof result).toBe("string");
    // Should be a recent Unix timestamp
    const ts = parseInt(result, 10);
    expect(ts).toBeGreaterThan(0);
    expect(client.execute).toHaveBeenCalledTimes(1);
  });
});

describe("getSyncStatus", () => {
  it("returns default values when no rows exist", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getSyncStatus(client as any);
    expect(result).toEqual({ lastSyncedAt: "0", syncInProgress: false });
  });

  it("returns lastSyncedAt from database", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({
      rows: [{ key: "last_synced_at", value: "1700000000" }],
    });

    const result = await getSyncStatus(client as any);
    expect(result.lastSyncedAt).toBe("1700000000");
    expect(result.syncInProgress).toBe(false);
  });

  it("detects active sync lock", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({
      rows: [
        { key: "last_synced_at", value: "1700000000" },
        { key: "sync_lock", value: String(now - 10) }, // 10 seconds ago, within 120s timeout
      ],
    });

    const result = await getSyncStatus(client as any);
    expect(result.syncInProgress).toBe(true);
  });

  it("ignores stale sync lock", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({
      rows: [
        { key: "sync_lock", value: String(now - 300) }, // 5 minutes ago, beyond 120s timeout
      ],
    });

    const result = await getSyncStatus(client as any);
    expect(result.syncInProgress).toBe(false);
  });
});

describe("getActiveDrafts", () => {
  it("selects setup, drafting, and playing sheet drafts", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ draft_id: "d1", sheet_id: "s1" }],
      }),
    };
    const result = await getActiveDrafts(client as any);
    expect(result).toEqual([{ draftId: "d1", sheetId: "s1" }]);
    const sql = client.execute.mock.calls[0][0].sql as string;
    expect(sql).toContain("'playing'");
    expect(sql).toContain("sheet_id IS NOT NULL");
  });
});

describe("completeAgedPlayingDrafts", () => {
  it("completes sheet drafts stuck in playing past the age window", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [], rowsAffected: 2 }),
    };
    const count = await completeAgedPlayingDrafts(client as any);
    expect(count).toBe(2);
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("SET phase = 'complete'");
    expect(call.sql).toContain("phase = 'playing'");
    expect(call.sql).toContain("sheet_id IS NOT NULL");
    expect(call.args).toEqual(["-60 days"]);
  });
});
