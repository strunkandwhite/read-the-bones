// scripts/draft-start.ts
//
// Transition a draft from 'setup' to 'drafting' phase.
// Usage: pnpm draft:start <draft-name>

import { createClient } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { resumeAutoPickForCurrentSeat } from "../src/core/processPick";
import { slugify } from "./lib/slugify";

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

  try {
    const resumed = await resumeAutoPickForCurrentSeat(client, draftId);
    if (resumed.picks.length > 0) {
      console.log(`Auto-picked ${resumed.picks.length} card(s) on start:`);
      for (const p of resumed.picks) {
        console.log(`  pick ${p.pickN}  seat ${p.seat}  ${p.cardName}`);
      }
    }
  } catch (e) {
    console.warn(
      `  (auto-pick on start skipped: ${e instanceof Error ? e.message : e})`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
