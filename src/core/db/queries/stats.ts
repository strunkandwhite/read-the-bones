/**
 * Aggregate statistics queries (getCardPickStats, getCardStats, rankAvailableCards).
 */

import { getClient } from "../client";
import { getSeatsMatchingColors } from "./helpers";
import { resolveCard, lookupCard } from "./cards";
import { getAvailableCards } from "./picks";
import { getCardPlayStats, getCardWinStats } from "./decklists";
import { calculatePickWeight, weightedGeometricMean, wilsonInterval } from "../../utils";
import { DEFAULT_POOL_SIZE } from "../../types";

export interface GetCardPickStatsParams {
  card_name: string;
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

  // Resolve the card first
  const card = await resolveCard(params.card_name);
  if (!card) return null;

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

  const draftWhere =
    draftConditions.length > 0
      ? `AND ${draftConditions.join(" AND ")}`
      : "";

  // Get all drafts where this card was available (in cube)
  const draftsWithCardResult = await client.execute({
    sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id
          FROM drafts d
          JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
          WHERE csc.card_id = ? ${draftWhere}`,
    args: [card.card_id, ...draftArgs],
  });

  if (draftsWithCardResult.rows.length === 0) {
    return {
      card_name: card.name,
      drafts_seen: 0,
      times_picked: 0,
      avg_pick_n: 0,
      median_pick_n: 0,
      weighted_geomean: 0,
    };
  }

  const draftIds = draftsWithCardResult.rows.map((r) => r.draft_id as string);

  // Get all picks of this card across those drafts
  const placeholders = draftIds.map(() => "?").join(", ");
  const picksResult = await client.execute({
    sql: `SELECT pe.draft_id, pe.pick_n, pe.seat
          FROM pick_events pe
          WHERE pe.card_id = ? AND pe.draft_id IN (${placeholders})
          ORDER BY pe.draft_id, pe.pick_n`,
    args: [card.card_id, ...draftIds],
  });

  // Get cube sizes for each draft
  const cubeSnapshotIds = draftsWithCardResult.rows.map((r) => r.cube_snapshot_id as number);
  const cubeSnapshotPlaceholders = cubeSnapshotIds.map(() => "?").join(", ");

  const cubeSizesResult = await client.execute({
    sql: `SELECT cube_snapshot_id, SUM(qty) as total_cards
          FROM cube_snapshot_cards
          WHERE cube_snapshot_id IN (${cubeSnapshotPlaceholders})
          GROUP BY cube_snapshot_id`,
    args: [...cubeSnapshotIds],
  });

  const cubeSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    cubeSizes.set(row.cube_snapshot_id as number, row.total_cards as number);
  }

  // Map draft_id to cube_snapshot_id
  const draftCubeSnapshots = new Map<string, number>();
  for (const row of draftsWithCardResult.rows) {
    draftCubeSnapshots.set(row.draft_id as string, row.cube_snapshot_id as number);
  }

  // Load opt-outs for relevant drafts
  const optOutPlaceholders = draftIds.map(() => "?").join(", ");
  const optOutResult = await client.execute({
    sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${optOutPlaceholders})`,
    args: draftIds,
  });

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

  // Query play rate data from deck_cards if any exist for this card
  const deckCardsResult = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, dc.zone
          FROM deck_cards dc
          WHERE dc.card_id = ? AND dc.draft_id IN (${placeholders})`,
    args: [card.card_id, ...draftIds],
  });

  const result: CardPickStatsResult = {
    card_name: card.name,
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
    result.play_rate =
      Math.round((timesMaindecked / timesInPool) * 1000) / 1000;
  }

  return result;
}

// ============================================================================
// Combined Card Stats Query
// ============================================================================

/** @public Used by API routes */
export interface GetCardStatsParams {
  card_name: string;
  draft_id?: string;
  date_from?: string;
  date_to?: string;
  draft_name?: string;
  deck_colors?: string;
}

export interface CardStatsResult {
  card_name: string;
  // Scryfall data
  oracle_text: string | null;
  type_line: string | null;
  mana_cost: string | null;
  color_identity: string[];
  // Pick equity
  pick: {
    drafts_in_pool: number;
    times_picked: number;
    avg_pick: number;
    median_pick: number;
    geomean_pick: number;
  };
  // Play rate (null when no decklist data)
  play: {
    pools_with_decklist: number;
    times_maindecked: number;
    play_rate: number;
    filtered: boolean; // true = deck_colors applied, false = overall fallback
  } | null;
  // Win rate (null when no win data)
  wins: {
    seats_maindecked: number;
    game_wins: number;
    game_losses: number;
    win_rate: number;
    win_rate_ci: { lower: number; center: number; upper: number };
    low_sample: boolean;
    drafts_with_data: number;
    filtered: boolean; // true = deck_colors applied, false = overall fallback
  } | null;
}

/**
 * Get comprehensive stats for a card: Scryfall data, pick stats, play rate, and win rate.
 * Combines lookupCard, getCardPickStats, and getCardWinStats into a single call.
 * @public Used by API routes
 */
export async function getCardStats(
  params: GetCardStatsParams
): Promise<CardStatsResult | null> {
  // Run lookupCard and getCardPickStats in parallel (both resolve the card independently)
  const [cardDetails, pickStats] = await Promise.all([
    lookupCard(params.card_name),
    getCardPickStats({
      card_name: params.card_name,
      date_from: params.date_from,
      date_to: params.date_to,
      draft_name: params.draft_name,
    }),
  ]);

  // If both return null, card doesn't exist
  if (!cardDetails && !pickStats) return null;

  // Get win stats (also resolves card internally)
  const winStats = await getCardWinStats({
    card_name: params.card_name,
    draft_id: params.draft_id,
    deck_colors: params.deck_colors,
  });

  // Build play stats
  // When deck_colors is specified, use the standalone getCardPlayStats (which supports color filtering)
  // instead of the play rate embedded in pickStats.
  // If filtered stats are empty, fall back to overall stats.
  let play: CardStatsResult["play"] = null;
  if (params.deck_colors) {
    const playStats = await getCardPlayStats({
      card_name: params.card_name,
      draft_id: params.draft_id,
      deck_colors: params.deck_colors,
    });
    if (playStats && playStats.times_drafted > 0) {
      play = {
        pools_with_decklist: playStats.times_drafted,
        times_maindecked: playStats.times_maindecked,
        play_rate: playStats.play_rate,
        filtered: true,
      };
    } else if (pickStats?.play_rate !== undefined) {
      // Fallback to overall stats when archetype data is sparse
      play = {
        pools_with_decklist: pickStats.times_in_pool_with_decklist ?? 0,
        times_maindecked: pickStats.times_maindecked ?? 0,
        play_rate: pickStats.play_rate,
        filtered: false,
      };
    }
  } else if (pickStats?.play_rate !== undefined) {
    play = {
      pools_with_decklist: pickStats.times_in_pool_with_decklist ?? 0,
      times_maindecked: pickStats.times_maindecked ?? 0,
      play_rate: pickStats.play_rate,
      filtered: false,
    };
  }

  // Build win stats with confidence interval.
  // When deck_colors is specified and filtered wins are empty, fall back to overall stats.
  let wins: CardStatsResult["wins"] = null;
  if (winStats && winStats.times_maindecked > 0) {
    const totalGames = winStats.game_wins + winStats.game_losses;
    const ci = wilsonInterval(winStats.game_wins, totalGames);
    wins = {
      seats_maindecked: winStats.times_maindecked,
      game_wins: winStats.game_wins,
      game_losses: winStats.game_losses,
      win_rate: winStats.win_rate,
      win_rate_ci: ci,
      low_sample: winStats.times_maindecked < 5,
      drafts_with_data: winStats.drafts_with_data,
      filtered: !!params.deck_colors,
    };
  } else if (params.deck_colors) {
    // Fallback: fetch overall win stats without color filter
    const overallWinStats = await getCardWinStats({
      card_name: params.card_name,
      draft_id: params.draft_id,
    });
    if (overallWinStats && overallWinStats.times_maindecked > 0) {
      const totalGames = overallWinStats.game_wins + overallWinStats.game_losses;
      const ci = wilsonInterval(overallWinStats.game_wins, totalGames);
      wins = {
        seats_maindecked: overallWinStats.times_maindecked,
        game_wins: overallWinStats.game_wins,
        game_losses: overallWinStats.game_losses,
        win_rate: overallWinStats.win_rate,
        win_rate_ci: ci,
        low_sample: overallWinStats.times_maindecked < 5,
        drafts_with_data: overallWinStats.drafts_with_data,
        filtered: false,
      };
    }
  }

  return {
    card_name: cardDetails?.name ?? pickStats?.card_name ?? params.card_name,
    oracle_text: cardDetails?.oracle_text ?? null,
    type_line: cardDetails?.type_line ?? null,
    mana_cost: cardDetails?.mana_cost ?? null,
    color_identity: cardDetails?.color_identity ?? [],
    pick: {
      drafts_in_pool: pickStats?.drafts_seen ?? 0,
      times_picked: pickStats?.times_picked ?? 0,
      avg_pick: pickStats?.avg_pick_n ?? 0,
      median_pick: pickStats?.median_pick_n ?? 0,
      geomean_pick: pickStats?.weighted_geomean ?? 0,
    },
    play,
    wins,
  };
}

// ============================================================================
// Rank Available Cards Query
// ============================================================================

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

  // Step 1: Get available cards
  const available = await getAvailableCards({
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
  const client = await getClient();
  const namePlaceholders = cardNames.map(() => "?").join(", ");
  const cardsResult = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE name IN (${namePlaceholders})`,
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

  const idPlaceholders = cardIds.map(() => "?").join(", ");

  // Step 3: Batch pick stats — get all drafts where these cards appear
  const [draftsResult, picksResult, cubeSizesResult] = await Promise.all([
    client.execute({
      sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id, csc.card_id
            FROM drafts d
            JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE csc.card_id IN (${idPlaceholders})`,
      args: cardIds,
    }),
    client.execute({
      sql: `SELECT pe.card_id, pe.draft_id, pe.pick_n
            FROM pick_events pe
            WHERE pe.card_id IN (${idPlaceholders})`,
      args: cardIds,
    }),
    client.execute({
      sql: `SELECT cube_snapshot_id, SUM(qty) as total_cards
            FROM cube_snapshot_cards
            WHERE cube_snapshot_id IN (
              SELECT DISTINCT d.cube_snapshot_id FROM drafts d
              JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
              WHERE csc.card_id IN (${idPlaceholders})
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
            WHERE dc.card_id IN (${idPlaceholders})`,
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
            WHERE dc.card_id IN (${idPlaceholders}) AND dc.zone = 'deck'
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
    const optOutPlaceholders = [...allDraftIds].map(() => "?").join(", ");
    const optOutResult = await client.execute({
      sql: `SELECT draft_id, seat FROM privacy_opt_outs WHERE draft_id IN (${optOutPlaceholders})`,
      args: [...allDraftIds],
    });
    for (const row of optOutResult.rows) {
      optedOut.add(`${row.draft_id}:${row.seat}`);
    }
  }

  // If deck_colors is set, get matching seats across all relevant drafts
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors([...allDraftIds], params.deck_colors);
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
      playRate = Math.round((play.maindecked / play.total) * 1000) / 1000;
      playFiltered = !!matchingSeats;
    } else if (matchingSeats && playOverall && playOverall.total > 0) {
      playRate = Math.round((playOverall.maindecked / playOverall.total) * 1000) / 1000;
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
      winRate = Math.round((win.wins / total) * 1000) / 1000;
      winRateCi = wilsonInterval(win.wins, total);
      lowSample = win.seats < 5;
      winFiltered = !!matchingSeats;
    } else if (matchingSeats && winOverall && (winOverall.wins + winOverall.losses) > 0) {
      const total = winOverall.wins + winOverall.losses;
      winRate = Math.round((winOverall.wins / total) * 1000) / 1000;
      winRateCi = wilsonInterval(winOverall.wins, total);
      lowSample = winOverall.seats < 5;
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
