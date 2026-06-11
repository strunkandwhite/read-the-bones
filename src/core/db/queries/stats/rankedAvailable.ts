/**
 * Ranked available cards query — bulk-ranks available cards by historical performance.
 */

import { getClient } from "../../client";
import { getSeatsMatchingColors, placeholders } from "../helpers";
import { getAvailableCards } from "../picks";
import { calculatePickWeight, round3, weightedGeometricMean } from "../../../utils";
import { wilsonInterval } from "../../../wilsonInterval";
import { DEFAULT_POOL_SIZE } from "../../../types";
import { MIN_SAMPLE_SIZE } from "../../../constants";

export interface RankAvailableCardsParams {
  draft_id: string;
  before_pick_n: number;
  color?: string;
  type_contains?: string;
  deck_colors?: string;
  limit?: number;
  sort_by?: "geomean_pick" | "win_rate" | "play_rate";
}

/**
 * Flat shape for ranked card output (vs CardStatsResult which nests filtered inside play/wins).
 * play_rate_filtered / win_rate_filtered correspond to CardStatsResult's play.filtered / wins.filtered.
 */
export interface RankedCard {
  card_name: string;
  geomean_pick: number;
  drafts_in_pool: number;
  times_picked: number;
  play_rate: number | null;
  play_rate_filtered: boolean;
  win_rate: number | null;
  win_rate_ci: { lower: number; center: number; upper: number } | null;
  low_sample: boolean;
  win_rate_filtered: boolean;
}

export interface RankAvailableCardsResult {
  draft_id: string;
  before_pick_n: number;
  total_available: number;
  cards: RankedCard[];
}

/**
 * Get available cards before a pick, ranked by historical performance.
 * Combines getAvailableCards + batch pick/play/win stats in one efficient call.
 */
export async function rankAvailableCards(
  params: RankAvailableCardsParams
): Promise<RankAvailableCardsResult> {
  const limit = params.limit ?? 20;
  const sortBy = params.sort_by ?? "geomean_pick";

  const client = await getClient();

  // Step 1: Get available cards
  const available = await getAvailableCards(client, {
    draft_id: params.draft_id,
    before_pick_n: params.before_pick_n,
    color: params.color,
    type_contains: params.type_contains,
  });

  if (available.cards.length === 0) {
    return {
      draft_id: params.draft_id,
      before_pick_n: params.before_pick_n,
      total_available: 0,
      cards: [],
    };
  }

  const cardNames = available.cards.map((c) => c.card_name);

  // Step 2: Batch resolve all card IDs
  const cardsResult = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE name IN (${placeholders(cardNames.length)})`,
    args: cardNames,
  });

  const cardIdMap = new Map<number, string>();
  const nameToId = new Map<string, number>();
  for (const row of cardsResult.rows) {
    const id = row.card_id as number;
    const name = row.name as string;
    cardIdMap.set(id, name);
    nameToId.set(name, id);
  }

  const cardIds = [...cardIdMap.keys()];
  if (cardIds.length === 0) {
    return {
      draft_id: params.draft_id,
      before_pick_n: params.before_pick_n,
      total_available: available.cards.length,
      cards: [],
    };
  }

  const idPlaceholderStr = placeholders(cardIds.length);

  // Step 3: Batch pick stats — get all drafts where these cards appear
  const [draftsResult, picksResult, cubeSizesResult] = await Promise.all([
    client.execute({
      sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id, csc.card_id
            FROM drafts d
            JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE csc.card_id IN (${idPlaceholderStr})`,
      args: cardIds,
    }),
    client.execute({
      sql: `SELECT pe.card_id, pe.draft_id, pe.pick_n
            FROM pick_events pe
            WHERE pe.card_id IN (${idPlaceholderStr})`,
      args: cardIds,
    }),
    client.execute({
      sql: `SELECT cube_snapshot_id, SUM(qty) as total_cards
            FROM cube_snapshot_cards
            WHERE cube_snapshot_id IN (
              SELECT DISTINCT d.cube_snapshot_id FROM drafts d
              JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
              WHERE csc.card_id IN (${idPlaceholderStr})
            )
            GROUP BY cube_snapshot_id`,
      args: cardIds,
    }),
  ]);

  // Build lookup structures for pick stats
  const cubeSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    cubeSizes.set(row.cube_snapshot_id as number, row.total_cards as number);
  }

  // Map: cardId -> Set of draftIds where card was in pool
  const cardDrafts = new Map<number, Map<string, number>>(); // cardId -> (draftId -> cubeSnapshotId)
  for (const row of draftsResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const cubeSnapshotId = row.cube_snapshot_id as number;
    if (!cardDrafts.has(cardId)) cardDrafts.set(cardId, new Map());
    cardDrafts.get(cardId)!.set(draftId, cubeSnapshotId);
  }

  // Map: cardId -> draftId -> pick positions
  const cardPicks = new Map<number, Map<string, number[]>>();
  for (const row of picksResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const pickN = row.pick_n as number;
    if (!cardPicks.has(cardId)) cardPicks.set(cardId, new Map());
    const byDraft = cardPicks.get(cardId)!;
    if (!byDraft.has(draftId)) byDraft.set(draftId, []);
    byDraft.get(draftId)!.push(pickN);
  }

  // Step 4: Batch play/win stats
  const [playResult, winResult] = await Promise.all([
    client.execute({
      sql: `SELECT dc.card_id, dc.draft_id, dc.seat, dc.zone
            FROM deck_cards dc
            WHERE dc.card_id IN (${idPlaceholderStr})`,
      args: cardIds,
    }),
    client.execute({
      sql: `SELECT dc.card_id, dc.draft_id, dc.seat,
              SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                       WHEN me.seat2 = dc.seat THEN me.seat2_wins
                       ELSE 0 END) AS game_wins,
              SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                       WHEN me.seat2 = dc.seat THEN me.seat1_wins
                       ELSE 0 END) AS game_losses
            FROM deck_cards dc
            JOIN match_events me ON me.draft_id = dc.draft_id
              AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
            WHERE dc.card_id IN (${idPlaceholderStr}) AND dc.zone = 'deck'
            GROUP BY dc.card_id, dc.draft_id, dc.seat`,
      args: cardIds,
    }),
  ]);

  // Collect all draft IDs for opt-out and color filtering
  const allDraftIds = new Set<string>();
  for (const row of playResult.rows) allDraftIds.add(row.draft_id as string);
  for (const row of winResult.rows) allDraftIds.add(row.draft_id as string);

  // Get opt-outs for all relevant drafts
  const optedOut = new Set<string>();
  if (allDraftIds.size > 0) {
    const allDraftIdArr = [...allDraftIds];
    const optOutResult = await client.execute({
      sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${placeholders(allDraftIdArr.length)})`,
      args: allDraftIdArr,
    });
    for (const row of optOutResult.rows) {
      optedOut.add(`${row.draft_id}:${row.seat}`);
    }
  }

  // If deck_colors is set, get matching seats across all relevant drafts
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(client, [...allDraftIds], params.deck_colors);
  }

  // Aggregate play stats per card, skipping opted-out and non-matching seats
  // When deck_colors is set, also compute overall stats as fallback for sparse archetypes
  const cardPlayStats = new Map<number, { maindecked: number; total: number }>();
  const cardPlayStatsOverall = new Map<number, { maindecked: number; total: number }>();
  for (const row of playResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const seat = row.seat as number;
    const seatKey = `${draftId}:${seat}`;
    if (optedOut.has(seatKey)) continue;

    // Overall stats (always computed when filtering)
    if (matchingSeats) {
      if (!cardPlayStatsOverall.has(cardId)) cardPlayStatsOverall.set(cardId, { maindecked: 0, total: 0 });
      const overall = cardPlayStatsOverall.get(cardId)!;
      overall.total++;
      if ((row.zone as string) === "deck") overall.maindecked++;
    }

    // Filtered stats
    if (matchingSeats && !matchingSeats.has(seatKey)) continue;
    if (!cardPlayStats.has(cardId)) cardPlayStats.set(cardId, { maindecked: 0, total: 0 });
    const stats = cardPlayStats.get(cardId)!;
    stats.total++;
    if ((row.zone as string) === "deck") stats.maindecked++;
  }

  // Aggregate win stats per card, skipping opted-out and non-matching seats
  const cardWinStats = new Map<number, { wins: number; losses: number; seats: number }>();
  const cardWinStatsOverall = new Map<number, { wins: number; losses: number; seats: number }>();
  for (const row of winResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const seat = row.seat as number;
    const seatKey = `${draftId}:${seat}`;
    if (optedOut.has(seatKey)) continue;

    // Overall stats (always computed when filtering)
    if (matchingSeats) {
      if (!cardWinStatsOverall.has(cardId)) cardWinStatsOverall.set(cardId, { wins: 0, losses: 0, seats: 0 });
      const overall = cardWinStatsOverall.get(cardId)!;
      overall.wins += row.game_wins as number;
      overall.losses += row.game_losses as number;
      overall.seats++;
    }

    // Filtered stats
    if (matchingSeats && !matchingSeats.has(seatKey)) continue;
    if (!cardWinStats.has(cardId)) cardWinStats.set(cardId, { wins: 0, losses: 0, seats: 0 });
    const stats = cardWinStats.get(cardId)!;
    stats.wins += row.game_wins as number;
    stats.losses += row.game_losses as number;
    stats.seats++;
  }

  // Step 5: Compute per-card stats
  const rankedCards: RankedCard[] = [];

  for (const cardName of cardNames) {
    const cardId = nameToId.get(cardName);
    if (cardId === undefined) continue;

    // Pick stats: compute weighted geometric mean
    const drafts = cardDrafts.get(cardId) ?? new Map();
    const picks = cardPicks.get(cardId) ?? new Map();
    const weightedItems: { value: number; weight: number }[] = [];
    let timesPicked = 0;

    for (const [draftId, cubeSnapshotId] of drafts) {
      const draftPicks = picks.get(draftId);
      const poolSize = cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE;

      if (draftPicks && draftPicks.length > 0) {
        for (let i = 0; i < draftPicks.length; i++) {
          weightedItems.push({
            value: draftPicks[i],
            weight: calculatePickWeight({ copyNumber: i + 1, wasPicked: true }),
          });
          timesPicked++;
        }
      } else {
        weightedItems.push({
          value: poolSize,
          weight: calculatePickWeight({ copyNumber: 1, wasPicked: false }),
        });
      }
    }

    const geomean = weightedItems.length > 0
      ? Math.round(weightedGeometricMean(weightedItems) * 10) / 10
      : 0;

    // Play stats — use filtered when available, fall back to overall
    const play = cardPlayStats.get(cardId);
    const playOverall = cardPlayStatsOverall.get(cardId);
    let playRate: number | null = null;
    let playFiltered = false;

    if (play && play.total > 0) {
      playRate = round3(play.maindecked / play.total);
      playFiltered = !!matchingSeats;
    } else if (matchingSeats && playOverall && playOverall.total > 0) {
      playRate = round3(playOverall.maindecked / playOverall.total);
      playFiltered = false;
    }

    // Win stats — use filtered when available, fall back to overall
    const win = cardWinStats.get(cardId);
    const winOverall = cardWinStatsOverall.get(cardId);
    let winRate: number | null = null;
    let winRateCi: { lower: number; center: number; upper: number } | null = null;
    let lowSample = false;
    let winFiltered = false;

    if (win && (win.wins + win.losses) > 0) {
      const total = win.wins + win.losses;
      winRate = round3(win.wins / total);
      winRateCi = wilsonInterval(win.wins, total);
      lowSample = win.seats < MIN_SAMPLE_SIZE;
      winFiltered = !!matchingSeats;
    } else if (matchingSeats && winOverall && (winOverall.wins + winOverall.losses) > 0) {
      const total = winOverall.wins + winOverall.losses;
      winRate = round3(winOverall.wins / total);
      winRateCi = wilsonInterval(winOverall.wins, total);
      lowSample = winOverall.seats < MIN_SAMPLE_SIZE;
      winFiltered = false;
    }

    rankedCards.push({
      card_name: cardName,
      geomean_pick: geomean,
      drafts_in_pool: drafts.size,
      times_picked: timesPicked,
      play_rate: playRate,
      play_rate_filtered: playFiltered,
      win_rate: winRate,
      win_rate_ci: winRateCi,
      low_sample: lowSample,
      win_rate_filtered: winFiltered,
    });
  }

  // Sort
  rankedCards.sort((a, b) => {
    if (sortBy === "win_rate") {
      // Higher win rate first, nulls last
      if (a.win_rate === null && b.win_rate === null) return a.geomean_pick - b.geomean_pick;
      if (a.win_rate === null) return 1;
      if (b.win_rate === null) return -1;
      return b.win_rate - a.win_rate;
    }
    if (sortBy === "play_rate") {
      if (a.play_rate === null && b.play_rate === null) return a.geomean_pick - b.geomean_pick;
      if (a.play_rate === null) return 1;
      if (b.play_rate === null) return -1;
      return b.play_rate - a.play_rate;
    }
    // Default: geomean_pick (lower = better)
    return a.geomean_pick - b.geomean_pick;
  });

  return {
    draft_id: params.draft_id,
    before_pick_n: params.before_pick_n,
    total_available: available.cards.length,
    cards: rankedCards.slice(0, limit),
  };
}
