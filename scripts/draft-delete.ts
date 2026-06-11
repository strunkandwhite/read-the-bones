// scripts/draft-delete.ts
//
// Fully delete a draft and all associated data from Turso.
// Usage: pnpm draft:delete <draft-id>

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { deleteDraft } from "./lib/deleteDraft";

async function main() {
  loadEnv();
  const draftId = process.argv[2];
  if (!draftId) throw new Error("Usage: pnpm draft:delete <draft-id>");

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const result = await deleteDraft(client, draftId);

  for (const [table, rows] of Object.entries(result.rowsDeletedByTable)) {
    if (rows > 0) console.log(`  ${table}: ${rows} rows deleted`);
  }
  console.log(`  drafts: deleted`);
  if (result.cubeSnapshotDeleted) {
    console.log(`  cube_snapshot ${result.cubeSnapshotId}: orphaned, deleted`);
  }

  console.log(`\nDeleted draft: ${draftId} (${result.draftName})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
