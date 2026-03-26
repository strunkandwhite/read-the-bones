// scripts/draft-start.ts
//
// Transition a draft from 'setup' to 'drafting' phase.
// Usage: pnpm draft:start <draft-name>

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function main() {
  loadEnv();
  const name = process.argv[2];
  if (!name) throw new Error("Usage: pnpm draft:start <draft-name>");

  const draftId = slugify(name);
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const result = await client.execute({
    sql: "SELECT phase FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
  if (result.rows.length === 0) throw new Error(`Draft "${draftId}" not found`);

  const phase = result.rows[0].phase as string;
  if (phase !== "setup") throw new Error(`Draft is in "${phase}" phase, expected "setup"`);

  await client.execute({
    sql: "UPDATE drafts SET phase = 'drafting' WHERE draft_id = ?",
    args: [draftId],
  });

  console.log(`Draft "${draftId}" is now in drafting phase`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
