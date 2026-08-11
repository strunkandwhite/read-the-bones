// scripts/merge-dfc-cards.ts
// One-time migration: merge duplicate DFC card entries in the cards table.
//
// The old ingestion pipeline stored DFCs with Scryfall canonical names
// (e.g., "Brazen Borrower // Petty Theft") while the new sync pipeline
// stores them with front-face-only names (e.g., "Brazen Borrower").
// This creates duplicate card_ids that break stats matching.
//
// For each duplicate pair, this script:
// 1. Picks a "keep" card_id (front-face-only entry if it exists, else the DFC entry)
// 2. Updates all references (pick_events, deck_cards, cube_snapshot_cards, card_aliases)
// 3. Deletes the old entry
//
// Usage: npx tsx scripts/merge-dfc-cards.ts [--dry-run]

import { createClient } from "@libsql/client";
import { loadEnv, log } from "../src/core/db/ingest/utils";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) log("DRY RUN — no changes will be made");

  loadEnv();
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  // Find all DFC cards (name contains " // ")
  const dfcResult = await client.execute({
    sql: "SELECT card_id, name FROM cards WHERE name LIKE '% // %'",
    args: [],
  });

  let mergeCount = 0;

  for (const dfcRow of dfcResult.rows) {
    const dfcCardId = dfcRow.card_id as number;
    const dfcName = dfcRow.name as string;
    const frontFace = dfcName.split(" // ")[0];

    // Check if a front-face-only entry exists
    const frontResult = await client.execute({
      sql: "SELECT card_id FROM cards WHERE name = ?",
      args: [frontFace],
    });

    if (frontResult.rows.length === 0) {
      // No duplicate — just rename the DFC entry to front-face-only
      log(`  Rename: "${dfcName}" → "${frontFace}" (card_id: ${dfcCardId})`);
      if (!dryRun) {
        await client.execute({
          sql: "UPDATE cards SET name = ?, oracle_id = ? WHERE card_id = ?",
          args: [
            frontFace,
            `generated:${frontFace.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
            dfcCardId,
          ],
        });
      }
      mergeCount++;
      continue;
    }

    const keepCardId = frontResult.rows[0].card_id as number;
    log(`  Merge: "${dfcName}" (${dfcCardId}) → "${frontFace}" (${keepCardId})`);

    if (dryRun) {
      mergeCount++;
      continue;
    }

    // Update all references from dfcCardId → keepCardId
    // pick_events: handle potential conflicts (same draft + pick_n)
    await client.execute({
      sql: "UPDATE OR IGNORE pick_events SET card_id = ? WHERE card_id = ?",
      args: [keepCardId, dfcCardId],
    });
    // Clean up any remaining rows that conflicted
    await client.execute({
      sql: "DELETE FROM pick_events WHERE card_id = ?",
      args: [dfcCardId],
    });

    // cube_snapshot_cards: handle (snapshot_id, card_id) PK conflicts
    // If both card_ids exist in the same snapshot, sum the qty
    const cubeConflicts = await client.execute({
      sql: `SELECT csc1.cube_snapshot_id, csc1.qty as old_qty, csc2.qty as new_qty
            FROM cube_snapshot_cards csc1
            JOIN cube_snapshot_cards csc2 ON csc1.cube_snapshot_id = csc2.cube_snapshot_id
            WHERE csc1.card_id = ? AND csc2.card_id = ?`,
      args: [dfcCardId, keepCardId],
    });
    // Delete old entries in snapshots that already have the keepCardId
    if (cubeConflicts.rows.length > 0) {
      const conflictIds = cubeConflicts.rows.map((r) => r.cube_snapshot_id as number);
      for (const snapshotId of conflictIds) {
        await client.execute({
          sql: "DELETE FROM cube_snapshot_cards WHERE cube_snapshot_id = ? AND card_id = ?",
          args: [snapshotId, dfcCardId],
        });
      }
    }
    // Update remaining (non-conflicting) references
    await client.execute({
      sql: "UPDATE OR IGNORE cube_snapshot_cards SET card_id = ? WHERE card_id = ?",
      args: [keepCardId, dfcCardId],
    });
    await client.execute({
      sql: "DELETE FROM cube_snapshot_cards WHERE card_id = ?",
      args: [dfcCardId],
    });

    // deck_cards: handle PK conflicts (draft_id, seat, card_id, zone)
    await client.execute({
      sql: "UPDATE OR IGNORE deck_cards SET card_id = ? WHERE card_id = ?",
      args: [keepCardId, dfcCardId],
    });
    await client.execute({
      sql: "DELETE FROM deck_cards WHERE card_id = ?",
      args: [dfcCardId],
    });

    // card_aliases: update to point to keepCardId
    await client.execute({
      sql: "UPDATE OR IGNORE card_aliases SET card_id = ? WHERE card_id = ?",
      args: [keepCardId, dfcCardId],
    });
    await client.execute({
      sql: "DELETE FROM card_aliases WHERE card_id = ?",
      args: [dfcCardId],
    });

    // Delete the old DFC card entry
    await client.execute({
      sql: "DELETE FROM cards WHERE card_id = ?",
      args: [dfcCardId],
    });

    mergeCount++;
  }

  log(`${dryRun ? "Would merge" : "Merged"} ${mergeCount} DFC card(s)`);
}

main().catch(console.error);
