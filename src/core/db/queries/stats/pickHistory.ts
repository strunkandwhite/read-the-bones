/**
 * Pick history and distribution query — returns per-draft pick positions
 * and a 15-bucket distribution for a card across all drafts it appeared in.
 */

import type { Client } from "@libsql/client";
import { parseBannedCards } from "../helpers";
import { statsPhaseFilter } from "../../../draftPhases";

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
    DISTRIBUTION_BUCKET_COUNT - 1
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
  cardId?: number
): Promise<PickHistoryResult> {
  const draftFilter = draftId ? "AND d.draft_id = ?" : "";
  const excludeFilter = excludeDraftId ? "AND d.draft_id != ?" : "";

  // When card_id is provided, query directly by ID (skips the name→id lookup join).
  // Otherwise fall back to joining through cards by name.
  const useCardId = cardId !== undefined;
  const cardJoin = useCardId ? "" : "JOIN cards c ON c.name = ?";
  const csCardIdExpr = useCardId ? "?" : "c.card_id";
  const peCardIdExpr = useCardId ? "?" : "c.card_id";

  // Include both 'complete' and 'playing' phases — picks are finalised in both.
  const { fragment: phaseFragment, args: phaseArgs } = statsPhaseFilter("d.phase");

  const args: (string | number)[] = [];
  if (!useCardId) args.push(cardName);
  if (useCardId) args.push(cardId); // for cs.card_id = ?
  if (useCardId) args.push(cardId); // for pe.card_id = ?
  args.push(...phaseArgs);
  if (draftId) args.push(draftId);
  if (excludeDraftId) args.push(excludeDraftId);

  // Left join pick_events to include drafts where card was in pool but not picked.
  // When card_id is provided we use it directly; otherwise join through cards for name matching.
  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.num_seats,
                 d.banned_cards,
                 pe.pick_n,
                 (SELECT COUNT(*) FROM cube_snapshot_cards cs2
                  WHERE cs2.cube_snapshot_id = d.cube_snapshot_id) AS pool_size
          FROM drafts d
          ${cardJoin}
          JOIN cube_snapshot_cards cs ON cs.cube_snapshot_id = d.cube_snapshot_id
            AND cs.card_id = ${csCardIdExpr}
          LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = ${peCardIdExpr}
          WHERE ${phaseFragment} ${draftFilter} ${excludeFilter}
          ORDER BY d.draft_date ASC`,
    args,
  });

  const pickHistory: PickHistoryEntry[] = [];
  const distribution = Array(DISTRIBUTION_BUCKET_COUNT).fill(0);
  const cardNameLower = cardName.toLowerCase();
  let timesBanned = 0;

  const draftIdsAlreadySeen = new Set<string>();

  for (const row of result.rows) {
    draftIdsAlreadySeen.add(row.draft_id as string);

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

  // Count bans from drafts where card wasn't in the cube snapshot
  // (These drafts were missed by the main query's JOIN through cube_snapshot_cards)
  const filterArgs: (string | number)[] = [...phaseArgs];
  if (draftId) filterArgs.push(draftId);
  if (excludeDraftId) filterArgs.push(excludeDraftId);

  const allDraftsResult = await client.execute({
    sql: `SELECT d.draft_id, d.banned_cards
          FROM drafts d
          WHERE ${phaseFragment}
            AND d.banned_cards IS NOT NULL
            ${draftFilter} ${excludeFilter}`,
    args: filterArgs,
  });

  for (const row of allDraftsResult.rows) {
    if (draftIdsAlreadySeen.has(row.draft_id as string)) continue;
    const bannedSet = parseBannedCards(row.banned_cards as string | null);
    if (bannedSet.has(cardNameLower)) {
      timesBanned++;
    }
  }

  return { pickHistory, pickDistribution: distribution, timesBanned };
}
