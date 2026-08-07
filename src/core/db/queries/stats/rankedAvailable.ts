/**
 * Ranked available cards query — bulk-ranks available cards by historical performance.
 */

import type { Client } from "@libsql/client";
import { getClient } from "../../client";
import { fetchOptOuts, getSeatsMatchingColors, placeholders } from "../helpers";
import { getAvailableCards } from "../picks";
import { getDraftMeta } from "../drafts";
import { statsPhaseFilter } from "../../../draftPhases";
import { getWorthTable } from "./worth";
import { round3 } from "../../../utils";
import { pickScore, type DraftObservation } from "../../../pickScore";
import { sessionsAgoByDraft } from "../../../draftSessions";
import { wilsonInterval } from "../../../wilsonInterval";
import { DEFAULT_POOL_SIZE } from "../../../types";
import { MIN_SAMPLE_SIZE } from "../../../constants";
import {
  colorFlag,
  overdueDanger,
  pairSupply,
  type WorthCard,
} from "../../../worthModel";
import {
  derivePickSeat,
  getTotalPicks,
  picksUntilNextTurn,
} from "../../../snakeDraft";

export interface RankAvailableCardsParams {
  draft_id: string;
  before_pick_n: number;
  color?: string;
  type_contains?: string;
  deck_colors?: string;
  limit?: number;
  sort_by?:
    | "geomean_pick"
    | "win_rate"
    | "play_rate"
    | "pick_value"
    | "first_pick_score";
  /** Seat whose snake schedule defines the danger horizon and supply slots. */
  seat?: number;
  /**
   * Commitment state for color_flag: "" (uncommitted), one WUBRG letter
   * (one color locked), or two (pair locked). Presence of the param — even
   * as "" — turns on color_flag/first_pick_score per row.
   */
  committed_colors?: string;
  /** Dev-only worth-model fields (same gating shape as includeWinStats). */
  include_worth?: boolean;
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
  // Worth-model fields (dev-only) — present only when include_worth is set.
  worth?: number | null;
  danger?: number | null;
  pick_value?: number | null;
  // Present only when include_worth AND committed_colors were both provided.
  color_flag?: number | null;
  first_pick_score?: number | null;
}

export interface RankAvailableCardsResult {
  draft_id: string;
  before_pick_n: number;
  total_available: number;
  /** Danger horizon used (picks). Present only when include_worth is set. */
  horizon?: number;
  /**
   * Per two-color-pair obtainable count of positive-worth current-cube cards
   * (supply/urgency signal, not a deck-quality prediction). Present only
   * when include_worth is set.
   */
  pair_supply?: Record<string, number>;
  cards: RankedCard[];
}

// All ten two-color pairs in canonical WUBRG order (matches pairEdges keys).
const WUBRG_PAIRS = [
  "WU", "WB", "WR", "WG", "UB", "UR", "UG", "BR", "BG", "RG",
];

interface WorthContext {
  worthByName: Map<string, WorthCard>;
  sigma: number;
  kappa: number;
  pairEdges: Record<string, number>;
  horizon: number;
  pairSupplyByPair: Record<string, number>;
}

/**
 * Assemble everything the worth-model row fields need: the worth table
 * (joined by card name), the danger horizon, and per-pair supply counts.
 * Returns null when the draft has no metadata row (defensive — available
 * cards for a nonexistent draft already short-circuit earlier).
 */
async function buildWorthContext(
  client: Client,
  params: RankAvailableCardsParams,
): Promise<WorthContext | null> {
  const meta = await getDraftMeta(client, params.draft_id);
  if (!meta) return null;

  const worthTable = await getWorthTable();
  const { sigma, kappa, pairEdges } = worthTable.model;
  const snakeOpts = {
    numSeats: meta.numSeats,
    picksPerPlayer: meta.picksPerPlayer,
    doublePickAfterRound: meta.doublePickAfterRound,
  };
  const totalPicks = getTotalPicks(meta.numSeats, meta.picksPerPlayer);

  // Horizon semantics (off-by-one decision): before_pick_n is the pick ABOUT
  // to be made. Danger asks "if I pass this card at before_pick_n, does it
  // survive until I act again?" — so the current pick counts as already
  // spent, and the horizon runs to the seat's NEXT turn:
  // picksUntilNextTurn(before_pick_n, seat). Seat 1 at before_pick_n = 1 with
  // 10 seats next acts at pick 20 → horizon 19, not 0 ("you are picking
  // right now") and not 20. When the seat never picks again the horizon
  // degrades to all remaining picks after the current one.
  let horizon: number;
  if (params.seat !== undefined) {
    horizon =
      picksUntilNextTurn(params.before_pick_n, params.seat, snakeOpts) ??
      Math.max(totalPicks - params.before_pick_n, 0);
  } else {
    // One full snake turn: any seat acts again within 2 × numSeats picks.
    horizon = 2 * meta.numSeats;
  }

  // The seat's future pick slots (including before_pick_n itself when it is
  // the seat's own pick) drive pair supply. Without a seat, use a generic
  // one-slot-every-2×numSeats schedule starting at the current pick.
  const slots: number[] = [];
  if (params.seat !== undefined) {
    for (let pickN = params.before_pick_n; pickN <= totalPicks; pickN++) {
      if (derivePickSeat(pickN, snakeOpts).seat === params.seat) {
        slots.push(pickN);
      }
    }
  } else {
    const stride = 2 * meta.numSeats;
    for (let pickN = params.before_pick_n; pickN <= totalPicks; pickN += stride) {
      slots.push(pickN);
    }
  }

  // Pair supply is a live-market metric: current-cube, positive-worth,
  // priced cards only. A pair's pool is cards whose identity fits inside the
  // pair — which includes colorless (empty identity fits every pair).
  const supplyCards = worthTable.cards.filter(
    (card) =>
      card.in_current_cube &&
      card.worth !== null &&
      card.worth > 0 &&
      card.geomean !== null &&
      card.geomean > 0,
  );
  const pairSupplyByPair: Record<string, number> = {};
  for (const pair of WUBRG_PAIRS) {
    const pairCards = supplyCards
      .filter((card) => [...card.colors].every((color) => pair.includes(color)))
      .map((card) => ({ worth: card.worth!, geo: card.geomean! }));
    pairSupplyByPair[pair] =
      sigma > 0
        ? pairSupply(pairCards, slots, params.before_pick_n, sigma)
        : 0;
  }

  return {
    worthByName: new Map(worthTable.cards.map((card) => [card.card_name, card])),
    sigma,
    kappa,
    pairEdges,
    horizon,
    pairSupplyByPair,
  };
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

  const worthContext = params.include_worth
    ? await buildWorthContext(client, params)
    : null;

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

  // Step 3: Batch pick stats — get all drafts where these cards appear.
  // Both queries are restricted to stats-complete drafts (complete/playing):
  // an in-progress draft otherwise contributes an "unpicked at pool size"
  // observation for every card that simply hasn't come up yet, including
  // the very draft being ranked. statsPhaseFilter's args are positional, so
  // each query needs its own call rather than sharing one result.
  const draftPhase = statsPhaseFilter("d.phase");
  const pickPhase = statsPhaseFilter("d.phase");

  const [draftsResult, picksResult, cubeSizesResult] = await Promise.all([
    client.execute({
      sql: `SELECT DISTINCT d.draft_id, d.cube_snapshot_id, d.draft_date, csc.card_id
            FROM drafts d
            JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE csc.card_id IN (${idPlaceholderStr}) AND ${draftPhase.fragment}`,
      args: [...cardIds, ...draftPhase.args],
    }),
    client.execute({
      sql: `SELECT pe.card_id, pe.draft_id, pe.pick_n, pe.seat
            FROM pick_events pe
            JOIN drafts d ON d.draft_id = pe.draft_id
            WHERE pe.card_id IN (${idPlaceholderStr}) AND ${pickPhase.fragment}`,
      args: [...cardIds, ...pickPhase.args],
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

  // Collect all draft IDs for opt-out and color filtering. Picks contribute
  // their own draft ids here too (not just play/win rows) so fetchOptOuts
  // below can resolve pick-side opt-outs — its lookup key is
  // "draftId:seat", so a draft missing from this set means the pick-side
  // .has() check below never matches.
  const allDraftIds = new Set<string>();
  for (const row of picksResult.rows) allDraftIds.add(row.draft_id as string);
  for (const row of playResult.rows) allDraftIds.add(row.draft_id as string);
  for (const row of winResult.rows) allDraftIds.add(row.draft_id as string);

  // Get opt-outs for all relevant drafts once, shared by pick, play, and
  // win stats below.
  const optedOut = await fetchOptOuts(client, [...allDraftIds]);

  // If deck_colors is set, get matching seats across all relevant drafts
  let matchingSeats: Set<string> | null = null;
  if (params.deck_colors) {
    matchingSeats = await getSeatsMatchingColors(client, [...allDraftIds], params.deck_colors);
  }

  // Build lookup structures for pick stats
  const cubeSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    cubeSizes.set(row.cube_snapshot_id as number, row.total_cards as number);
  }

  // Map: cardId -> draftId -> { cubeSnapshotId, draftDate }, where card was in pool
  const cardDrafts = new Map<number, Map<string, { cubeSnapshotId: number; draftDate: string }>>();
  const draftDates = new Map<string, string>();
  for (const row of draftsResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const draftDate = row.draft_date as string;
    draftDates.set(draftId, draftDate);
    if (!cardDrafts.has(cardId)) cardDrafts.set(cardId, new Map());
    cardDrafts.get(cardId)!.set(draftId, {
      cubeSnapshotId: row.cube_snapshot_id as number,
      draftDate,
    });
  }

  // Ordinals span every draft in play, not just the ones a given card was in.
  // A card that sat out a session must keep the real gap on either side of it.
  const sessionsAgo = sessionsAgoByDraft(
    [...draftDates].map(([draftId, draftDate]) => ({ draftId, draftDate })),
  );

  // Map: cardId -> draftId -> pick positions, skipping opted-out seats
  const cardPicks = new Map<number, Map<string, number[]>>();
  for (const row of picksResult.rows) {
    const cardId = row.card_id as number;
    const draftId = row.draft_id as string;
    const pickN = row.pick_n as number;
    const seat = row.seat as number;
    if (optedOut.has(`${draftId}:${seat}`)) continue;
    if (!cardPicks.has(cardId)) cardPicks.set(cardId, new Map());
    const byDraft = cardPicks.get(cardId)!;
    if (!byDraft.has(draftId)) byDraft.set(draftId, []);
    byDraft.get(draftId)!.push(pickN);
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

    // Pick stats: weighted score over every draft the card was in the pool for
    const drafts = cardDrafts.get(cardId) ?? new Map();
    const picks = cardPicks.get(cardId) ?? new Map();
    const observations: DraftObservation[] = [];
    let timesPicked = 0;

    for (const [draftId, { cubeSnapshotId }] of drafts) {
      const draftPicks = picks.get(draftId) ?? [];
      timesPicked += draftPicks.length;
      observations.push({
        sessionsAgo: sessionsAgo.get(draftId)!,
        pickPositions: draftPicks,
        poolSize: cubeSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE,
      });
    }

    const geomean =
      observations.length > 0 ? Math.round(pickScore(observations) * 10) / 10 : 0;

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

    const rankedCard: RankedCard = {
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
    };

    if (worthContext) {
      const worthCard = worthContext.worthByName.get(cardName);
      const worth = worthCard?.worth ?? null;
      // Danger uses the worth table's geomean (all-drafts, unpicked-penalty
      // convention), not this query's pool-filtered geomean_pick.
      const worthGeomean = worthCard?.geomean ?? null;
      // The loss window is picks strictly between now and the seat's next
      // turn: pick (before_pick_n + horizon) is the seat acting again, not a
      // chance for an opponent to take the card.
      const dangerWindow = Math.max(worthContext.horizon - 1, 0);
      const dangerValue =
        worthGeomean !== null && worthGeomean > 0 && worthContext.sigma > 0 && dangerWindow > 0
          ? overdueDanger(
              params.before_pick_n,
              dangerWindow,
              worthGeomean,
              worthContext.sigma,
            )
          : worthGeomean !== null && worthGeomean > 0 && worthContext.sigma > 0
            ? 0
            : null;
      rankedCard.worth = worth;
      rankedCard.danger = dangerValue;
      rankedCard.pick_value =
        worth !== null && dangerValue !== null ? worth * dangerValue : null;

      if (params.committed_colors !== undefined) {
        // colorFlag needs the card's color identity — unknown to the worth
        // table means no flag, not a zero flag.
        const flag = worthCard
          ? colorFlag(
              worthCard.colors,
              worthContext.pairEdges,
              { committed: params.committed_colors },
              worthContext.kappa,
            )
          : null;
        rankedCard.color_flag = flag;
        rankedCard.first_pick_score =
          rankedCard.pick_value !== null && flag !== null
            ? rankedCard.pick_value + flag
            : null;
      }
    }

    rankedCards.push(rankedCard);
  }

  // Sort
  rankedCards.sort((a, b) => {
    if (sortBy === "pick_value" || sortBy === "first_pick_score") {
      // Higher score first, nulls (and rows computed without worth) last.
      const aScore = a[sortBy] ?? null;
      const bScore = b[sortBy] ?? null;
      if (aScore === null && bScore === null) return a.geomean_pick - b.geomean_pick;
      if (aScore === null) return 1;
      if (bScore === null) return -1;
      return bScore - aScore;
    }
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

  const result: RankAvailableCardsResult = {
    draft_id: params.draft_id,
    before_pick_n: params.before_pick_n,
    total_available: available.cards.length,
    cards: rankedCards.slice(0, limit),
  };
  if (worthContext) {
    result.horizon = worthContext.horizon;
    result.pair_supply = worthContext.pairSupplyByPair;
  }
  return result;
}
