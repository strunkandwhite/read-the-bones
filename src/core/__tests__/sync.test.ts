/**
 * Tests for incremental pick ingestion and sync lock management.
 * These functions live in core/db/sync/incremental.ts and core/db/sync/lock.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectNewPicks,
  detectDivergence,
  getDbPickPositions,
  resolveCardNameToId,
  insertNewPicks,
  markDraftComplete,
  incrementalIngest,
} from "../db/sync/incremental";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getSyncStatus,
  getActiveDrafts,
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

describe("detectDivergence", () => {
  it("detects when CSV has fewer picks than database", () => {
    expect(detectDivergence(3, 5)).toBe(true);
  });

  it("no divergence when CSV has more picks", () => {
    expect(detectDivergence(5, 3)).toBe(false);
  });

  it("no divergence when counts are equal", () => {
    expect(detectDivergence(3, 3)).toBe(false);
  });
});

describe("getDbPickPositions", () => {
  it("returns empty set when no picks exist", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    expect(await getDbPickPositions(client as any, "draft-1")).toEqual(
      new Set(),
    );
  });

  it("returns the set of stored pick positions", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ pick_n: 1 }, { pick_n: 2 }, { pick_n: 4 }],
      }),
    };
    expect(await getDbPickPositions(client as any, "draft-1")).toEqual(
      new Set([1, 2, 4]),
    );
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
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [{ card_id: 456 }] }), // front-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Fable of the Mirror-Breaker")).toBe(456);
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to back-face DFC match", async () => {
    const client = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
        .mockResolvedValueOnce({ rows: [{ card_id: 789 }] }), // back-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Death")).toBe(789);
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it("falls back to alias table lookup", async () => {
    const client = {
      execute: vi.fn()
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
    expect(result).toBe(0);
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

    const picks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
    ];
    const result = await insertNewPicks(client as any, "draft-1", picks);

    expect(result).toBe(2);
    expect(client.batch).toHaveBeenCalledTimes(1);
    const batchArgs = client.batch.mock.calls[0][0];
    expect(batchArgs).toHaveLength(2);
    // Seats are converted from 0-indexed to 1-indexed
    expect(batchArgs[0].args).toEqual(["draft-1", 1, 1, 10]);
    expect(batchArgs[1].args).toEqual(["draft-1", 2, 2, 20]);
  });

  it("skips picks whose card names are not found", async () => {
    // Only Lightning Bolt resolves
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    client.batch.mockResolvedValueOnce(undefined);

    const picks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Unknown Card", 2, 1),
    ];
    const result = await insertNewPicks(client as any, "draft-1", picks);

    expect(result).toBe(1);
    const batchArgs = client.batch.mock.calls[0][0];
    expect(batchArgs).toHaveLength(1);
  });
});

describe("markDraftComplete", () => {
  it("executes UPDATE with correct draft_id", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    await markDraftComplete(client as any, "draft-99");

    expect(client.execute).toHaveBeenCalledWith({
      sql: "UPDATE drafts SET phase = 'complete' WHERE draft_id = ?",
      args: ["draft-99"],
    });
  });
});

describe("incrementalIngest", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
    vi.clearAllMocks();
  });

  it("returns no_change when picks array is empty", async () => {
    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [],
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result).toEqual({ status: "no_change", picksInserted: 0 });
  });

  it("returns diverged when csvMaxPick < dbMaxPick", async () => {
    // getDbPickPositions returns positions up to 10
    client.execute.mockResolvedValueOnce({
      rows: [{ pick_n: 9 }, { pick_n: 10 }],
    });

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Bolt", 5, 0)], // csvMaxPick = 5 < dbMaxPick = 10
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result).toEqual({ status: "diverged", picksInserted: 0 });
  });

  it("returns no_change when all sheet positions are already stored", async () => {
    // getDbPickPositions returns {3, 5}
    client.execute.mockResolvedValueOnce({
      rows: [{ pick_n: 3 }, { pick_n: 5 }],
    });

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Bolt", 3, 0), pick("Counter", 5, 1)],
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result).toEqual({ status: "no_change", picksInserted: 0 });
  });

  it("returns updated when new picks are inserted", async () => {
    // getDbPickPositions returns {1, 2}
    client.execute.mockResolvedValueOnce({
      rows: [{ pick_n: 1 }, { pick_n: 2 }],
    });
    // insertNewPicks: batch name resolution
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Swords to Plowshares" }],
    });
    client.batch.mockResolvedValueOnce(undefined);

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Bolt", 1, 0), pick("Swords to Plowshares", 3, 0)],
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result.status).toBe("updated");
    expect(result.picksInserted).toBe(1);
  });

  it("inserts back-filled picks in gaps below the database max", async () => {
    // getDbPickPositions returns {1, 2, 4} — pick 3 was back-filled in the
    // sheet after pick 4 had already synced
    client.execute.mockResolvedValueOnce({
      rows: [{ pick_n: 1 }, { pick_n: 2 }, { pick_n: 4 }],
    });
    // insertNewPicks: batch name resolution
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 30, name: "Swords to Plowshares" }],
    });
    client.batch.mockResolvedValueOnce(undefined);

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [
        pick("Bolt", 1, 0),
        pick("Counter", 2, 1),
        pick("Swords to Plowshares", 3, 0),
        pick("Path", 4, 1),
      ],
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result.status).toBe("updated");
    expect(result.picksInserted).toBe(1);
    const batchArgs = client.batch.mock.calls[0][0];
    expect(batchArgs).toHaveLength(1);
    expect(batchArgs[0].args).toEqual(["draft-1", 3, 1, 30]);
  });

  it("returns completed and marks draft complete when isComplete is true", async () => {
    // getDbPickPositions returns empty set
    client.execute.mockResolvedValueOnce({ rows: [] });
    // insertNewPicks: batch name resolution
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    client.batch.mockResolvedValueOnce(undefined);
    // markDraftComplete: UPDATE
    client.execute.mockResolvedValueOnce({ rows: [], rowsAffected: 1 });

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Lightning Bolt", 1, 0)],
      numDrafters: 2,
      drafterNames: [],
      isComplete: true,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result.status).toBe("completed");
    expect(result.picksInserted).toBe(1);
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
  it("returns mapped draft rows", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "draft-1", sheet_id: "sheet-abc" },
        { draft_id: "draft-2", sheet_id: "sheet-def" },
      ],
    });

    const result = await getActiveDrafts(client as any);
    expect(result).toEqual([
      { draftId: "draft-1", sheetId: "sheet-abc" },
      { draftId: "draft-2", sheetId: "sheet-def" },
    ]);
  });

  it("returns empty array when no active drafts", async () => {
    const client = createMockClient();
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getActiveDrafts(client as any);
    expect(result).toEqual([]);
  });
});
