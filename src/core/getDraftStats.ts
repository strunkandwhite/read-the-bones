/**
 * Server-side draft-level aggregate stats.
 *
 * Computes win rate by seat and win rate by deck color identity.
 * These are cross-card, cross-draft statistics — separate from
 * the per-card stats in getCards.ts.
 */

import { getClient } from "./db/client";
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
 * Infer a deck's color identity from its maindecked cards.
 *
 * Counts how often each color appears in the color_identity of maindecked
 * cards. The most frequent color is always included. A second color is
 * included if it appears at least 30% as often as the first — this
 * distinguishes a genuine two-color deck from a mono-color deck with a
 * minor splash. Colors beyond the second are not considered.
 *
 * Examples:
 * - 40 red cards, 2 blue cards → "R" (blue is < 30% of red)
 * - 30 red cards, 15 blue cards → "RU" (blue is 50% of red)
 * - 20 red cards, 20 blue cards → "RU" (equal)
 * - All colorless cards → "C"
 */
function inferDeckColor(colorCounts: Map<string, number>): string {
  const sorted = [...colorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color);

  if (sorted.length === 0) return "C";

  const colors: string[] = [sorted[0]];
  if (sorted.length >= 2) {
    const topCount = colorCounts.get(sorted[0]) || 0;
    const secondCount = colorCounts.get(sorted[1]) || 0;
    if (secondCount >= topCount * 0.3) {
      colors.push(sorted[1]);
    }
  }

  // Canonical WUBRG order
  const order = "WUBRG";
  colors.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return colors.join("");
}

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
    const scryfall = row.scryfall_json
      ? JSON.parse(row.scryfall_json as string)
      : null;
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

  // Get completed draft IDs for color stats
  const draftsResult = await client.execute({
    sql: `SELECT draft_id FROM drafts WHERE is_complete = 1 ORDER BY draft_id`,
    args: [],
  });
  const completedDraftIds = draftsResult.rows.map(
    (r) => r.draft_id as string
  );

  const selectedDraftIds = params.draftIds
    ? params.draftIds.filter((id) =>
        completedDraftIds.includes(id)
      )
    : completedDraftIds;

  // Get ingestion hash
  const hashResult = await client.execute({
    sql: `SELECT value FROM ingestion_meta WHERE key = 'last_hash'`,
    args: [],
  });
  const ingestionHash = (hashResult.rows[0]?.value as string) ?? "unknown";

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
