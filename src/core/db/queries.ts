/**
 * Database query functions for LLM tools.
 * All functions use the singleton Turso client from client.ts.
 */

import { getClient } from "./client";
import type { Card, ScryfallCardData } from "./schema";
import { SCRYFALL_API_BASE, type ScryfallApiResponse } from "../scryfallApi";
import { calculatePickWeight, weightedGeometricMean } from "../utils";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get opted-out seats for a draft.
 * Returns a Set of seat numbers that should be redacted.
 */
async function getOptedOutSeats(draftId: string): Promise<Set<number>> {
  const client = await getClient();
  const result = await client.execute({
    sql: `SELECT seat FROM llm_opt_outs WHERE draft_id = ?`,
    args: [draftId],
  });
  return new Set(result.rows.map((row) => row.seat as number));
}

/**
 * Resolve a card by name (case-insensitive).
 * Returns the full card record or null if not found.
 */
export async function resolveCard(cardName: string): Promise<Card | null> {
  const client = await getClient();

  const result = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json
          FROM cards
          WHERE LOWER(name) = LOWER(?)
          LIMIT 1`,
    args: [cardName],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    card_id: row.card_id as number,
    oracle_id: row.oracle_id as string,
    name: row.name as string,
    scryfall_json: row.scryfall_json as string | null,
  };
}

/**
 * Parse Scryfall JSON data from a card record.
 */
function parseScryfallJson(json: string | null): ScryfallCardData | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ScryfallCardData;
  } catch {
    return null;
  }
}

/**
 * Return type for lookupCard function.
 */
export interface LookupCardResult {
  name: string;
  oracle_text: string | null;
  type_line: string | null;
  mana_cost: string | null;
  color_identity: string[];
}

/**
 * Fetch card data from Scryfall API.
 * Returns null if the card is not found or on error.
 */
async function fetchFromScryfallApi(
  cardName: string
): Promise<LookupCardResult | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?exact=${encodedName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      // Card not found or other HTTP error
      return null;
    }

    const data = (await response.json()) as ScryfallApiResponse;

    // Handle double-faced cards - combine oracle text from both faces
    if (data.card_faces && data.card_faces.length > 0) {
      const oracleTexts = data.card_faces
        .map((face, i) => {
          const label =
            data.card_faces!.length === 2
              ? i === 0
                ? "Front"
                : "Back"
              : `Face ${i + 1}`;
          return face.oracle_text ? `${label}: ${face.oracle_text}` : null;
        })
        .filter(Boolean);

      const typeLines = data.card_faces
        .map((face) => face.type_line)
        .filter(Boolean);

      const manaCosts = data.card_faces
        .map((face) => face.mana_cost)
        .filter(Boolean);

      return {
        name: data.name,
        oracle_text: oracleTexts.length > 0 ? oracleTexts.join("\n") : null,
        type_line: typeLines.length > 0 ? typeLines.join(" // ") : null,
        mana_cost: manaCosts.length > 0 ? manaCosts.join(" // ") : null,
        color_identity: data.color_identity || [],
      };
    }

    // Single-faced card
    return {
      name: data.name,
      oracle_text: data.oracle_text || null,
      type_line: data.type_line || null,
      mana_cost: data.mana_cost || null,
      color_identity: data.color_identity || [],
    };
  } catch {
    // Network error or JSON parsing error
    return null;
  }
}

/**
 * Look up a card by name and return parsed Scryfall data.
 * First checks the local database, then falls back to the Scryfall API.
 * Returns structured card information useful for LLM tools.
 */
export async function lookupCard(
  cardName: string
): Promise<LookupCardResult | null> {
  // First, try to find the card in the database
  const card = await resolveCard(cardName);
  if (card) {
    const scryfall = parseScryfallJson(card.scryfall_json);

    return {
      name: card.name,
      oracle_text: scryfall?.oracle_text || null,
      type_line: scryfall?.type_line || null,
      mana_cost: scryfall?.mana_cost || null,
      color_identity: scryfall?.color_identity || [],
    };
  }

  // Fallback: query the Scryfall API directly
  return fetchFromScryfallApi(cardName);
}

// ============================================================================
// Draft Queries
// ============================================================================

export interface DraftListItem {
  draft_id: string;
  draft_name: string;
  draft_date: string;
}

export interface ListDraftsFilters {
  date_from?: string;
  date_to?: string;
  draft_name?: string;
}

/**
 * List drafts matching optional filters.
 * Results are sorted by date descending (most recent first).
 */
export async function listDrafts(
  filters?: ListDraftsFilters
): Promise<DraftListItem[]> {
  const client = await getClient();

  const conditions: string[] = [];
  const args: (string | number)[] = [];

  if (filters?.date_from) {
    conditions.push("d.draft_date >= ?");
    args.push(filters.date_from);
  }

  if (filters?.date_to) {
    conditions.push("d.draft_date <= ?");
    args.push(filters.date_to);
  }

  if (filters?.draft_name) {
    conditions.push("LOWER(d.draft_name) LIKE LOWER(?)");
    args.push(`%${filters.draft_name}%`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const result = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date
          FROM drafts d
          ${whereClause}
          ORDER BY d.draft_date DESC`,
    args,
  });

  return result.rows.map((row) => ({
    draft_id: row.draft_id as string,
    draft_name: row.draft_name as string,
    draft_date: row.draft_date as string,
  }));
}

export interface DraftDetails {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  num_seats: number;
}

/**
 * Get detailed information about a specific draft.
 * Returns null if the draft doesn't exist.
 */
export async function getDraft(draftId: string): Promise<DraftDetails | null> {
  const client = await getClient();

  const draftResult = await client.execute({
    sql: `SELECT draft_id, draft_name, draft_date, num_seats
          FROM drafts
          WHERE draft_id = ?`,
    args: [draftId],
  });

  if (draftResult.rows.length === 0) {
    return null;
  }

  const draft = draftResult.rows[0];

  return {
    draft_id: draft.draft_id as string,
    draft_name: draft.draft_name as string,
    draft_date: draft.draft_date as string,
    num_seats: draft.num_seats as number,
  };
}

// ============================================================================
// Pick Queries
// ============================================================================

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
    sql: `SELECT cube_snapshot_id FROM drafts WHERE draft_id = ?`,
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

    // Parse scryfall JSON once if either filter needs it
    const scryfall = (params.color || params.type_contains)
      ? parseScryfallJson(scryfallJson)
      : null;

    // Apply color filter
    if (params.color) {
      if (!scryfall) continue;

      const colorIdentity = scryfall.color_identity || [];

      if (params.color.toUpperCase() === "C") {
        // Colorless: empty color identity
        if (colorIdentity.length !== 0) continue;
      } else {
        // Check if all requested colors are in the card's color identity
        const requestedColors = params.color.toUpperCase().split("");
        const hasAllColors = requestedColors.every((c) =>
          colorIdentity.includes(c)
        );
        if (!hasAllColors) continue;
      }
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

// ============================================================================
// Card Pick Stats Query
// ============================================================================

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

  // For cards that appear multiple times in a draft, track copy numbers
  const picksByDraft = new Map<string, { pick_n: number; seat: number }[]>();
  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    if (!picksByDraft.has(draftId)) {
      picksByDraft.set(draftId, []);
    }
    picksByDraft.get(draftId)!.push({
      pick_n: row.pick_n as number,
      seat: row.seat as number,
    });
  }

  // Collect all pick positions for stats
  const pickPositions: number[] = [];
  const weightedItems: { value: number; weight: number }[] = [];

  for (const draftId of draftIds) {
    const picks = picksByDraft.get(draftId) || [];
    // Get actual cube size from cube_snapshot_cards
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    const poolSize = cubeSnapshotId ? (cubeSizes.get(cubeSnapshotId) || 540) : 540;

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

  return {
    card_name: card.name,
    drafts_seen,
    times_picked,
    avg_pick_n: Math.round(avg_pick_n * 10) / 10,
    median_pick_n,
    weighted_geomean: Math.round(weighted_geomean * 10) / 10,
  };
}

// ============================================================================
// Draft Pool Query
// ============================================================================

export interface GetDraftPoolParams {
  draft_id: string;
  include_draft_results?: boolean;
  include_card_details?: boolean;
  group_by?: "none" | "color_identity" | "type";
  color?: string;
  type_contains?: string;
  name_contains?: string;
}

export interface PoolCard {
  card_name: string;
  quantity: number;
  drafted: boolean;
  drafted_by_seat: number | "[REDACTED]" | null;
  drafted_pick_n: number | null;
  mana_cost?: string | null;
  type_line?: string | null;
  colors?: string[] | null;
  color_identity?: string | null;
}

export interface DraftPoolResult {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  total_cards: number;
  redacted_seats?: number[];
  cards: PoolCard[] | null;
  grouped: Record<string, PoolCard[]> | null;
}

/**
 * Normalize color identity to WUBRG order.
 * E.g., ["G", "U"] → "GU" → "UG"
 */
function normalizeColorIdentity(colors: string[]): string {
  if (colors.length === 0) return "C";
  const order = "WUBRG";
  return colors
    .map((c) => c.toUpperCase())
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .join("");
}

/**
 * Extract major card types from a type line.
 * Returns all matching types (a card can appear in multiple groups).
 */
function extractMajorTypes(typeLine: string): string[] {
  const majorTypes = [
    "Creature",
    "Planeswalker",
    "Artifact",
    "Enchantment",
    "Instant",
    "Sorcery",
    "Land",
  ];
  const types: string[] = [];
  const lowerTypeLine = typeLine.toLowerCase();

  for (const type of majorTypes) {
    if (lowerTypeLine.includes(type.toLowerCase())) {
      types.push(type);
    }
  }

  return types;
}

/**
 * Get the complete card pool for a specific draft.
 * Returns all cards that were available in the cube for that draft,
 * with optional filtering, grouping, and draft result annotation.
 * Redacts seat information for players who have opted out.
 */
export async function getDraftPool(
  params: GetDraftPoolParams
): Promise<DraftPoolResult | null> {
  const client = await getClient();
  const includeDraftResults = params.include_draft_results ?? false;
  const includeCardDetails = params.include_card_details ?? false;
  const groupBy = params.group_by ?? "none";
  const optedOutSeats = await getOptedOutSeats(params.draft_id);

  // Get draft metadata and pool cards with optional pick data
  const result = await client.execute({
    sql: `SELECT
            d.draft_id, d.draft_name, d.draft_date,
            c.name AS card_name,
            csc.qty AS quantity,
            c.scryfall_json,
            pe.seat AS drafted_by_seat,
            pe.pick_n AS drafted_pick_n
          FROM drafts d
          JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
          JOIN cards c ON csc.card_id = c.card_id
          LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = c.card_id
          WHERE d.draft_id = ?
          ORDER BY c.name ASC`,
    args: [params.draft_id],
  });

  if (result.rows.length === 0) {
    // Check if draft exists but has no cards
    const draftCheck = await client.execute({
      sql: `SELECT draft_id FROM drafts WHERE draft_id = ?`,
      args: [params.draft_id],
    });
    if (draftCheck.rows.length === 0) {
      return null; // Draft doesn't exist
    }
  }

  // Extract draft metadata from first row (or return empty pool)
  const firstRow = result.rows[0];
  const draftId = (firstRow?.draft_id as string) ?? params.draft_id;
  const draftName = (firstRow?.draft_name as string) ?? "";
  const draftDate = (firstRow?.draft_date as string) ?? "";

  // Process cards
  const cards: PoolCard[] = [];
  const redactedSeatsInResult = new Set<number>();

  // Store parsed Scryfall data for reuse during grouping
  const scryfallCache = new Map<string, ReturnType<typeof parseScryfallJson>>();

  for (const row of result.rows) {
    const cardName = row.card_name as string;
    const quantity = row.quantity as number;
    const scryfallJson = row.scryfall_json as string | null;
    const draftedBySeat = row.drafted_by_seat as number | null;
    const draftedPickN = row.drafted_pick_n as number | null;

    // Parse Scryfall data for filtering and details (cache for grouping)
    const scryfall = parseScryfallJson(scryfallJson);
    scryfallCache.set(cardName, scryfall);

    // Apply name filter
    if (params.name_contains) {
      if (!cardName.toLowerCase().includes(params.name_contains.toLowerCase())) {
        continue;
      }
    }

    // Apply color filter
    if (params.color) {
      const colorIdentity = scryfall?.color_identity || [];

      if (params.color.toUpperCase() === "C") {
        // Colorless: empty color identity
        if (colorIdentity.length !== 0) continue;
      } else {
        // Check if all requested colors are in the card's color identity
        const requestedColors = params.color.toUpperCase().split("");
        const hasAllColors = requestedColors.every((c) =>
          colorIdentity.includes(c)
        );
        if (!hasAllColors) continue;
      }
    }

    // Apply type filter
    if (params.type_contains) {
      const typeLine = scryfall?.type_line || "";
      if (!typeLine.toLowerCase().includes(params.type_contains.toLowerCase())) {
        continue;
      }
    }

    // Check if seat is opted out
    const isRedacted = draftedBySeat !== null && optedOutSeats.has(draftedBySeat);
    if (isRedacted) {
      redactedSeatsInResult.add(draftedBySeat);
    }

    // Build card object with redaction
    const card: PoolCard = {
      card_name: cardName,
      quantity,
      drafted: draftedBySeat !== null,
      drafted_by_seat: includeDraftResults
        ? (isRedacted ? "[REDACTED]" : draftedBySeat)
        : null,
      drafted_pick_n: includeDraftResults ? draftedPickN : null,
    };

    // Add card details if requested
    if (includeCardDetails) {
      card.mana_cost = scryfall?.mana_cost || null;
      card.type_line = scryfall?.type_line || null;
      card.colors = scryfall?.colors || null;
      card.color_identity = scryfall?.color_identity
        ? normalizeColorIdentity(scryfall.color_identity)
        : null;
    }

    cards.push(card);
  }

  // Handle grouping
  if (groupBy === "none") {
    return {
      draft_id: draftId,
      draft_name: draftName,
      draft_date: draftDate,
      total_cards: cards.length,
      ...(redactedSeatsInResult.size > 0 && {
        redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
      }),
      cards,
      grouped: null,
    };
  }

  // Group cards (using cached Scryfall data)
  const grouped: Record<string, PoolCard[]> = {};

  for (const card of cards) {
    const scryfall = scryfallCache.get(card.card_name);

    if (groupBy === "color_identity") {
      const colorIdentity = normalizeColorIdentity(scryfall?.color_identity || []);

      if (!grouped[colorIdentity]) {
        grouped[colorIdentity] = [];
      }
      grouped[colorIdentity].push(card);
    } else if (groupBy === "type") {
      const typeLine = scryfall?.type_line || "";
      const types = extractMajorTypes(typeLine);

      // Card appears in each type group it matches
      for (const type of types) {
        if (!grouped[type]) {
          grouped[type] = [];
        }
        grouped[type].push(card);
      }

      // If no types matched, put in "Other"
      if (types.length === 0) {
        if (!grouped["Other"]) {
          grouped["Other"] = [];
        }
        grouped["Other"].push(card);
      }
    }
  }

  return {
    draft_id: draftId,
    draft_name: draftName,
    draft_date: draftDate,
    total_cards: cards.length,
    ...(redactedSeatsInResult.size > 0 && {
      redacted_seats: Array.from(redactedSeatsInResult).sort((a, b) => a - b),
    }),
    cards: null,
    grouped,
  };
}
