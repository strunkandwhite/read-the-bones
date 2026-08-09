/**
 * Shared helper functions used across query modules.
 */

import type { Client } from "@libsql/client";
import type { Card, ScryfallCardData } from "../schema";
import type { ScryCard } from "../../types";
import { inferDeckColor } from "../../inferDeckColor";

// Re-export so callers that import LookupCardResult from here keep working.
export type { LookupCardResult } from "../../scryfallApi";

/**
 * Build a SQL placeholder string for n parameters (e.g., "?, ?, ?").
 */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * Parse banned cards JSON from database column.
 * Returns a lowercase Set for O(1) lookups, or an empty Set on null/malformed input.
 */
export function parseBannedCards(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const names = JSON.parse(json) as string[];
    return new Set(names.map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Parse banned cards JSON from database column as a raw name array.
 * Used when original casing is needed (e.g., API responses, display).
 */
export function parseBannedCardNames(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}

/**
 * Get opted-out seats for a single draft.
 *
 * Consumed by the ingest filter and by the /live route's display flag. Query
 * modules do not call this — redaction happens at ingest.
 */
export async function getOptedOutSeats(client: Client, draftId: string): Promise<Set<number>> {
  const result = await client.execute({
    sql: `SELECT seat FROM privacy_opt_outs WHERE draft_id = ?`,
    args: [draftId],
  });
  return new Set(result.rows.map((row) => row.seat as number));
}

/**
 * Get remaining copies for a set of cards in a draft.
 * remaining = cube_snapshot_cards.qty - COUNT(pick_events)
 */
export async function getRemainingCopies(
  client: Client,
  draftId: string,
  cardIds: number[],
): Promise<Map<number, number>> {
  if (cardIds.length === 0) return new Map();

  const ph = placeholders(cardIds.length);
  const result = await client.execute({
    sql: `SELECT csc.card_id, csc.qty, COALESCE(pe.cnt, 0) AS picked
          FROM cube_snapshot_cards csc
          JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
          LEFT JOIN (
            SELECT card_id, COUNT(*) AS cnt
            FROM pick_events WHERE draft_id = ?
            GROUP BY card_id
          ) pe ON csc.card_id = pe.card_id
          WHERE d.draft_id = ? AND csc.card_id IN (${ph})`,
    args: [draftId, draftId, ...cardIds],
  });

  const remaining = new Map<number, number>();
  for (const row of result.rows) {
    remaining.set(
      row.card_id as number,
      (row.qty as number) - (row.picked as number),
    );
  }
  return remaining;
}

export function rowToCard(row: Record<string, unknown>): Card {
  return {
    card_id: row.card_id as number,
    oracle_id: row.oracle_id as string,
    name: row.name as string,
    scryfall_json: (row.scryfall_json as string) || null,
  };
}

/**
 * Parse Scryfall JSON to the minimal ScryfallCardData shape (snake_case)
 * used for filtering (color, type). See also transformScryfallJson which
 * parses to the full ScryCard shape for display.
 */
export function parseScryfallJson(json: string | null): ScryfallCardData | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ScryfallCardData;
  } catch {
    return null;
  }
}

/**
 * Check if a card's color identity matches a color filter string.
 * "C" matches colorless (empty identity). Otherwise checks that all
 * requested colors appear in the card's color identity.
 */
export function matchesColorFilter(colorIdentity: string[], filterColor: string): boolean {
  if (filterColor.toUpperCase() === "C") {
    return colorIdentity.length === 0;
  }
  const requestedColors = filterColor.toUpperCase().split("");
  return requestedColors.every((c) => colorIdentity.includes(c));
}

/**
 * Infer deck colors for each seat from maindecked cards' color identity.
 * Returns a Map from "draftId:seat" to the inferred color string (e.g. "UB").
 *
 * Uses the 30% threshold from inferDeckColor: top 1-2 colors where the
 * 2nd must be >= 30% as frequent as the 1st.
 */
export async function inferSeatColors(
  client: Client,
  draftIds: string[]
): Promise<Map<string, string>> {
  if (draftIds.length === 0) return new Map();

  const result = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, c.scryfall_json
          FROM deck_cards dc
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck' AND dc.draft_id IN (${placeholders(draftIds.length)})`,
    args: draftIds,
  });

  // Group cards by (draft_id, seat) and count color occurrences
  const seatColors = new Map<string, Map<string, number>>();

  for (const row of result.rows) {
    const key = `${row.draft_id}:${row.seat}`;
    const scryfall = parseScryfallJson(row.scryfall_json as string | null);
    const colors = scryfall?.color_identity ?? [];

    if (!seatColors.has(key)) {
      seatColors.set(key, new Map());
    }
    const counts = seatColors.get(key)!;
    for (const color of colors) {
      counts.set(color, (counts.get(color) || 0) + 1);
    }
  }

  // Infer top 1-2 colors per seat
  const seatToColor = new Map<string, string>();
  for (const [key, counts] of seatColors) {
    seatToColor.set(key, inferDeckColor(counts));
  }

  return seatToColor;
}

/**
 * Find seats whose inferred deck color contains all the requested colors.
 * Convenience wrapper around inferSeatColors for filtering use cases.
 */
export async function getSeatsMatchingColors(
  client: Client,
  draftIds: string[],
  deckColors: string
): Promise<Set<string>> {
  const seatToColor = await inferSeatColors(client, draftIds);
  const requestedColors = deckColors.toUpperCase().split("");
  const matchingSeats = new Set<string>();

  for (const [key, inferred] of seatToColor) {
    if (requestedColors.every((c) => inferred.includes(c))) {
      matchingSeats.add(key);
    }
  }

  return matchingSeats;
}

/**
 * Transform Scryfall JSON from database to the full ScryCard type (camelCase)
 * with image URI and DFC handling. Companion to parseScryfallJson which returns
 * the minimal snake_case ScryfallCardData shape for DB-level filtering.
 */
export function transformScryfallJson(json: string | null, cardName: string): ScryCard | undefined {
  if (!json) return undefined;

  try {
    const data = JSON.parse(json);

    let imageUri = "";
    if (data.card_faces && data.card_faces[0]?.image_uris?.normal) {
      imageUri = data.card_faces[0].image_uris.normal;
    } else if (data.image_uris?.normal) {
      imageUri = data.image_uris.normal;
    }

    return {
      name: data.name || cardName,
      imageUri,
      manaCost: data.mana_cost || "",
      manaValue: data.cmc || 0,
      typeLine: data.type_line || "",
      colors: data.colors || [],
      colorIdentity: data.color_identity || [],
      oracleText: data.oracle_text || "",
    };
  } catch {
    return undefined;
  }
}

