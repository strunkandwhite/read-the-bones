import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { filterRedactedPicks, reconcileRedactedRows, countRedactedRows } from "./redaction";
import type { CardPick } from "../../types";
import {
  createMemDb,
  insertCard,
  insertCubeSnapshot,
  insertCubeCard,
  insertDraft,
  insertPickEvent,
  insertDeckCard,
  insertPrivacyOptOut,
} from "../__tests__/testDb";

function pick(seat: number, pickPosition: number, cardName: string): CardPick {
  return { cardName, pickPosition, copyNumber: 1, wasPicked: true, draftId: "d1", seat, color: "" };
}

describe("filterRedactedPicks", () => {
  it("drops picks whose 1-indexed seat is opted out", () => {
    // seat 4 (0-indexed) is seat 5 (1-indexed)
    const picks = [pick(3, 4, "Bolt"), pick(4, 5, "Swords"), pick(5, 6, "Ragavan")];
    const result = filterRedactedPicks(picks, new Set([5]));
    expect(result.map((p) => p.cardName)).toEqual(["Bolt", "Ragavan"]);
  });

  it("returns the input unchanged when nothing is opted out", () => {
    const picks = [pick(0, 1, "Bolt"), pick(1, 2, "Swords")];
    expect(filterRedactedPicks(picks, new Set())).toHaveLength(2);
  });

  it("drops every pick when the only drafter is opted out", () => {
    expect(filterRedactedPicks([pick(0, 1, "Bolt")], new Set([1]))).toEqual([]);
  });

  it("does not confuse 0-indexed seat 5 with 1-indexed seat 5", () => {
    // 0-indexed seat 5 is 1-indexed seat 6 — must survive an opt-out on seat 5
    const result = filterRedactedPicks([pick(5, 1, "Bolt")], new Set([5]));
    expect(result).toHaveLength(1);
  });
});

describe("reconcileRedactedRows", () => {
  let mockClient: { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn(), batch: vi.fn() };
  });

  it("deletes pick_events, deck_cards and deck_hashes for opted-out seats and reports counts", async () => {
    mockClient.execute
      .mockResolvedValueOnce({ rows: [{ seat: 5 }] })                 // getOptedOutSeats
      .mockResolvedValueOnce({ rowsAffected: 45 })                    // pick_events delete
      .mockResolvedValueOnce({ rowsAffected: 44 })                    // deck_cards delete
      .mockResolvedValueOnce({ rowsAffected: 1 });                    // deck_hashes delete

    const result = await reconcileRedactedRows(mockClient as never, "d1");

    expect(result).toEqual({ picksDeleted: 45, deckCardsDeleted: 44, deckHashesDeleted: 1 });
    // placeholders(1) === "?" — a hardcoded single-placeholder implementation
    // would still match this SQL, so the args assertion is what pins the bug;
    // the SQL assertion pins the placeholder count for the two-seat case below.
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM pick_events WHERE draft_id = ? AND seat IN (?)"),
        args: ["d1", 5],
      }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM deck_cards WHERE draft_id = ? AND seat IN (?)"),
        args: ["d1", 5],
      }),
    );
    // deck_hashes is the per-seat companion of deck_cards. Leaving it behind
    // gives an opted-out seat a provenance row pointing at cards that no longer
    // exist, recreated by the cron the minute after the opt-out.
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM deck_hashes WHERE draft_id = ? AND seat IN (?)"),
        args: ["d1", 5],
      }),
    );
  });

  it("deletes for every opted-out seat when there are multiple", async () => {
    mockClient.execute
      .mockResolvedValueOnce({ rows: [{ seat: 3 }, { seat: 7 }] })    // getOptedOutSeats
      .mockResolvedValueOnce({ rowsAffected: 12 })                    // pick_events delete
      .mockResolvedValueOnce({ rowsAffected: 9 })                     // deck_cards delete
      .mockResolvedValueOnce({ rowsAffected: 2 });                    // deck_hashes delete

    const result = await reconcileRedactedRows(mockClient as never, "d1");

    expect(result).toEqual({ picksDeleted: 12, deckCardsDeleted: 9, deckHashesDeleted: 2 });
    // placeholders(2) === "?, ?" — pins that the IN clause actually expands
    // with seats.length rather than being hardcoded to a single "?", which
    // the args-only assertion above cannot distinguish on its own.
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM pick_events WHERE draft_id = ? AND seat IN (?, ?)"),
        args: ["d1", 3, 7],
      }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM deck_cards WHERE draft_id = ? AND seat IN (?, ?)"),
        args: ["d1", 3, 7],
      }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining(
          "DELETE FROM deck_hashes WHERE draft_id = ? AND seat IN (?, ?)",
        ),
        args: ["d1", 3, 7],
      }),
    );
  });

  it("issues no deletes when the draft has no opt-outs", async () => {
    mockClient.execute.mockResolvedValueOnce({ rows: [] });
    const result = await reconcileRedactedRows(mockClient as never, "d1");
    expect(result).toEqual({ picksDeleted: 0, deckCardsDeleted: 0, deckHashesDeleted: 0 });
    expect(mockClient.execute).toHaveBeenCalledTimes(1);
  });
});

/**
 * Seeds a draft with a retained seat and, optionally, an opted-out seat, each
 * with rows in pick_events, deck_cards and deck_hashes. Seeding both is what
 * makes the counts discriminating: a WHERE clause that redacted the wrong
 * seat, or all seats, would still pass a fixture with only one seat present.
 */
async function seedDraftWithOptedOutSeat(
  client: Client,
  { draftId, optedOutSeat }: { draftId: string; optedOutSeat: number | null }
): Promise<void> {
  await insertCubeSnapshot(client, 1);
  await insertCard(client, 1, "Bolt");
  await insertCard(client, 2, "Swords to Plowshares");
  await insertCubeCard(client, 1, 1);
  await insertCubeCard(client, 1, 2);
  await insertDraft(client, draftId, { cubeSnapshotId: 1 });

  const retainedSeat = 1;
  await insertPickEvent(client, draftId, 1, retainedSeat, 1);
  await insertDeckCard(client, draftId, retainedSeat, 1, "deck");
  await client.execute({
    sql: `INSERT INTO deck_hashes (draft_id, seat, hash) VALUES (?, ?, ?)`,
    args: [draftId, retainedSeat, "hash-retained"],
  });

  if (optedOutSeat !== null) {
    await insertPrivacyOptOut(client, draftId, optedOutSeat);
    await insertPickEvent(client, draftId, 2, optedOutSeat, 2);
    await insertDeckCard(client, draftId, optedOutSeat, 2, "deck");
    await client.execute({
      sql: `INSERT INTO deck_hashes (draft_id, seat, hash) VALUES (?, ?, ?)`,
      args: [draftId, optedOutSeat, "hash-opted-out"],
    });
  }
}

describe("countRedactedRows", () => {
  it("counts exactly the rows reconcileRedactedRows would delete", async () => {
    const client = await createMemDb();
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: 2 });

    const counted = await countRedactedRows(client, "d1");
    const deleted = await reconcileRedactedRows(client, "d1");

    expect(counted).toEqual({
      picks: deleted.picksDeleted,
      deckCards: deleted.deckCardsDeleted,
      deckHashes: deleted.deckHashesDeleted,
    });
    // The seeding must produce a non-trivial case, or this asserts 0 === 0.
    expect(counted.picks).toBeGreaterThan(0);
    expect(counted.deckHashes).toBeGreaterThan(0);
  });

  it("counts nothing when the draft has no opted-out seats", async () => {
    const client = await createMemDb();
    await seedDraftWithOptedOutSeat(client, { draftId: "d1", optedOutSeat: null });
    expect(await countRedactedRows(client, "d1")).toEqual({
      picks: 0,
      deckCards: 0,
      deckHashes: 0,
    });
  });
});
