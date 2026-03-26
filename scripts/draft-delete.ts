// scripts/draft-delete.ts
//
// Fully delete a draft and all associated data from Turso.
// Usage: pnpm draft:delete <draft-id>

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";

async function main() {
  loadEnv();
  const draftId = process.argv[2];
  if (!draftId) throw new Error("Usage: pnpm draft:delete <draft-id>");

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const result = await client.execute({
    sql: "SELECT draft_id, draft_name, cube_snapshot_id FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);

  const draftName = result.rows[0].draft_name as string;
  const cubeSnapshotId = result.rows[0].cube_snapshot_id as number;

  // Delete in dependency order
  const tables = [
    "pick_queue",
    "match_events",
    "pick_events",
    "deck_cards",
    "deck_hashes",
    "privacy_opt_outs",
    "shared_decks",
    "seat_tokens",
  ];
  for (const table of tables) {
    const r = await client.execute({
      sql: `DELETE FROM ${table} WHERE draft_id = ?`,
      args: [draftId],
    });
    if (r.rowsAffected > 0) console.log(`  ${table}: ${r.rowsAffected} rows deleted`);
  }

  // Delete the draft record
  await client.execute({
    sql: "DELETE FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  console.log(`  drafts: deleted`);

  // Clean up orphaned cube snapshot (if no other draft references it)
  const refs = await client.execute({
    sql: "SELECT count(*) as cnt FROM drafts WHERE cube_snapshot_id = ?",
    args: [cubeSnapshotId],
  });
  if ((refs.rows[0].cnt as number) === 0) {
    await client.execute({
      sql: "DELETE FROM cube_snapshot_cards WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });
    await client.execute({
      sql: "DELETE FROM cube_snapshots WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });
    console.log(`  cube_snapshot ${cubeSnapshotId}: orphaned, deleted`);
  }

  console.log(`\nDeleted draft: ${draftId} (${draftName})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
