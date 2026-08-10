import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getLatestPickNumber,
  getRecentPicks,
  getPicksWithCardDetails,
  getLiveStateSig,
} from "./picks";
import {
  createMemDb,
  insertDraft,
  insertSeatToken,
  insertMatch,
  insertPickEvent,
  insertFloatedCard,
} from "../__tests__/testDb";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

// Mock getClient so existing functions don't fail if accidentally called
vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("getLatestPickNumber", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the latest pick number", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 15 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(15);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("MAX(pick_n)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no picks exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 0 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("getRecentPicks", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns recent picks in descending order", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { pick_n: 3, seat: 3, card_name: "Dark Ritual" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
      ],
    });

    const result = await getRecentPicks(client, "draft-1", 10);

    expect(result).toEqual([
      { pickN: 3, seat: 3, cardName: "Dark Ritual" },
      { pickN: 2, seat: 2, cardName: "Counterspell" },
      { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    ]);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("ORDER BY pe.pick_n DESC LIMIT ?"),
        args: ["draft-1", 10],
      })
    );
  });

  it("returns empty array when no picks", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getRecentPicks(client, "draft-1", 5);

    expect(result).toEqual([]);
  });
});

describe("getPicksWithCardDetails", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  // The query now uses json_extract to pull color_identity and mana_cost from
  // scryfall_json rather than fetching the full blob. Mock rows must use the
  // aliased column names: color_identity_json (serialized JSON array) and mana_cost.
  it("returns picks with slim json_extract fields", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Lightning Bolt",
        oracle_id: "abc-123",
        color_identity_json: JSON.stringify(["R"]),
        mana_cost: "{R}",
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result).toEqual([{
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    }]);
    // Verify the query uses json_extract and the new aliases
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("json_extract"),
        args: ["draft-1"],
      })
    );
  });

  it("handles null color_identity_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        color_identity_json: null,
        mana_cost: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });

  it("handles invalid color_identity_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        color_identity_json: "not valid json",
        mana_cost: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getLiveStateSig
//
// These tests execute the production SQL against an in-memory libsql database
// rather than mocking client.execute — a mocked version of this suite let a
// dialect error (GROUP_CONCAT ... ORDER BY, a MySQL-ism) ship and 500 every
// /live request in production.
// ---------------------------------------------------------------------------

// Seeds a draft that exercises all four inputs to the sig at once: a pick
// history (latestPickN), phase + a match (phase|matchCount), multiple named
// seats (seatNamesCsv), and a queue/float/auto_pick state for seat 3 (the
// per-seat marker).
async function seedLiveDraftForSig(): Promise<Client> {
  const db = await createMemDb();
  await insertDraft(db, "d1", { phase: "drafting" });
  await insertSeatToken(db, "d1", 1, { displayName: "Alice" });
  await insertSeatToken(db, "d1", 2, { displayName: "Bob" });
  await insertSeatToken(db, "d1", 3, {
    displayName: "Carol",
    queueJson: JSON.stringify([{ mode: "pause", cards: ["Bolt"] }]),
  });
  await insertMatch(db, "d1", 1, 2, 2, 1);
  for (let pickN = 1; pickN <= 5; pickN++) {
    await insertPickEvent(db, "d1", pickN, ((pickN - 1) % 3) + 1, 100 + pickN);
  }
  await insertFloatedCard(db, "d1", 3, "Counterspell");
  return db;
}

describe("getLiveStateSig", () => {
  it("returns latestPickN and a composite sig from phase+matchCount+seatNames", async () => {
    const db = await createMemDb();
    await insertDraft(db, "draft-1", { phase: "drafting" });
    await insertSeatToken(db, "draft-1", 1, { displayName: "Alice" });
    await insertSeatToken(db, "draft-1", 2, { displayName: "Bob" });
    await insertMatch(db, "draft-1", 1, 2, 2, 1);
    await insertMatch(db, "draft-1", 1, 3, 2, 0);
    for (let pickN = 1; pickN <= 7; pickN++) {
      await insertPickEvent(db, "draft-1", pickN, ((pickN - 1) % 2) + 1, 100 + pickN);
    }

    const result = await getLiveStateSig(db, "draft-1");

    expect(result.latestPickN).toBe(7);
    expect(result.sig).toBe("drafting|2|Alice:Bob");
  });

  it("returns pickN=0 and empty-ish sig when the draft does not exist", async () => {
    const db = await createMemDb();

    const result = await getLiveStateSig(db, "draft-1");

    expect(result.latestPickN).toBe(0);
    expect(result.sig).toBe("|0|");
  });

  it("orders seat names by seat regardless of insertion order, with '' for unnamed seats", async () => {
    const db = await createMemDb();
    await insertDraft(db, "draft-1", { phase: "drafting" });
    await insertSeatToken(db, "draft-1", 3, { displayName: null });
    await insertSeatToken(db, "draft-1", 1, { displayName: "Alice" });
    await insertSeatToken(db, "draft-1", 2, { displayName: "Bob" });

    const result = await getLiveStateSig(db, "draft-1");

    expect(result.sig).toBe("drafting|0|Alice:Bob:");
  });

  it("appends a per-seat freshness marker that changes on queue and float changes", async () => {
    const db = await createMemDb();
    await insertDraft(db, "draft-1", { phase: "drafting" });
    const queueJson = JSON.stringify([{ mode: "pause", cards: ["Bolt"] }]);
    await insertSeatToken(db, "draft-1", 1, { displayName: "Alice", queueJson });

    const before = await getLiveStateSig(db, "draft-1", 1);
    expect(before.sig).toBe(`drafting|0|Alice~${queueJson.length}:0:1`);

    await insertFloatedCard(db, "draft-1", 1, "Counterspell");
    const after = await getLiveStateSig(db, "draft-1", 1);
    expect(after.sig).toBe(`drafting|0|Alice~${queueJson.length}:1:1`);
    expect(after.sig).not.toBe(before.sig);
  });

  it("changes the per-seat marker when auto-pick is disabled server-side", async () => {
    const db = await createMemDb();
    await insertDraft(db, "draft-1", { phase: "drafting" });
    const queueJson = JSON.stringify([{ mode: "pause", cards: ["Bolt"] }]);
    await insertSeatToken(db, "draft-1", 1, { displayName: "Alice", queueJson });

    const before = await getLiveStateSig(db, "draft-1", 1);

    // A walk-time pause disables auto-pick without making a pick or touching the
    // queue — the sig must still move, or an idle client never learns about it.
    await db.execute({
      sql: "UPDATE seat_tokens SET auto_pick = 0 WHERE draft_id = ? AND seat = ?",
      args: ["draft-1", 1],
    });

    const after = await getLiveStateSig(db, "draft-1", 1);
    expect(after.sig).not.toBe(before.sig);
  });

  it("produces a stable signature for a fixed draft state", async () => {
    const client = await seedLiveDraftForSig();
    const sig = await getLiveStateSig(client, "d1", 3);
    expect(sig).toEqual(await getLiveStateSig(client, "d1", 3));
    // Pin the literal so a reordering that changes composition is caught.
    expect(sig.sig).toMatchInlineSnapshot(`"drafting|1|Alice:Bob:Carol~35:1:1"`);
  });

  it("produces distinct sigs for phase, match-count, and seat-name changes", async () => {
    const db = await createMemDb();
    await insertDraft(db, "draft-1", { phase: "drafting" });
    await insertSeatToken(db, "draft-1", 1, { displayName: "Alice" });

    const sigs = new Set<string>();
    sigs.add((await getLiveStateSig(db, "draft-1")).sig);

    await db.execute({ sql: "UPDATE drafts SET phase = 'playing' WHERE draft_id = ?", args: ["draft-1"] });
    sigs.add((await getLiveStateSig(db, "draft-1")).sig);

    await insertMatch(db, "draft-1", 1, 2, 2, 1);
    sigs.add((await getLiveStateSig(db, "draft-1")).sig);

    await db.execute({ sql: "UPDATE seat_tokens SET display_name = 'Alicia' WHERE draft_id = ? AND seat = 1", args: ["draft-1"] });
    sigs.add((await getLiveStateSig(db, "draft-1")).sig);

    expect(sigs.size).toBe(4);
  });
});
