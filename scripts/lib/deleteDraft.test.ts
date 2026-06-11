// Runs deleteDraft against real in-memory SQL so the table list stays in
// lockstep with the schema — a stale table name (the dropped pick_queue)
// previously made the CLI throw "no such table" before deleting anything.

import { describe, it, expect } from "vitest";
import type { Client } from "@libsql/client";
import { deleteDraft } from "./deleteDraft";
import {
  createMemDb,
  insertDraft,
  insertCubeSnapshot,
  insertCubeCard,
  insertPickEvent,
  insertMatch,
  insertDeckCard,
  insertPrivacyOptOut,
  insertSeatToken,
  insertFloatedCard,
} from "../../src/core/db/__tests__/testDb";

async function seedFullDraft(db: Client, draftId: string, snapshotId: number) {
  await insertCubeSnapshot(db, snapshotId);
  await insertCubeCard(db, snapshotId, 1);
  await insertDraft(db, draftId, { phase: "drafting", cubeSnapshotId: snapshotId });
  await insertSeatToken(db, draftId, 1, {
    displayName: "Alice",
    queueJson: JSON.stringify([{ mode: "pause", cards: ["Bolt"] }]),
  });
  await insertFloatedCard(db, draftId, 1, "Counterspell");
  await insertPickEvent(db, draftId, 1, 1, 1);
  await insertMatch(db, draftId, 1, 2, 2, 1);
  await insertDeckCard(db, draftId, 1, 1);
  await insertPrivacyOptOut(db, draftId, 2);
  await db.execute({
    sql: `INSERT INTO decks (id, draft_id, seat, deck_state, kind) VALUES (?, ?, ?, '{}', 'wip')`,
    args: [`deck-${draftId}`, draftId, 1],
  });
  await db.execute({
    sql: `INSERT INTO deck_hashes (draft_id, seat, hash) VALUES (?, 1, 'h')`,
    args: [draftId],
  });
}

async function countRows(db: Client, table: string, draftId: string): Promise<number> {
  const r = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM ${table} WHERE draft_id = ?`,
    args: [draftId],
  });
  return r.rows[0].cnt as number;
}

const DRAFT_TABLES = [
  "floated_cards",
  "match_events",
  "pick_events",
  "deck_cards",
  "deck_hashes",
  "privacy_opt_outs",
  "decks",
  "seat_tokens",
  "drafts",
];

describe("deleteDraft", () => {
  it("deletes every draft-scoped row, including seat_tokens holding the pick queue", async () => {
    const db = await createMemDb();
    await seedFullDraft(db, "doomed", 10);

    const result = await deleteDraft(db, "doomed");

    for (const table of DRAFT_TABLES) {
      expect(await countRows(db, table, "doomed"), table).toBe(0);
    }
    expect(result.draftName).toBe("doomed");
    expect(result.rowsDeletedByTable.seat_tokens).toBe(1);
  });

  it("leaves other drafts' data untouched", async () => {
    const db = await createMemDb();
    await seedFullDraft(db, "doomed", 10);
    await seedFullDraft(db, "survivor", 11);

    await deleteDraft(db, "doomed");

    for (const table of DRAFT_TABLES) {
      expect(await countRows(db, table, "survivor"), table).toBe(1);
    }
  });

  it("deletes the cube snapshot when orphaned, keeps it when shared", async () => {
    const db = await createMemDb();
    await seedFullDraft(db, "doomed", 10);
    await seedFullDraft(db, "sharer", 20);
    await insertDraft(db, "co-sharer", { cubeSnapshotId: 20 });

    const orphaned = await deleteDraft(db, "doomed");
    expect(orphaned.cubeSnapshotDeleted).toBe(true);

    const shared = await deleteDraft(db, "sharer");
    expect(shared.cubeSnapshotDeleted).toBe(false);

    const snaps = await db.execute(
      "SELECT cube_snapshot_id FROM cube_snapshots ORDER BY cube_snapshot_id",
    );
    expect(snaps.rows.map((r) => r.cube_snapshot_id)).toEqual([20]);
  });

  it("throws without deleting anything when the draft does not exist", async () => {
    const db = await createMemDb();
    await seedFullDraft(db, "survivor", 10);

    await expect(deleteDraft(db, "missing")).rejects.toThrow("Draft not found: missing");
    expect(await countRows(db, "drafts", "survivor")).toBe(1);
  });
});
