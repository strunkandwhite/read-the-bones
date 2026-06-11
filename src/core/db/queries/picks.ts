/**
 * Pick queries (getPicks, getAvailableCards, getStandings).
 */

import type { Client } from "@libsql/client";
import { getOptedOutSeats, parseScryfallJson, matchesColorFilter, parseBannedCards, transformScryfallJson } from "./helpers";
import { aggregateMatchRecords, computeTiebreakers } from "./matches";
import { getFrontFace } from "../../cardNames";

export interface GetPicksParams {
  draft_id: string;
  seat?: number;
  pick_n_min?: number;
  pick_n_max?: number;
  card_name?: string;
  optedOutSeats?: Set<number>;
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
export async function getPicks(client: Client, params: GetPicksParams): Promise<PicksResult> {
  const optedOutSeats = params.optedOutSeats ?? await getOptedOutSeats(client, params.draft_id);

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
  client: Client,
  params: GetAvailableCardsParams
): Promise<AvailableCardsResult> {

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
  const bannedCards = parseBannedCards(bannedCardsRaw);

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
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
  omwPct: number | null;
  ogwPct: number | null;
}

export interface MatchRecord {
  seat1: number;
  seat2: number;
  seat1Wins: number;
  seat2Wins: number;
}

export interface StandingsResult {
  standings: StandingsEntry[];
  matches: MatchRecord[];
  redacted_seats?: number[];
}

/**
 * Get match standings for a draft.
 * Computes wins/losses from match_events table.
 * Redacts seat numbers for players who have opted out.
 */
export async function getStandings(client: Client, draftId: string, numSeats?: number, optedOutSeats?: Set<number>): Promise<StandingsResult> {
  const resolvedOptedOutSeats = optedOutSeats ?? await getOptedOutSeats(client, draftId);

  // Get all match events for this draft
  const result = await client.execute({
    sql: `SELECT draft_id, seat1, seat2, seat1_wins, seat2_wins
          FROM match_events
          WHERE draft_id = ?`,
    args: [draftId],
  });

  const matches: MatchRecord[] = result.rows.map((row) => ({
    seat1: row.seat1 as number,
    seat2: row.seat2 as number,
    seat1Wins: row.seat1_wins as number,
    seat2Wins: row.seat2_wins as number,
  }));

  // Aggregate stats per seat using shared helper
  const aggregated = aggregateMatchRecords(result.rows);
  const stats = new Map<number, { matchWins: number; matchLosses: number; gameWins: number; gameLosses: number }>();
  for (const [key, rec] of aggregated) {
    const seat = Number(key.split(":")[1]);
    stats.set(seat, rec);
  }

  // Compute tiebreakers (OMW%, OGW%)
  const tiebreakers = computeTiebreakers(stats, matches);

  // Convert to array and sort
  const redactedSeatsInResult = new Set<number>();
  const standings: StandingsEntry[] = [];
  const seatsInStandings = new Set<number>();

  for (const [seat, s] of stats) {
    seatsInStandings.add(seat);
    const isRedacted = resolvedOptedOutSeats.has(seat);
    if (isRedacted) {
      redactedSeatsInResult.add(seat);
    }
    const tb = tiebreakers.get(seat);
    standings.push({
      seat: isRedacted ? "[REDACTED]" : seat,
      matchWins: s.matchWins,
      matchLosses: s.matchLosses,
      gameWins: s.gameWins,
      gameLosses: s.gameLosses,
      omwPct: tb?.omwPct ?? null,
      ogwPct: tb?.ogwPct ?? null,
    });
  }

  // Sort: match wins DESC → OMW% DESC (nulls last) → OGW% DESC (nulls last)
  standings.sort((a, b) => {
    if (b.matchWins !== a.matchWins) return b.matchWins - a.matchWins;
    // OMW% descending, nulls last
    const aOmw = a.omwPct ?? -1;
    const bOmw = b.omwPct ?? -1;
    if (bOmw !== aOmw) return bOmw - aOmw;
    // OGW% descending, nulls last
    const aOgw = a.ogwPct ?? -1;
    const bOgw = b.ogwPct ?? -1;
    return bOgw - aOgw;
  });

  // Append seats with no matches (if numSeats provided)
  if (numSeats != null) {
    for (let seat = 1; seat <= numSeats; seat++) {
      if (!seatsInStandings.has(seat)) {
        const isRedacted = resolvedOptedOutSeats.has(seat);
        if (isRedacted) {
          redactedSeatsInResult.add(seat);
        }
        standings.push({
          seat: isRedacted ? "[REDACTED]" : seat,
          matchWins: 0,
          matchLosses: 0,
          gameWins: 0,
          gameLosses: 0,
          omwPct: null,
          ogwPct: null,
        });
      }
    }
  }

  return {
    standings,
    matches,
    ...(redactedSeatsInResult.size > 0 && {
      redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
    }),
  };
}

// ============================================================================
// Live Draft Pick Queries
// ============================================================================

/**
 * Get the latest pick number for a draft.
 * Returns 0 if no picks have been made.
 */
export async function getLatestPickNumber(
  client: Client,
  draftId: string,
): Promise<number> {
  const result = await client.execute({
    sql: "SELECT COALESCE(MAX(pick_n), 0) as latest FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  return result.rows[0].latest as number;
}

/**
 * Get the N most recent picks for a draft, newest first.
 * Redacts card names for opted-out seats.
 */
export async function getRecentPicks(
  client: Client,
  draftId: string,
  limit: number,
  optedOutSeats?: Set<number>,
): Promise<Array<{ pickN: number; seat: number; cardName: string }>> {
  const resolvedOptedOutSeats = optedOutSeats ?? await getOptedOutSeats(client, draftId);
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, c.name as card_name
          FROM pick_events pe
          JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?
          ORDER BY pe.pick_n DESC LIMIT ?`,
    args: [draftId, limit],
  });
  return result.rows.map((r) => {
    const seat = r.seat as number;
    return {
      pickN: r.pick_n as number,
      seat,
      cardName: resolvedOptedOutSeats.has(seat) ? "[REDACTED]" : (r.card_name as string),
    };
  });
}

export interface PickWithCardDetails {
  pickN: number;
  seat: number;
  cardName: string;
  oracleId: string;
  colorIdentity: string[];
  manaCost: string;
}

/**
 * Get all picks for a draft with Scryfall card details (color identity, mana cost).
 * Used by the draft board to render the pick matrix.
 * Redacts card names for opted-out seats.
 */
export async function getPicksWithCardDetails(
  client: Client,
  draftId: string,
  optedOutSeats?: Set<number>,
): Promise<PickWithCardDetails[]> {
  const resolvedOptedOutSeats = optedOutSeats ?? await getOptedOutSeats(client, draftId);
  const result = await client.execute({
    sql: `SELECT pe.pick_n, pe.seat, c.name, c.oracle_id, c.scryfall_json
          FROM pick_events pe
          JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ?
          ORDER BY pe.pick_n`,
    args: [draftId],
  });
  return result.rows.map((r) => {
    const seat = r.seat as number;
    const isRedacted = resolvedOptedOutSeats.has(seat);
    const sf = isRedacted ? undefined : transformScryfallJson(r.scryfall_json as string | null, r.name as string);
    return {
      pickN: r.pick_n as number,
      seat,
      cardName: isRedacted ? "[REDACTED]" : (r.name as string),
      oracleId: isRedacted ? "" : (r.oracle_id as string),
      colorIdentity: sf?.colorIdentity ?? [],
      manaCost: sf?.manaCost ?? "",
    };
  });
}
