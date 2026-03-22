// scripts/draft-reset.ts
//
// Reset a draft's domain data (picks, matches, decklists) without deleting the draft record.
// Usage: pnpm draft:reset <draft-id>

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { resetDraft } from "../src/core/db/ingest/db-helpers";

async function main() {
  loadEnv();
  const draftId = process.argv[2];
  if (!draftId) throw new Error("Usage: pnpm draft:reset <draft-id>");

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const result = await client.execute({
    sql: "SELECT draft_id, draft_name FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) throw new Error(`Draft not found: ${draftId}`);

  const draftName = result.rows[0].draft_name as string;
  await resetDraft(client, draftId);

  console.log(`Reset draft: ${draftId} (${draftName})`);
  console.log("  All picks, matches, and decklists cleared; hashes nulled");
  console.log("  Run 'pnpm sync' to reimport from Sheets");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
