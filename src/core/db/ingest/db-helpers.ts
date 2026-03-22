import type { Client } from "@libsql/client";
import { log } from "./utils";

/**
 * Check if a draft exists and return its import hash.
 */
export async function getDraftImportHash(
  client: Client,
  draftId: string
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT import_hash FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].import_hash as string;
}

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
 * Delete a draft and all related data.
 */
export async function deleteDraft(client: Client, draftId: string): Promise<void> {
  // Delete in order respecting foreign key constraints
  await client.execute({
    sql: "DELETE FROM match_events WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM deck_cards WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM deck_hashes WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
}

/**
 * Create a draft record.
 */
export async function createDraft(
  client: Client,
  draftId: string,
  draftName: string,
  draftDate: string,
  cubeSnapshotId: number,
  importHash: string,
  numSeats: number,
  isComplete: boolean,
  sheetId: string | null,
  bannedCards: string | null
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, import_hash, num_seats, is_complete, sheet_id, banned_cards)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [draftId, draftName, draftDate, cubeSnapshotId, importHash, numSeats, isComplete ? 1 : 0, sheetId, bannedCards],
  });
}

/**
 * Insert a pick event.
 */
export async function insertPickEvent(
  client: Client,
  draftId: string,
  pickN: number,
  seat: number,
  cardId: number
): Promise<void> {
  await client.execute({
    sql: "INSERT INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
    args: [draftId, pickN, seat, cardId],
  });
}

/**
 * Insert a match event.
 */
export async function insertMatchEvent(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins)
          VALUES (?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins],
  });
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
 * Ensure a card exists in the cards table, return card_id.
 */
export async function ensureCard(
  client: Client,
  oracleId: string,
  name: string,
  scryfallJson: string | null
): Promise<number> {
  // Try to find existing card by oracle_id
  const existing = await client.execute({
    sql: "SELECT card_id, scryfall_json FROM cards WHERE oracle_id = ?",
    args: [oracleId],
  });

  if (existing.rows.length > 0) {
    const cardId = existing.rows[0].card_id as number;
    const existingJson = existing.rows[0].scryfall_json as string | null;

    // Update scryfall_json if we have new data but the existing record is missing it
    if (scryfallJson && !existingJson) {
      await client.execute({
        sql: "UPDATE cards SET scryfall_json = ? WHERE card_id = ?",
        args: [scryfallJson, cardId],
      });
    }

    return cardId;
  }

  // Insert new card
  const result = await client.execute({
    sql: "INSERT INTO cards (oracle_id, name, scryfall_json) VALUES (?, ?, ?)",
    args: [oracleId, name, scryfallJson],
  });

  return Number(result.lastInsertRowid);
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
