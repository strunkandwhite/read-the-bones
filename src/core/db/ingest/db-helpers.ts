import type { Client } from "@libsql/client";
import { log } from "./utils";

/**
 * Reset a draft's domain data without deleting the draft record.
 * Clears picks, matches, decklists, opt-outs, and nulls domain hashes.
 * The draft row and cube snapshot are preserved.
 */
export async function resetDraft(client: Client, draftId: string): Promise<void> {
  await client.batch([
    { sql: "DELETE FROM match_events WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM deck_cards WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM deck_hashes WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM pick_events WHERE draft_id = ?", args: [draftId] },
    { sql: "DELETE FROM privacy_opt_outs WHERE draft_id = ?", args: [draftId] },
    {
      sql: "UPDATE drafts SET pool_hash = NULL, picks_hash = NULL, matches_hash = NULL, num_seats = 0, is_complete = 0 WHERE draft_id = ?",
      args: [draftId],
    },
  ]);
}

/**
 * Insert opt-out records for players who have opted out.
 * Matches drafter names against the opt-out list (case-insensitive).
 */
export async function insertOptOuts(
  client: Client,
  draftId: string,
  drafterNames: string[],
  optOutNames: Set<string>
): Promise<number> {
  let count = 0;

  for (let i = 0; i < drafterNames.length; i++) {
    const name = drafterNames[i];
    if (optOutNames.has(name.toLowerCase())) {
      const seat = i + 1; // Convert to 1-indexed
      await client.execute({
        sql: "INSERT OR IGNORE INTO privacy_opt_outs (draft_id, seat) VALUES (?, ?)",
        args: [draftId, seat],
      });
      count++;
    }
  }

  return count;
}

/**
 * Get or create a cube snapshot, return cube_snapshot_id.
 */
export async function ensureCubeSnapshot(
  client: Client,
  cubeHash: string,
  cardIds: Map<string, { cardId: number; qty: number }>
): Promise<number> {
  // Check if cube snapshot already exists
  const existing = await client.execute({
    sql: "SELECT cube_snapshot_id FROM cube_snapshots WHERE cube_hash = ?",
    args: [cubeHash],
  });

  if (existing.rows.length > 0) {
    const cubeSnapshotId = existing.rows[0].cube_snapshot_id as number;

    // Verify card_ids and qty values are consistent with current resolution
    const snapshotCards = await client.execute({
      sql: "SELECT card_id, qty FROM cube_snapshot_cards WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });
    const existingCardIds = new Set(
      snapshotCards.rows.map((r) => r.card_id as number)
    );
    const currentCardIds = new Set(
      Array.from(cardIds.values()).map((v) => v.cardId)
    );

    const consistent =
      existingCardIds.size === currentCardIds.size &&
      Array.from(currentCardIds).every((id) => existingCardIds.has(id));

    if (consistent) {
      // Check qty values are up to date (may be stale if snapshot predates qty tracking)
      const existingQtys = new Map<number, number>();
      for (const row of snapshotCards.rows) {
        existingQtys.set(row.card_id as number, row.qty as number);
      }

      let qtysMatch = true;
      for (const [, { cardId, qty }] of cardIds) {
        if (existingQtys.get(cardId) !== qty) {
          qtysMatch = false;
          break;
        }
      }

      if (!qtysMatch) {
        for (const [, { cardId, qty }] of cardIds) {
          if (existingQtys.get(cardId) !== qty) {
            await client.execute({
              sql: "UPDATE cube_snapshot_cards SET qty = ? WHERE cube_snapshot_id = ? AND card_id = ?",
              args: [qty, cubeSnapshotId, cardId],
            });
          }
        }
      }

      return cubeSnapshotId;
    }

    // Card IDs changed (e.g. DFC resolution fixed) — recreate snapshot cards
    log(
      `Cube snapshot ${cubeSnapshotId} has stale card_ids, recreating...`
    );
    await client.execute({
      sql: "DELETE FROM cube_snapshot_cards WHERE cube_snapshot_id = ?",
      args: [cubeSnapshotId],
    });

    for (const [, { cardId, qty }] of cardIds) {
      await client.execute({
        sql: "INSERT INTO cube_snapshot_cards (cube_snapshot_id, card_id, qty) VALUES (?, ?, ?)",
        args: [cubeSnapshotId, cardId, qty],
      });
    }

    return cubeSnapshotId;
  }

  // Create new cube snapshot
  const result = await client.execute({
    sql: "INSERT INTO cube_snapshots (cube_hash) VALUES (?)",
    args: [cubeHash],
  });

  const cubeSnapshotId = Number(result.lastInsertRowid);

  // Insert cube_snapshot_cards
  for (const [, { cardId, qty }] of cardIds) {
    await client.execute({
      sql: "INSERT INTO cube_snapshot_cards (cube_snapshot_id, card_id, qty) VALUES (?, ?, ?)",
      args: [cubeSnapshotId, cardId, qty],
    });
  }

  return cubeSnapshotId;
}
