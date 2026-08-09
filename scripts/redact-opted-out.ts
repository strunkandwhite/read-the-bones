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

import type { Client } from "@libsql/client";
import { loadEnv } from "../src/core/db/ingest/utils";
import { getClient } from "../src/core/db/client";
import { reconcileRedactedRows } from "../src/core/db/ingest/redaction";
import { getOptedOutSeats, placeholders } from "../src/core/db/queries/helpers";

/**
 * Read-only count of what reconcileRedactedRows would delete for a draft,
 * without deleting anything. Mirrors its DELETE queries' WHERE clauses
 * exactly, swapped for COUNT(*).
 */
async function previewRedactedRows(
  client: Client,
  draftId: string,
): Promise<{ picksToDelete: number; deckCardsToDelete: number; deckHashesToDelete: number }> {
  const optedOutSeats = await getOptedOutSeats(client, draftId);
  if (optedOutSeats.size === 0) {
    return { picksToDelete: 0, deckCardsToDelete: 0, deckHashesToDelete: 0 };
  }

  const seats = [...optedOutSeats];
  const ph = placeholders(seats.length);

  const picksResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM pick_events WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });
  const deckCardsResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM deck_cards WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });
  const deckHashesResult = await client.execute({
    sql: `SELECT COUNT(*) AS n FROM deck_hashes WHERE draft_id = ? AND seat IN (${ph})`,
    args: [draftId, ...seats],
  });

  return {
    picksToDelete: Number(picksResult.rows[0].n),
    deckCardsToDelete: Number(deckCardsResult.rows[0].n),
    deckHashesToDelete: Number(deckHashesResult.rows[0].n),
  };
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const client = await getClient();

  console.log(
    dryRun
      ? "=== DRY RUN — previewing only, no rows will be deleted ===\n"
      : "=== LIVE RUN — deleting redacted rows ===\n",
  );

  const drafts = await client.execute(
    "SELECT DISTINCT draft_id FROM privacy_opt_outs ORDER BY draft_id",
  );

  let totalPicks = 0;
  let totalDeckCards = 0;
  let totalDeckHashes = 0;

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;
    if (dryRun) {
      const { picksToDelete, deckCardsToDelete, deckHashesToDelete } = await previewRedactedRows(
        client,
        draftId,
      );
      totalPicks += picksToDelete;
      totalDeckCards += deckCardsToDelete;
      totalDeckHashes += deckHashesToDelete;
      console.log(
        `  ${draftId}: ${picksToDelete} picks, ${deckCardsToDelete} deck cards, ${deckHashesToDelete} deck hashes would be deleted`,
      );
    } else {
      const { picksDeleted, deckCardsDeleted, deckHashesDeleted } = await reconcileRedactedRows(
        client,
        draftId,
      );
      totalPicks += picksDeleted;
      totalDeckCards += deckCardsDeleted;
      totalDeckHashes += deckHashesDeleted;
      console.log(
        `  ${draftId}: ${picksDeleted} picks, ${deckCardsDeleted} deck cards, ${deckHashesDeleted} deck hashes deleted`,
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

  const leftover = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM pick_events pe
         JOIN privacy_opt_outs p ON p.draft_id = pe.draft_id AND p.seat = pe.seat) AS picks,
      (SELECT COUNT(*) FROM deck_cards dc
         JOIN privacy_opt_outs p ON p.draft_id = dc.draft_id AND p.seat = dc.seat) AS deck_cards,
      (SELECT COUNT(*) FROM deck_hashes dh
         JOIN privacy_opt_outs p ON p.draft_id = dh.draft_id AND p.seat = dh.seat) AS deck_hashes
  `);
  const { picks, deck_cards, deck_hashes } = leftover.rows[0];
  console.log(
    `Verification — remaining redacted rows: ${picks} picks, ${deck_cards} deck cards, ${deck_hashes} deck hashes`,
  );
  if (Number(picks) !== 0 || Number(deck_cards) !== 0 || Number(deck_hashes) !== 0) {
    console.error("FAILED: redacted rows remain");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
