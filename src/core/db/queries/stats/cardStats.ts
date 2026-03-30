/**
 * Combined card statistics query — Scryfall data, pick stats, play rate, and win rate.
 */

import { parseScryfallJson } from "../helpers";
import { resolveCard } from "../cards";
import { getCardPlayStats } from "../playStats";
import { getCardWinStats } from "../winStats";
import { wilsonInterval } from "../../../wilsonInterval";
import { getCardPickStats } from "./pickStats";
import { getPickHistory, type PickHistoryEntry } from "./pickHistory";
import { getColorPairBreakdown, type ColorPairEntry } from "./colorPairBreakdown";
import { getClient } from "../../client";
import { MIN_SAMPLE_SIZE } from "../../../constants";

/** @public Used by API routes */
export interface GetCardStatsParams {
  card_name: string;
  draft_id?: string;
  exclude_draft_id?: string;
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
  // Per-draft pick history
  pick_history: PickHistoryEntry[];
  // 15-bucket distribution of pick positions
  pick_distribution: number[];
  // Number of drafts where this card was banned
  times_banned: number;
  // Top color pair archetypes that maindeck this card
  color_pair_breakdown: ColorPairEntry[];
}

/**
 * Get comprehensive stats for a card: Scryfall data, pick stats, play rate, and win rate.
 * Combines lookupCard, getCardPickStats, and getCardWinStats into a single call.
 * @public Used by API routes
 */
export async function getCardStats(
  params: GetCardStatsParams
): Promise<CardStatsResult | null> {
  // Resolve card once — all sub-functions reuse the resolved card_id
  const card = await resolveCard(params.card_name);
  if (!card) return null;

  const cardId = card.card_id;
  const scryfall = parseScryfallJson(card.scryfall_json);
  const cardDetails = {
    name: card.name,
    oracle_text: scryfall?.oracle_text || null,
    type_line: scryfall?.type_line || null,
    mana_cost: scryfall?.mana_cost || null,
    color_identity: scryfall?.color_identity || [],
  };

  const client = await getClient();

  // Run all stats queries in parallel, passing the resolved card_id
  const [pickStats, winStats, historyResult, colorPairs] = await Promise.all([
    getCardPickStats({
      card_name: card.name,
      card_id: cardId,
      exclude_draft_id: params.exclude_draft_id,
      date_from: params.date_from,
      date_to: params.date_to,
      draft_name: params.draft_name,
    }),
    getCardWinStats({
      card_name: card.name,
      card_id: cardId,
      draft_id: params.draft_id,
      exclude_draft_id: params.exclude_draft_id,
      deck_colors: params.deck_colors,
    }),
    getPickHistory(client, card.name, params.draft_id, params.exclude_draft_id, cardId),
    getColorPairBreakdown(client, card.name, params.draft_id, params.exclude_draft_id, cardId),
  ]);

  // Build play stats
  // When deck_colors is specified, use the standalone getCardPlayStats (which supports color filtering)
  // instead of the play rate embedded in pickStats.
  // If filtered stats are empty, fall back to overall stats.
  let play: CardStatsResult["play"] = null;
  if (params.deck_colors) {
    const playStats = await getCardPlayStats({
      card_name: card.name,
      card_id: cardId,
      draft_id: params.draft_id,
      exclude_draft_id: params.exclude_draft_id,
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
      low_sample: winStats.times_maindecked < MIN_SAMPLE_SIZE,
      drafts_with_data: winStats.drafts_with_data,
      filtered: !!params.deck_colors,
    };
  } else if (params.deck_colors) {
    // Fallback: fetch overall win stats without color filter
    const overallWinStats = await getCardWinStats({
      card_name: card.name,
      card_id: cardId,
      draft_id: params.draft_id,
      exclude_draft_id: params.exclude_draft_id,
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
        low_sample: overallWinStats.times_maindecked < MIN_SAMPLE_SIZE,
        drafts_with_data: overallWinStats.drafts_with_data,
        filtered: false,
      };
    }
  }

  return {
    card_name: cardDetails.name,
    oracle_text: cardDetails.oracle_text,
    type_line: cardDetails.type_line,
    mana_cost: cardDetails.mana_cost,
    color_identity: cardDetails.color_identity,
    pick: {
      drafts_in_pool: pickStats?.drafts_seen ?? 0,
      times_picked: pickStats?.times_picked ?? 0,
      avg_pick: pickStats?.avg_pick_n ?? 0,
      median_pick: pickStats?.median_pick_n ?? 0,
      geomean_pick: pickStats?.weighted_geomean ?? 0,
    },
    play,
    wins,
    pick_history: historyResult.pickHistory,
    pick_distribution: historyResult.pickDistribution,
    times_banned: historyResult.timesBanned,
    color_pair_breakdown: colorPairs,
  };
}
