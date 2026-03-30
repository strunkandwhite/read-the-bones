/**
 * Server-side draft-level aggregate stats.
 *
 * Computes win rate by seat and win rate by deck color identity.
 * These are cross-card, cross-draft statistics — separate from
 * the per-card stats in getCards.ts.
 */

import { getClient } from "./db/client";
import { computeIngestionHash } from "./db/sync/domains";
import { parseScryfallJson } from "./db/queries/helpers";
import { inferDeckColor } from "./inferDeckColor";
import { wilsonInterval } from "./wilsonInterval";

export type SeatWinRate = {
  seat: number;
  wins: number;
  losses: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
};

export type ColorWinRate = {
  color: string;
  wins: number;
  losses: number;
  winRate: number;
  ciLower: number;
  ciUpper: number;
};

export type GetDraftStatsParams = {
  draftIds?: string[];
};

export type DraftStatsResponse = {
  winRateBySeat: SeatWinRate[];
  winRateByColor: ColorWinRate[];
  ingestionHash: string;
};

/**
 * Compute win rate by seat across all 10-seat drafts.
 *
 * Excludes drafts with a different seat count (e.g. 12-seat drafts)
 * because seat position is not comparable across different draft sizes.
 */
async function computeWinRateBySeat(
  client: Awaited<ReturnType<typeof getClient>>
): Promise<SeatWinRate[]> {
  const result = await client.execute({
    sql: `
      WITH ten_seat_drafts AS (
        SELECT draft_id FROM drafts WHERE num_seats = 10
      )
      SELECT seat, SUM(wins) AS total_wins, SUM(losses) AS total_losses
      FROM (
        SELECT seat1 AS seat, seat1_wins AS wins, seat2_wins AS losses
        FROM match_events
        WHERE draft_id IN (SELECT draft_id FROM ten_seat_drafts)
        UNION ALL
        SELECT seat2 AS seat, seat2_wins AS wins, seat1_wins AS losses
        FROM match_events
        WHERE draft_id IN (SELECT draft_id FROM ten_seat_drafts)
      )
      GROUP BY seat
      ORDER BY seat
    `,
    args: [],
  });

  return result.rows.map((row) => {
    const wins = Number(row.total_wins);
    const losses = Number(row.total_losses);
    const total = wins + losses;
    const { lower: ciLower, upper: ciUpper } = wilsonInterval(wins, total);
    return {
      seat: Number(row.seat),
      wins,
      losses,
      winRate: total > 0 ? wins / total : 0,
      ciLower,
      ciUpper,
    };
  });
}

/**
 * Compute win rate by deck color identity for the selected drafts.
 *
 * For each seat with decklist data in the selected drafts:
 * 1. Infer deck color from maindecked cards (30% threshold)
 * 2. Aggregate game wins/losses from match_events by color
 */
async function computeWinRateByColor(
  client: Awaited<ReturnType<typeof getClient>>,
  draftIds: string[]
): Promise<ColorWinRate[]> {
  if (draftIds.length === 0) return [];

  const placeholders = draftIds.map(() => "?").join(", ");

  // Get maindecked cards with their color identity for selected drafts
  const deckResult = await client.execute({
    sql: `
      SELECT dc.draft_id, dc.seat, c.scryfall_json
      FROM deck_cards dc
      JOIN cards c ON dc.card_id = c.card_id
      WHERE dc.zone = 'deck' AND dc.draft_id IN (${placeholders})
    `,
    args: draftIds,
  });

  // Build color counts per (draft_id, seat)
  const seatColors = new Map<string, Map<string, number>>();
  for (const row of deckResult.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    const scryfall = parseScryfallJson(row.scryfall_json as string | null);
    const colors: string[] = scryfall?.color_identity ?? [];

    if (!seatColors.has(key)) {
      seatColors.set(key, new Map());
    }
    const counts = seatColors.get(key)!;
    for (const color of colors) {
      counts.set(color, (counts.get(color) || 0) + 1);
    }
  }

  // Infer color per seat
  const seatToColor = new Map<string, string>();
  for (const [key, counts] of seatColors) {
    seatToColor.set(key, inferDeckColor(counts));
  }

  // Get match results for selected drafts
  const matchResult = await client.execute({
    sql: `
      SELECT draft_id, seat1, seat2, seat1_wins, seat2_wins
      FROM match_events
      WHERE draft_id IN (${placeholders})
    `,
    args: draftIds,
  });

  // Aggregate wins/losses by color
  const colorStats = new Map<string, { wins: number; losses: number }>();

  for (const row of matchResult.rows) {
    const draftId = row.draft_id as string;
    const seat1 = Number(row.seat1);
    const seat2 = Number(row.seat2);
    const seat1Wins = Number(row.seat1_wins);
    const seat2Wins = Number(row.seat2_wins);

    const color1 = seatToColor.get(`${draftId}:${seat1}`);
    const color2 = seatToColor.get(`${draftId}:${seat2}`);

    // Only include seats that have decklist data (and thus a known color)
    if (color1) {
      if (!colorStats.has(color1))
        colorStats.set(color1, { wins: 0, losses: 0 });
      const s = colorStats.get(color1)!;
      s.wins += seat1Wins;
      s.losses += seat2Wins;
    }

    if (color2) {
      if (!colorStats.has(color2))
        colorStats.set(color2, { wins: 0, losses: 0 });
      const s = colorStats.get(color2)!;
      s.wins += seat2Wins;
      s.losses += seat1Wins;
    }
  }

  // Sort by win rate descending
  return [...colorStats.entries()]
    .map(([color, { wins, losses }]) => {
      const total = wins + losses;
      const { lower: ciLower, upper: ciUpper } = wilsonInterval(wins, total);
      return {
        color,
        wins,
        losses,
        winRate: total > 0 ? wins / total : 0,
        ciLower,
        ciUpper,
      };
    })
    .sort((a, b) => b.winRate - a.winRate);
}

/**
 * Get draft-level aggregate statistics.
 *
 * - winRateBySeat: always computed across ALL drafts (independent of selection)
 * - winRateByColor: computed for the selected drafts only
 */
export async function getDraftStats(
  params: GetDraftStatsParams = {}
): Promise<DraftStatsResponse> {
  const client = await getClient();

  // Get completed draft IDs (with domain hashes for cache fingerprint)
  const draftsResult = await client.execute({
    sql: `SELECT draft_id, pool_hash, picks_hash, matches_hash FROM drafts WHERE phase = 'complete' ORDER BY draft_id`,
    args: [],
  });
  const completedDraftIds = draftsResult.rows.map(
    (r) => r.draft_id as string
  );

  const completedDraftIdSet = new Set(completedDraftIds);
  const selectedDraftIds = params.draftIds
    ? params.draftIds.filter((id) => completedDraftIdSet.has(id))
    : completedDraftIds;

  // Compute cache fingerprint from per-domain hashes
  const ingestionHash = computeIngestionHash(
    draftsResult.rows as unknown as Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
  );

  // Compute both stats in parallel
  const [winRateBySeat, winRateByColor] = await Promise.all([
    computeWinRateBySeat(client),
    computeWinRateByColor(client, selectedDraftIds),
  ]);

  return {
    winRateBySeat,
    winRateByColor,
    ingestionHash,
  };
}
