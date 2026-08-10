/**
 * Pick statistics query — aggregates pick data for a single card across drafts.
 */

import type { Client } from "@libsql/client";
import { resolveCard } from "../cards";
import { parseBannedCards, placeholders } from "../helpers";
import { round3 } from "../../../utils";
import { pickScore, type DraftObservation } from "../../../pickScore";
import { DEFAULT_POOL_SIZE } from "../../../types";
import { statsPhaseFilter } from "../../../draftPhases";
import { sessionsAgoByDraft } from "../../../draftSessions";

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
 * The weighted score comes from the canonical formula in pickScore.ts.
 */
export async function getCardPickStats(
  client: Client,
  params: GetCardPickStatsParams
): Promise<CardPickStatsResult | null> {
  // Resolve the card first (skip if card_id already provided)
  let card_id = params.card_id;
  let card_name = params.card_name;
  if (card_id === undefined) {
    const card = await resolveCard(client, params.card_name);
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

  // Get all drafts where this card was available (in cube).
  // Include both 'complete' and 'playing' phases — picks are finalised in both.
  const { fragment: phaseFragment, args: phaseArgs } = statsPhaseFilter("d.phase");
  const draftsWithCardResult = await client.execute({
    sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id, d.draft_date
          FROM drafts d
          JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
          WHERE csc.card_id = ? AND ${phaseFragment} ${draftWhere}`,
    args: [card_id, ...phaseArgs, ...draftArgs],
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
  // draftsWithCardResult, so run that query in parallel with the ban lookup
  // and with the session-ordinal draft set below.
  const cubeSnapshotIds = draftsWithCardResult.rows.map((r) => r.cube_snapshot_id as number);

  const [bannedResult, cubeSizesResult, allStatsDraftsResult] = await Promise.all([
    client.execute({
      sql: `SELECT draft_id, banned_cards FROM drafts
            WHERE draft_id IN (${placeholders(allDraftIds.length)})
              AND banned_cards IS NOT NULL`,
      args: allDraftIds,
    }),
    client.execute({
      sql: `SELECT cube_snapshot_id, SUM(qty) as total_cards
            FROM cube_snapshot_cards
            WHERE cube_snapshot_id IN (${placeholders(cubeSnapshotIds.length)})
            GROUP BY cube_snapshot_id`,
      args: [...cubeSnapshotIds],
    }),
    // Session ordinals span every stats-phase draft, not the filtered subset:
    // how much drafting has happened since an observation is a fact about the
    // world, not about the current query. Numbering a filtered set densely
    // would close the gap left by an excluded interior session and silently
    // re-weight every older observation. No ban filter either: a draft where
    // THIS card was banned still happened and still occupies a session slot
    // for numbering purposes — the ban only removes it from draftIds, the set
    // that produces observations, below.
    client.execute({
      sql: `SELECT draft_id, draft_date FROM drafts d WHERE ${phaseFragment}`,
      args: [...phaseArgs],
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

  // draftIds is always a subset of allStatsDraftsResult's rows (that query
  // has no cube join or ban filter, so it is a strict superset of every
  // narrower draft set derived above), so sessionsAgo.get(draftId)! below
  // is always defined.
  const sessionsAgo = sessionsAgoByDraft(
    allStatsDraftsResult.rows.map((row) => ({
      draftId: row.draft_id as string,
      draftDate: row.draft_date as string,
    })),
  );

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

  // picks and deck_cards both depend on draftIds — run in parallel
  const ph = placeholders(draftIds.length);
  const [picksResult, deckCardsResult] = await Promise.all([
    client.execute({
      sql: `SELECT pe.draft_id, pe.pick_n, pe.seat
            FROM pick_events pe
            WHERE pe.card_id = ? AND pe.draft_id IN (${ph})
            ORDER BY pe.draft_id, pe.pick_n`,
      args: [card_id, ...draftIds],
    }),
    client.execute({
      sql: `SELECT dc.draft_id, dc.seat, dc.zone
            FROM deck_cards dc
            WHERE dc.card_id = ? AND dc.draft_id IN (${ph})`,
      args: [card_id, ...draftIds],
    }),
  ]);

  // For cards that appear multiple times in a draft, track copy numbers
  const picksByDraft = new Map<string, { pick_n: number; seat: number }[]>();
  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const seat = row.seat as number;

    if (!picksByDraft.has(draftId)) {
      picksByDraft.set(draftId, []);
    }
    picksByDraft.get(draftId)!.push({
      pick_n: row.pick_n as number,
      seat,
    });
  }

  // Taken positions feed avg/median; observations feed the weighted score.
  const pickPositions: number[] = [];
  const observations: DraftObservation[] = [];

  for (const draftId of draftIds) {
    const picks = picksByDraft.get(draftId) || [];
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    const poolSize = cubeSnapshotId
      ? cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE
      : DEFAULT_POOL_SIZE;

    const positions = picks.map((pick) => pick.pick_n);
    pickPositions.push(...positions);
    observations.push({
      sessionsAgo: sessionsAgo.get(draftId)!,
      pickPositions: positions,
      poolSize,
    });
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

  const weighted_geomean = pickScore(observations);

  const result: CardPickStatsResult = {
    card_name: card_name,
    drafts_seen,
    times_picked,
    avg_pick_n: Math.round(avg_pick_n * 10) / 10,
    median_pick_n,
    weighted_geomean: Math.round(weighted_geomean * 10) / 10,
  };

  if (deckCardsResult.rows.length > 0) {
    const timesInPool = deckCardsResult.rows.length;
    const timesMaindecked = deckCardsResult.rows.filter(
      (r) => (r.zone as string) === "deck"
    ).length;
    result.times_in_pool_with_decklist = timesInPool;
    result.times_maindecked = timesMaindecked;
    result.play_rate = round3(timesMaindecked / timesInPool);
  }

  return result;
}
