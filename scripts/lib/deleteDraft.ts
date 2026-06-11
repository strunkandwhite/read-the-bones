// Fully delete a draft and all associated data.
//
// Extracted from scripts/draft-delete.ts so the deletion runs against real
// SQL in tests — the table list must stay in lockstep with the live schema
// (a stale "pick_queue" entry once made the CLI crash before deleting anything).

import type { Client } from "@libsql/client";

// Every table holding draft-scoped rows, in dependency order. Pick queues are
// not listed: they live in seat_tokens.queue_json since the queue_json migration.
const DRAFT_SCOPED_TABLES = [
  "floated_cards",
  "match_events",
  "pick_events",
  "deck_cards",
  "deck_hashes",
  "privacy_opt_outs",
  "decks",
  "seat_tokens",
];

export interface DeleteDraftResult {
  draftName: string;
  rowsDeletedByTable: Record<string, number>;
  cubeSnapshotId: number;
  cubeSnapshotDeleted: boolean;
}

export async function deleteDraft(
  client: Client,
  draftId: string,
): Promise<DeleteDraftResult> {
  const result = await client.execute({
    sql: "SELECT draft_id, draft_name, cube_snapshot_id FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);

  const draftName = result.rows[0].draft_name as string;
  const cubeSnapshotId = result.rows[0].cube_snapshot_id as number;

  const rowsDeletedByTable: Record<string, number> = {};
  for (const table of DRAFT_SCOPED_TABLES) {
    const r = await client.execute({
      sql: `DELETE FROM ${table} WHERE draft_id = ?`,
      args: [draftId],
    });
    rowsDeletedByTable[table] = r.rowsAffected;
  }

  await client.execute({
    sql: "DELETE FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });

  // Clean up the cube snapshot if no other draft references it
  const refs = await client.execute({
    sql: "SELECT count(*) as cnt FROM drafts WHERE cube_snapshot_id = ?",
    args: [cubeSnapshotId],
  });
  const cubeSnapshotDeleted = (refs.rows[0].cnt as number) === 0;
  if (cubeSnapshotDeleted) {
    await client.execute({
      sql: "DELETE FROM cube_snapshot_cards WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });
    await client.execute({
      sql: "DELETE FROM cube_snapshots WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });
  }

  return { draftName, rowsDeletedByTable, cubeSnapshotId, cubeSnapshotDeleted };
}
