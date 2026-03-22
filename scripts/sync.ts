// scripts/sync.ts
//
// CLI entry point for unified Sheets-to-Turso sync.
// Usage: pnpm sync [draft-id] [--dry-run] [--verbose|-v]

import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { syncAll } from "../src/core/db/sync/index";

function parseArgs(args: string[]) {
  let filterDraftId: string | undefined;
  let dryRun = false;
  let verbose = false;

  for (const arg of args) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--verbose" || arg === "-v") verbose = true;
    else if (!arg.startsWith("-")) filterDraftId = arg;
  }

  return { filterDraftId, dryRun, verbose };
}

async function main() {
  loadEnv();
  const options = parseArgs(process.argv.slice(2));

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  if (options.dryRun) log("DRY RUN — no changes will be written");

  const { results, errors } = await syncAll(client, options);

  for (const r of results) {
    const actions = [
      r.poolAction === "replace" ? "pool" : null,
      r.picksAction === "replace" ? `picks(${r.picksCount})` : null,
      r.matchesAction === "replace" ? `matches(${r.matchesCount})` : null,
    ].filter(Boolean);

    if (actions.length === 0) {
      log(`${r.draftId}: unchanged`);
    } else {
      log(`${r.draftId}: replaced ${actions.join(", ")}`);
    }
    if (r.markedComplete) log(`  → marked complete`);
    if (r.error) log(`  ⚠ ${r.error}`);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
