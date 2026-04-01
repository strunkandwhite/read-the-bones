import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectNewPicks,
  detectDivergence,
  isRateLimited,
  getDbMaxPickN,
  resolveCardNameToId,
  insertNewPicks,
  markDraftComplete,
  incrementalIngest,
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getSyncStatus,
  getActiveDrafts,
} from "../sync";
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
  it("returns only picks with pickPosition greater than currentMax", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
    ];
    const result = detectNewPicks(allPicks, 1);
    expect(result).toHaveLength(2);
    expect(result[0].cardName).toBe("Counterspell");
    expect(result[1].cardName).toBe("Swords to Plowshares");
  });

  it("returns all picks when currentMax is 0", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 0);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no new picks", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 5);
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

describe("isRateLimited", () => {
  it("returns false when no last_synced_at exists", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await isRateLimited(client as any)).toBe(false);
  });

  it("returns true when synced recently", async () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ value: String(recentTimestamp) }],
      }),
    };
    expect(await isRateLimited(client as any)).toBe(true);
  });

  it("returns false when synced long ago", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ value: String(oldTimestamp) }],
      }),
    };
    expect(await isRateLimited(client as any)).toBe(false);
  });
});

describe("getDbMaxPickN", () => {
  it("returns 0 when no picks exist", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ max_pick: null }] }),
    };
    expect(await getDbMaxPickN(client as any, "draft-1")).toBe(0);
  });

  it("returns max pick number", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ max_pick: 42 }] }),
    };
    expect(await getDbMaxPickN(client as any, "draft-1")).toBe(42);
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
    // getDbMaxPickN returns 10
    client.execute.mockResolvedValueOnce({ rows: [{ max_pick: 10 }] });

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Bolt", 5, 0)], // csvMaxPick = 5 < dbMaxPick = 10
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result).toEqual({ status: "diverged", picksInserted: 0 });
  });

  it("returns no_change when no new picks above dbMaxPick", async () => {
    // getDbMaxPickN returns 5
    client.execute.mockResolvedValueOnce({ rows: [{ max_pick: 5 }] });

    const result = await incrementalIngest(client as any, "draft-1", {
      picks: [pick("Bolt", 3, 0), pick("Counter", 5, 1)], // all <= 5
      numDrafters: 2,
      drafterNames: [],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
    expect(result).toEqual({ status: "no_change", picksInserted: 0 });
  });

  it("returns updated when new picks are inserted", async () => {
    // getDbMaxPickN returns 2
    client.execute.mockResolvedValueOnce({ rows: [{ max_pick: 2 }] });
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

  it("returns completed and marks draft complete when isComplete is true", async () => {
    // getDbMaxPickN returns 0
    client.execute.mockResolvedValueOnce({ rows: [{ max_pick: 0 }] });
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
