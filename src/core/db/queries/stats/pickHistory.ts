/**
 * Pick history and distribution query — returns per-draft pick positions
 * and a 15-bucket distribution for a card across all drafts it appeared in.
 */

import type { Client } from "@libsql/client";
import { parseBannedCards } from "../helpers";

const DISTRIBUTION_BUCKET_COUNT = 15;
const DISTRIBUTION_BUCKET_SIZE = 30;

export type PickHistoryEntry = {
  draftId: string;
  draftName: string;
  draftDate: string;
  pickPosition: number;
  picked: boolean;
  numSeats: number;
};

export type PickHistoryResult = {
  pickHistory: PickHistoryEntry[];
  pickDistribution: number[];
  timesBanned: number;
};

function getDistributionBucket(pickPosition: number): number {
  return Math.min(
    Math.floor((pickPosition - 1) / DISTRIBUTION_BUCKET_SIZE),
    DISTRIBUTION_BUCKET_COUNT - 1,
  );
}

/**
 * Get per-draft pick positions and distribution for a card.
 * Includes drafts where the card was in the pool but not picked.
 */
export async function getPickHistory(
  client: Client,
  cardName: string,
  draftId?: string,
  excludeDraftId?: string,
): Promise<PickHistoryResult> {
  const draftFilter = draftId ? "AND d.draft_id = ?" : "";
  const excludeFilter = excludeDraftId ? "AND d.draft_id != ?" : "";
  const args: string[] = [cardName];
  if (draftId) args.push(draftId);
  if (excludeDraftId) args.push(excludeDraftId);

  // Left join pick_events to include drafts where card was in pool but not picked.
  // cube_snapshot_cards uses card_id (FK to cards), so we join through cards for name matching.
  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.num_seats,
                 d.banned_cards,
                 pe.pick_n,
                 (SELECT COUNT(*) FROM cube_snapshot_cards cs2
                  WHERE cs2.cube_snapshot_id = d.cube_snapshot_id) AS pool_size
          FROM drafts d
          JOIN cards c ON c.name = ?
          JOIN cube_snapshot_cards cs ON cs.cube_snapshot_id = d.cube_snapshot_id
            AND cs.card_id = c.card_id
          LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = c.card_id
          WHERE d.phase = 'complete' ${draftFilter} ${excludeFilter}
          ORDER BY d.draft_date ASC`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      pickHistory: [],
      pickDistribution: Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
      timesBanned: 0,
    };
  }

  const pickHistory: PickHistoryEntry[] = [];
  const distribution = Array(DISTRIBUTION_BUCKET_COUNT).fill(0);
  const cardNameLower = cardName.toLowerCase();
  let timesBanned = 0;

  for (const row of result.rows) {
    // Skip drafts where this card was banned
    const bannedSet = parseBannedCards(row.banned_cards as string | null);
    if (bannedSet.has(cardNameLower)) {
      timesBanned++;
      continue;
    }

    const picked = row.pick_n !== null;
    const poolSize = row.pool_size as number;
    const pickPosition = picked ? (row.pick_n as number) : poolSize;

    pickHistory.push({
      draftId: row.draft_id as string,
      draftName: row.draft_name as string,
      draftDate: row.draft_date as string,
      pickPosition,
      picked,
      numSeats: row.num_seats as number,
    });

    const bucket = getDistributionBucket(pickPosition);
    distribution[bucket]++;
  }

  return { pickHistory, pickDistribution: distribution, timesBanned };
}
