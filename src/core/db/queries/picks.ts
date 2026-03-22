/**
 * Pick queries (getPicks, getAvailableCards, getStandings).
 */

import { getClient } from "../client";
import { getOptedOutSeats, parseScryfallJson, matchesColorFilter } from "./helpers";
import { getFrontFace } from "../../cardNames";

export interface GetPicksParams {
  draft_id: string;
  seat?: number;
  pick_n_min?: number;
  pick_n_max?: number;
  card_name?: string;
}

export interface PicksResult {
  draft_id: string;
  total: number;
  redacted_seats?: number[];
  picks: {
    pick_n: number;
    seat: number | "[REDACTED]";
    card_name: string;
  }[];
}

/**
 * Get picks from a draft with optional filters.
 * Returns picks sorted by pick number ascending.
 * Redacts seat information for players who have opted out.
 */
export async function getPicks(params: GetPicksParams): Promise<PicksResult> {
  const client = await getClient();
  const optedOutSeats = await getOptedOutSeats(params.draft_id);

  // If requesting a specific opted-out seat, return empty with redaction notice
  if (params.seat !== undefined && optedOutSeats.has(params.seat)) {
    return {
      draft_id: params.draft_id,
      total: 0,
      redacted_seats: [params.seat],
      picks: [],
    };
  }

  const conditions: string[] = ["pe.draft_id = ?"];
  const args: (string | number)[] = [params.draft_id];

  if (params.seat !== undefined) {
    conditions.push("pe.seat = ?");
    args.push(params.seat);
  }

  if (params.pick_n_min !== undefined) {
    conditions.push("pe.pick_n >= ?");
    args.push(params.pick_n_min);
  }

  if (params.pick_n_max !== undefined) {
    conditions.push("pe.pick_n <= ?");
    args.push(params.pick_n_max);
  }

  if (params.card_name) {
    conditions.push("LOWER(c.name) LIKE LOWER(?)");
    args.push(`%${params.card_name}%`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, c.name as card_name
          FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          ${whereClause}
          ORDER BY pe.pick_n ASC`,
    args,
  });

  // Build result with redacted seats
  const redactedSeatsInResult = new Set<number>();
  const picks = result.rows.map((row) => {
    const seat = row.seat as number;
    const isRedacted = optedOutSeats.has(seat);
    if (isRedacted) {
      redactedSeatsInResult.add(seat);
    }
    return {
      pick_n: row.pick_n as number,
      seat: isRedacted ? ("[REDACTED]" as const) : seat,
      card_name: row.card_name as string,
    };
  });

  return {
    draft_id: params.draft_id,
    total: result.rows.length,
    ...(redactedSeatsInResult.size > 0 && {
      redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
    }),
    picks,
  };
}

// ============================================================================
// Available Cards Query
// ============================================================================

export interface GetAvailableCardsParams {
  draft_id: string;
  before_pick_n: number;
  color?: string;
  type_contains?: string;
}

export interface AvailableCardsResult {
  draft_id: string;
  before_pick_n: number;
  cards: {
    card_name: string;
    remaining_qty: number;
  }[];
}

/**
 * Get cards remaining in the cube before a specific pick.
 * Computes: cube_snapshot_cards - picks before before_pick_n
 *
 * @param color - Filter by color identity (e.g., "W", "U", "B", "R", "G", "C" for colorless)
 * @param type_contains - Filter by type line substring (case-insensitive)
 */
export async function getAvailableCards(
  params: GetAvailableCardsParams
): Promise<AvailableCardsResult> {
  const client = await getClient();

  // Get the cube_snapshot_id for this draft
  const draftResult = await client.execute({
    sql: `SELECT cube_snapshot_id, banned_cards FROM drafts WHERE draft_id = ?`,
    args: [params.draft_id],
  });

  if (draftResult.rows.length === 0) {
    return {
      draft_id: params.draft_id,
      before_pick_n: params.before_pick_n,
      cards: [],
    };
  }

  const cubeSnapshotId = draftResult.rows[0].cube_snapshot_id as number;

  // Parse banned cards for filtering
  const bannedCardsRaw = draftResult.rows[0].banned_cards as string | null;
  let bannedCards = new Set<string>();
  if (bannedCardsRaw) {
    try {
      bannedCards = new Set(
        (JSON.parse(bannedCardsRaw) as string[]).map((name) => name.toLowerCase())
      );
    } catch {
      // Ignore malformed JSON
    }
  }

  // Get all cards in the cube with their quantities
  const cubeCardsResult = await client.execute({
    sql: `SELECT c.card_id, c.name, c.scryfall_json, csc.qty
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id = ?`,
    args: [cubeSnapshotId],
  });

  // Get picks made before before_pick_n
  const picksResult = await client.execute({
    sql: `SELECT card_id, COUNT(*) as pick_count
          FROM pick_events
          WHERE draft_id = ? AND pick_n < ?
          GROUP BY card_id`,
    args: [params.draft_id, params.before_pick_n],
  });

  // Build a map of picked card counts
  const pickedCounts = new Map<number, number>();
  for (const row of picksResult.rows) {
    pickedCounts.set(row.card_id as number, row.pick_count as number);
  }

  // Calculate remaining cards and apply filters
  const availableCards: { card_name: string; remaining_qty: number }[] = [];

  for (const row of cubeCardsResult.rows) {
    const cardId = row.card_id as number;
    const cardName = row.name as string;
    const scryfallJson = row.scryfall_json as string | null;
    const qty = row.qty as number;
    const picked = pickedCounts.get(cardId) || 0;
    const remaining = qty - picked;

    if (remaining <= 0) continue;
    const lowerName = cardName.toLowerCase();
    const frontFace = getFrontFace(lowerName);
    if (bannedCards.has(lowerName) || (frontFace && bannedCards.has(frontFace))) continue;

    // Parse scryfall JSON once if either filter needs it
    const scryfall = (params.color || params.type_contains)
      ? parseScryfallJson(scryfallJson)
      : null;

    // Apply color filter
    if (params.color) {
      if (!scryfall) continue;
      if (!matchesColorFilter(scryfall.color_identity || [], params.color)) continue;
    }

    // Apply type filter
    if (params.type_contains) {
      if (!scryfall) continue;

      const typeLine = scryfall.type_line || "";
      if (!typeLine.toLowerCase().includes(params.type_contains.toLowerCase())) {
        continue;
      }
    }

    availableCards.push({
      card_name: cardName,
      remaining_qty: remaining,
    });
  }

  // Sort by card name
  availableCards.sort((a, b) => a.card_name.localeCompare(b.card_name));

  return {
    draft_id: params.draft_id,
    before_pick_n: params.before_pick_n,
    cards: availableCards,
  };
}

// ============================================================================
// Standings Query
// ============================================================================

export interface StandingsEntry {
  seat: number | "[REDACTED]";
  match_wins: number;
  match_losses: number;
  game_wins: number;
  game_losses: number;
}

export interface StandingsResult {
  standings: StandingsEntry[];
  redacted_seats?: number[];
}

/**
 * Get match standings for a draft.
 * Computes wins/losses from match_events table.
 * Redacts seat numbers for players who have opted out.
 */
export async function getStandings(draftId: string): Promise<StandingsResult> {
  const client = await getClient();
  const optedOutSeats = await getOptedOutSeats(draftId);

  // Get all match events for this draft
  const result = await client.execute({
    sql: `SELECT seat1, seat2, seat1_wins, seat2_wins
          FROM match_events
          WHERE draft_id = ?`,
    args: [draftId],
  });

  // Aggregate stats per seat
  const stats = new Map<
    number,
    { matchWins: number; matchLosses: number; gameWins: number; gameLosses: number }
  >();

  const getOrCreate = (seat: number) => {
    let entry = stats.get(seat);
    if (!entry) {
      entry = { matchWins: 0, matchLosses: 0, gameWins: 0, gameLosses: 0 };
      stats.set(seat, entry);
    }
    return entry;
  };

  for (const row of result.rows) {
    const seat1 = row.seat1 as number;
    const seat2 = row.seat2 as number;
    const seat1Wins = row.seat1_wins as number;
    const seat2Wins = row.seat2_wins as number;

    const s1Stats = getOrCreate(seat1);
    const s2Stats = getOrCreate(seat2);

    // Game wins/losses
    s1Stats.gameWins += seat1Wins;
    s1Stats.gameLosses += seat2Wins;
    s2Stats.gameWins += seat2Wins;
    s2Stats.gameLosses += seat1Wins;

    // Match wins/losses (whoever won more games wins the match)
    if (seat1Wins > seat2Wins) {
      s1Stats.matchWins += 1;
      s2Stats.matchLosses += 1;
    } else if (seat2Wins > seat1Wins) {
      s2Stats.matchWins += 1;
      s1Stats.matchLosses += 1;
    }
    // Draws don't count as wins or losses
  }

  // Convert to array and sort by match wins descending
  const redactedSeatsInResult = new Set<number>();
  const standings: StandingsEntry[] = [];

  for (const [seat, s] of stats) {
    const isRedacted = optedOutSeats.has(seat);
    if (isRedacted) {
      redactedSeatsInResult.add(seat);
    }
    standings.push({
      seat: isRedacted ? "[REDACTED]" : seat,
      match_wins: s.matchWins,
      match_losses: s.matchLosses,
      game_wins: s.gameWins,
      game_losses: s.gameLosses,
    });
  }

  standings.sort((a, b) => {
    // Sort by match wins descending, then by game win rate
    if (b.match_wins !== a.match_wins) return b.match_wins - a.match_wins;
    const aRate = a.game_wins / Math.max(1, a.game_wins + a.game_losses);
    const bRate = b.game_wins / Math.max(1, b.game_wins + b.game_losses);
    return bRate - aRate;
  });

  return {
    standings,
    ...(redactedSeatsInResult.size > 0 && {
      redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
    }),
  };
}
