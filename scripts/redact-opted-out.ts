/**
 * One-time migration: delete stored picks and deck cards for every opted-out
 * seat. Idempotent — it is the same reconcile pass the sync pipeline runs, so
 * it can be re-run safely and reports zero on a clean database.
 */

import { loadEnv } from "../src/core/db/ingest/utils";
import { getClient } from "../src/core/db/client";
import { reconcileRedactedRows } from "../src/core/db/ingest/redaction";

async function main() {
  loadEnv();
  const client = await getClient();

  const drafts = await client.execute(
    "SELECT DISTINCT draft_id FROM privacy_opt_outs ORDER BY draft_id",
  );

  let totalPicks = 0;
  let totalDeckCards = 0;

  for (const row of drafts.rows) {
    const draftId = row.draft_id as string;
    const { picksDeleted, deckCardsDeleted } = await reconcileRedactedRows(client, draftId);
    totalPicks += picksDeleted;
    totalDeckCards += deckCardsDeleted;
    console.log(`  ${draftId}: ${picksDeleted} picks, ${deckCardsDeleted} deck cards`);
  }

  console.log(`\nDeleted ${totalPicks} picks and ${totalDeckCards} deck cards across ${drafts.rows.length} drafts.`);

  const leftover = await client.execute(`
    SELECT
      (SELECT COUNT(*) FROM pick_events pe
         JOIN privacy_opt_outs p ON p.draft_id = pe.draft_id AND p.seat = pe.seat) AS picks,
      (SELECT COUNT(*) FROM deck_cards dc
         JOIN privacy_opt_outs p ON p.draft_id = dc.draft_id AND p.seat = dc.seat) AS deck_cards
  `);
  const { picks, deck_cards } = leftover.rows[0];
  console.log(`Verification — remaining redacted rows: ${picks} picks, ${deck_cards} deck cards`);
  if (Number(picks) !== 0 || Number(deck_cards) !== 0) {
    console.error("FAILED: redacted rows remain");
    process.exit(1);
  }
}

main();
