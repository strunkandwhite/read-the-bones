/**
 * Draft pool queries with grouping support.
 */

import type { Client } from "@libsql/client";
import type { ScryfallCardData } from "../schema";
import { getOptedOutSeats, parseScryfallJson, matchesColorFilter } from "./helpers";
import { normalizeColorIdentity } from "@/core/manaColors";

export interface GetDraftPoolParams {
  draft_id: string;
  include_draft_results?: boolean;
  include_card_details?: boolean;
  group_by?: "none" | "color_identity" | "type";
  color?: string;
  type_contains?: string;
  name_contains?: string;
  optedOutSeats?: Set<number>;
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
 * Extract major card types from a type line.
 * Returns all matching types (a card can appear in multiple groups).
 */
export function extractMajorTypes(typeLine: string): string[] {
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
 * Group pool cards by color identity (WUBRG order).
 */
export function groupPoolByColor(
  cards: PoolCard[],
  scryfallCache: Map<string, ScryfallCardData | null>
): Record<string, PoolCard[]> {
  const grouped: Record<string, PoolCard[]> = {};
  for (const card of cards) {
    const scryfall = scryfallCache.get(card.card_name);
    const colorIdentity = normalizeColorIdentity(scryfall?.color_identity || []);
    if (!grouped[colorIdentity]) {
      grouped[colorIdentity] = [];
    }
    grouped[colorIdentity].push(card);
  }
  return grouped;
}

/**
 * Group pool cards by major card type.
 * A card may appear in multiple groups (e.g., "Artifact Creature").
 */
export function groupPoolByType(
  cards: PoolCard[],
  scryfallCache: Map<string, ScryfallCardData | null>
): Record<string, PoolCard[]> {
  const grouped: Record<string, PoolCard[]> = {};
  for (const card of cards) {
    const scryfall = scryfallCache.get(card.card_name);
    const typeLine = scryfall?.type_line || "";
    const types = extractMajorTypes(typeLine);

    for (const type of types) {
      if (!grouped[type]) {
        grouped[type] = [];
      }
      grouped[type].push(card);
    }

    if (types.length === 0) {
      if (!grouped["Other"]) {
        grouped["Other"] = [];
      }
      grouped["Other"].push(card);
    }
  }
  return grouped;
}

/**
 * Get the complete card pool for a specific draft.
 * Returns all cards that were available in the cube for that draft,
 * with optional filtering, grouping, and draft result annotation.
 * Redacts seat information for players who have opted out.
 */
export async function getDraftPool(
  client: Client,
  params: GetDraftPoolParams
): Promise<DraftPoolResult | null> {
  const includeDraftResults = params.include_draft_results ?? false;
  const includeCardDetails = params.include_card_details ?? false;
  const groupBy = params.group_by ?? "none";
  const optedOutSeats = params.optedOutSeats ?? await getOptedOutSeats(client, params.draft_id);

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
      if (!matchesColorFilter(scryfall?.color_identity || [], params.color)) continue;
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
  const grouped = groupBy === "color_identity"
    ? groupPoolByColor(cards, scryfallCache)
    : groupPoolByType(cards, scryfallCache);

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
