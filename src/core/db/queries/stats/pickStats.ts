/**
 * Pick statistics query — aggregates pick data for a single card across drafts.
 */

import { getClient } from "../../client";
import { resolveCard } from "../cards";
import { parseBannedCards } from "../helpers";
import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";
import { DEFAULT_POOL_SIZE } from "../../../types";

export interface GetCardPickStatsParams {
  card_name: string;
  card_id?: number;
  exclude_draft_id?: string;
  date_from?: string;
  date_to?: string;
  draft_name?: string;
}

export interface CardPickStatsResult {
  card_name: string;
  drafts_seen: number;
  times_picked: number;
  avg_pick_n: number;
  median_pick_n: number;
  weighted_geomean: number;
  // Play rate fields — present when decklist data exists for this card
  play_rate?: number;
  times_maindecked?: number;
  times_in_pool_with_decklist?: number;
}

/**
 * Get aggregate pick statistics for a card across drafts.
 * Uses the weighted geometric mean formula from calculateStats.ts.
 */
export async function getCardPickStats(
  params: GetCardPickStatsParams
): Promise<CardPickStatsResult | null> {
  const client = await getClient();

  // Resolve the card first (skip if card_id already provided)
  let card_id = params.card_id;
  let card_name = params.card_name;
  if (card_id === undefined) {
    const card = await resolveCard(params.card_name);
    if (!card) return null;
    card_id = card.card_id;
    card_name = card.name;
  }

  // Build query conditions for drafts
  const draftConditions: string[] = [];
  const draftArgs: (string | number)[] = [];

  if (params.date_from) {
    draftConditions.push("d.draft_date >= ?");
    draftArgs.push(params.date_from);
  }

  if (params.date_to) {
    draftConditions.push("d.draft_date <= ?");
    draftArgs.push(params.date_to);
  }

  if (params.draft_name) {
    draftConditions.push("LOWER(d.draft_name) LIKE LOWER(?)");
    draftArgs.push(`%${params.draft_name}%`);
  }

  if (params.exclude_draft_id) {
    draftConditions.push("d.draft_id != ?");
    draftArgs.push(params.exclude_draft_id);
  }

  const draftWhere =
    draftConditions.length > 0
      ? `AND ${draftConditions.join(" AND ")}`
      : "";

  // Get all drafts where this card was available (in cube)
  const draftsWithCardResult = await client.execute({
    sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id
          FROM drafts d
          JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
          WHERE csc.card_id = ? AND d.phase = 'complete' ${draftWhere}`,
    args: [card_id, ...draftArgs],
  });

  if (draftsWithCardResult.rows.length === 0) {
    return {
      card_name: card_name,
      drafts_seen: 0,
      times_picked: 0,
      avg_pick_n: 0,
      median_pick_n: 0,
      weighted_geomean: 0,
    };
  }

  const allDraftIds = draftsWithCardResult.rows.map((r) => r.draft_id as string);

  // Exclude drafts where this card is banned. Cube sizes depend only on
  // draftsWithCardResult, so run that query in parallel with the ban lookup.
  const banPlaceholders = allDraftIds.map(() => "?").join(", ");
  const cubeSnapshotIds = draftsWithCardResult.rows.map((r) => r.cube_snapshot_id as number);
  const cubeSnapshotPlaceholders = cubeSnapshotIds.map(() => "?").join(", ");

  const [bannedResult, cubeSizesResult] = await Promise.all([
    client.execute({
      sql: `SELECT draft_id, banned_cards FROM drafts
            WHERE draft_id IN (${banPlaceholders})
              AND banned_cards IS NOT NULL`,
      args: allDraftIds,
    }),
    client.execute({
      sql: `SELECT cube_snapshot_id, SUM(qty) as total_cards
            FROM cube_snapshot_cards
            WHERE cube_snapshot_id IN (${cubeSnapshotPlaceholders})
            GROUP BY cube_snapshot_id`,
      args: [...cubeSnapshotIds],
    }),
  ]);

  const bannedInDrafts = new Set<string>();
  for (const row of bannedResult.rows) {
    const bannedSet = parseBannedCards(row.banned_cards as string | null);
    if (bannedSet.has(card_name.toLowerCase())) {
      bannedInDrafts.add(row.draft_id as string);
    }
  }

  const draftIds = allDraftIds.filter((id) => !bannedInDrafts.has(id));

  if (draftIds.length === 0) {
    return {
      card_name: card_name,
      drafts_seen: 0,
      times_picked: 0,
      avg_pick_n: 0,
      median_pick_n: 0,
      weighted_geomean: 0,
    };
  }

  const cubeSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    cubeSizes.set(row.cube_snapshot_id as number, row.total_cards as number);
  }

  // Map draft_id to cube_snapshot_id
  const draftCubeSnapshots = new Map<string, number>();
  for (const row of draftsWithCardResult.rows) {
    draftCubeSnapshots.set(row.draft_id as string, row.cube_snapshot_id as number);
  }

  // picks, opt-outs, and deck_cards all depend on draftIds — run in parallel
  const placeholders = draftIds.map(() => "?").join(", ");
  const [picksResult, optOutResult, deckCardsResult] = await Promise.all([
    client.execute({
      sql: `SELECT pe.draft_id, pe.pick_n, pe.seat
            FROM pick_events pe
            WHERE pe.card_id = ? AND pe.draft_id IN (${placeholders})
            ORDER BY pe.draft_id, pe.pick_n`,
      args: [card_id, ...draftIds],
    }),
    client.execute({
      sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${placeholders})`,
      args: draftIds,
    }),
    client.execute({
      sql: `SELECT dc.draft_id, dc.seat, dc.zone
            FROM deck_cards dc
            WHERE dc.card_id = ? AND dc.draft_id IN (${placeholders})`,
      args: [card_id, ...draftIds],
    }),
  ]);

  const optedOut = new Set<string>();
  for (const row of optOutResult.rows) {
    optedOut.add(`${row.draft_id}:${row.seat}`);
  }

  // For cards that appear multiple times in a draft, track copy numbers
  const picksByDraft = new Map<string, { pick_n: number; seat: number }[]>();
  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    // Skip picks from opted-out seats
    if (optedOut.has(`${draftId}:${seat}`)) continue;

    if (!picksByDraft.has(draftId)) {
      picksByDraft.set(draftId, []);
    }
    picksByDraft.get(draftId)!.push({
      pick_n: row.pick_n as number,
      seat,
    });
  }

  // Collect all pick positions for stats
  const pickPositions: number[] = [];
  const weightedItems: { value: number; weight: number }[] = [];

  for (const draftId of draftIds) {
    const picks = picksByDraft.get(draftId) || [];
    // Get actual cube size from cube_snapshot_cards
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    const poolSize = cubeSnapshotId ? (cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE) : DEFAULT_POOL_SIZE;

    if (picks.length > 0) {
      // Card was picked in this draft
      for (let i = 0; i < picks.length; i++) {
        const pick = picks[i];
        const copyNumber = i + 1; // 1st copy, 2nd copy, etc.

        // Use shared utility for weight calculation
        const weight = calculatePickWeight({
          copyNumber,
          wasPicked: true,
        });

        pickPositions.push(pick.pick_n);
        weightedItems.push({
          value: pick.pick_n,
          weight,
        });
      }
    } else {
      // Card was available but not picked - assign pool size as pick position
      // Use shared utility for weight calculation
      const weight = calculatePickWeight({
        copyNumber: 1,
        wasPicked: false,
      });
      weightedItems.push({
        value: poolSize,
        weight,
      });
    }
  }

  // Calculate stats
  const drafts_seen = draftIds.length;
  const times_picked = pickPositions.length;

  let avg_pick_n = 0;
  let median_pick_n = 0;

  if (times_picked > 0) {
    avg_pick_n = pickPositions.reduce((sum, p) => sum + p, 0) / times_picked;

    // Median
    const sorted = [...pickPositions].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    median_pick_n =
      sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
  }

  const weighted_geomean = weightedGeometricMean(weightedItems);

  const result: CardPickStatsResult = {
    card_name: card_name,
    drafts_seen,
    times_picked,
    avg_pick_n: Math.round(avg_pick_n * 10) / 10,
    median_pick_n,
    weighted_geomean: Math.round(weighted_geomean * 10) / 10,
  };

  // Filter deck_cards results to exclude opted-out seats
  const filteredDeckCards = deckCardsResult.rows.filter(
    (r) => !optedOut.has(`${r.draft_id}:${r.seat}`)
  );

  if (filteredDeckCards.length > 0) {
    const timesInPool = filteredDeckCards.length;
    const timesMaindecked = filteredDeckCards.filter(
      (r) => (r.zone as string) === "deck"
    ).length;
    result.times_in_pool_with_decklist = timesInPool;
    result.times_maindecked = timesMaindecked;
    result.play_rate = round3(timesMaindecked / timesInPool);
  }

  return result;
}
