/**
 * One-time migration: delete stored picks, deck cards and deck hashes for every
 * opted-out seat. Idempotent — it is the same reconcile pass the sync pipeline
 * runs, so it can be re-run safely and reports zero on a clean database.
 *
 * Usage:
 *   pnpm redact:opted-out             # deletes for real
 *   pnpm redact:opted-out --dry-run   # reports what would be deleted, per
 *                                     # draft and in total, without deleting
 *                                     # anything
 */

import { realpathSync } from "fs";
import { fileURLToPath } from "url";
import { loadEnv } from "../src/core/db/ingest/utils";
import { getClient } from "../src/core/db/client";
import {
  reconcileRedactedRows,
  countRedactedRows,
  REDACTED_TABLES,
} from "../src/core/db/ingest/redaction";
import { assertRecognizedFlags } from "./lib/cliFlags";

const RECOGNIZED_FLAGS = new Set(["--dry-run"]);

/**
 * Parse CLI args into flags. Pure so the "reject a typo'd flag" behavior — the
 * difference between a rehearsal and a real DELETE pass against the one
 * production database — is covered by a unit test rather than only by invoking
 * the script.
 */
export function parseRedactArgs(argv: string[]): { dryRun: boolean } {
  assertRecognizedFlags(argv, RECOGNIZED_FLAGS);

  return { dryRun: argv.includes("--dry-run") };
}

async function main() {
  loadEnv();
  const { dryRun } = parseRedactArgs(process.argv.slice(2));
  const client = await getClient();

  console.log(
    dryRun
      ? "=== DRY RUN — previewing only, no rows will be deleted ===\n"
      : "=== LIVE RUN — deleting redacted rows ===\n"
  );

  const drafts = await client.execute(
    "SELECT DISTINCT draft_id FROM privacy_opt_outs ORDER BY draft_id"
  );

  let totalPicks = 0;
  let totalDeckCards = 0;
  let totalDeckHashes = 0;

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;
    if (dryRun) {
      const { picks, deckCards, deckHashes } = await countRedactedRows(client, draftId);
      totalPicks += picks;
      totalDeckCards += deckCards;
      totalDeckHashes += deckHashes;
      console.log(
        `  ${draftId}: ${picks} picks, ${deckCards} deck cards, ${deckHashes} deck hashes would be deleted`
      );
    } else {
      const { picksDeleted, deckCardsDeleted, deckHashesDeleted } = await reconcileRedactedRows(
        client,
        draftId
      );
      totalPicks += picksDeleted;
      totalDeckCards += deckCardsDeleted;
      totalDeckHashes += deckHashesDeleted;
      console.log(
        `  ${draftId}: ${picksDeleted} picks, ${deckCardsDeleted} deck cards, ${deckHashesDeleted} deck hashes deleted`
      );
    }
  }

  const totals = `${totalPicks} picks, ${totalDeckCards} deck cards and ${totalDeckHashes} deck hashes`;

  if (dryRun) {
    console.log(`\nDRY RUN: would delete ${totals} across ${drafts.rows.length} drafts.`);
    console.log("Re-run without --dry-run to apply.");
    return;
  }

  console.log(`\nDeleted ${totals} across ${drafts.rows.length} drafts.`);

  const leftoverResults = await Promise.all(
    REDACTED_TABLES.map((table) =>
      client.execute(`
        SELECT COUNT(*) AS n FROM ${table} t
        JOIN privacy_opt_outs p ON p.draft_id = t.draft_id AND p.seat = t.seat
      `)
    )
  );
  const leftoverCounts = leftoverResults.map((r) => Number(r.rows[0].n));

  console.log(
    "Verification — remaining redacted rows: " +
      REDACTED_TABLES.map((table, i) => `${leftoverCounts[i]} ${table}`).join(", ")
  );
  if (leftoverCounts.some((n) => n !== 0)) {
    console.error("FAILED: redacted rows remain");
    process.exit(1);
  }
}

// Only run when invoked as a script. Importing this module — which the test
// does, for the pure parseRedactArgs function — must never start a migration.
// `loadEnv` picks up real Turso credentials, so the guard is what stands
// between `pnpm test` and a DELETE against production.
const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
