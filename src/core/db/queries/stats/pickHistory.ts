/**
 * Pick history and distribution query — returns per-draft pick positions
 * and a 15-bucket distribution for a card across all drafts it appeared in.
 */

import type { Client } from "@libsql/client";

const DISTRIBUTION_BUCKET_COUNT = 15;
const DISTRIBUTION_BUCKET_SIZE = 30;

export type PickHistoryEntry = {
  draftId: string;
  draftName: string;
  draftDate: string;
  pickPosition: number;
  picked: boolean;
};

export type PickHistoryResult = {
  pickHistory: PickHistoryEntry[];
  pickDistribution: number[];
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
): Promise<PickHistoryResult> {
  const draftFilter = draftId ? "AND d.draft_id = ?" : "";
  const args: string[] = [cardName];
  if (draftId) args.push(draftId);

  // Left join pick_events to include drafts where card was in pool but not picked.
  // cube_snapshot_cards uses card_id (FK to cards), so we join through cards for name matching.
  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date,
                 pe.pick_n,
                 (SELECT COUNT(*) FROM cube_snapshot_cards cs2
                  WHERE cs2.cube_snapshot_id = d.cube_snapshot_id) AS pool_size
          FROM drafts d
          JOIN cards c ON c.name = ?
          JOIN cube_snapshot_cards cs ON cs.cube_snapshot_id = d.cube_snapshot_id
            AND cs.card_id = c.card_id
          LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = c.card_id
          WHERE d.phase IS NOT NULL ${draftFilter}
          ORDER BY d.draft_date ASC`,
    args,
  });

  if (result.rows.length === 0) {
    return {
      pickHistory: [],
      pickDistribution: Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
    };
  }

  const pickHistory: PickHistoryEntry[] = [];
  const distribution = Array(DISTRIBUTION_BUCKET_COUNT).fill(0);

  for (const row of result.rows) {
    const picked = row.pick_n !== null;
    const poolSize = row.pool_size as number;
    const pickPosition = picked ? (row.pick_n as number) : poolSize;

    pickHistory.push({
      draftId: row.draft_id as string,
      draftName: row.draft_name as string,
      draftDate: row.draft_date as string,
      pickPosition,
      picked,
    });

    const bucket = getDistributionBucket(pickPosition);
    distribution[bucket]++;
  }

  return { pickHistory, pickDistribution: distribution };
}
