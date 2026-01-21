/**
 * Shared helper functions used across query modules.
 */

import { getClient } from "../client";
import type { Card, ScryfallCardData } from "../schema";
import { SCRYFALL_API_BASE, transformApiResponse, type ScryfallApiResponse } from "../../scryfallApi";

/**
 * Get opted-out seats for a draft.
 * Returns a Set of seat numbers that should be redacted.
 */
export async function getOptedOutSeats(draftId: string): Promise<Set<number>> {
  const client = await getClient();
  const result = await client.execute({
    sql: `SELECT seat FROM privacy_opt_outs WHERE draft_id = ?`,
    args: [draftId],
  });
  return new Set(result.rows.map((row) => row.seat as number));
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
 * used for filtering (color, type). See also transformScryfallJson in
 * getCards.ts which parses to the full ScryCard shape for display.
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
 * Returns a Set of "draftId:seat" keys for seats whose inferred colors
 * contain all the requested colors.
 *
 * Uses the same 30% threshold as inferDrafterColors in draftState.ts:
 * top 1-2 colors where the 2nd must be >= 30% as frequent as the 1st.
 */
export async function getSeatsMatchingColors(
  draftIds: string[],
  deckColors: string
): Promise<Set<string>> {
  if (draftIds.length === 0) return new Set();

  const client = await getClient();
  const placeholders = draftIds.map(() => "?").join(", ");

  const result = await client.execute({
    sql: `SELECT dc.draft_id, dc.seat, c.scryfall_json
          FROM deck_cards dc
          JOIN cards c ON dc.card_id = c.card_id
          WHERE dc.zone = 'deck' AND dc.draft_id IN (${placeholders})`,
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

  // Infer top 1-2 colors per seat and filter
  const requestedColors = deckColors.toUpperCase().split("");
  const matchingSeats = new Set<string>();

  for (const [key, counts] of seatColors) {
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([color]) => color);

    if (sorted.length === 0) continue;

    // Apply 30% threshold for 2nd color
    const inferredColors: string[] = [sorted[0]];
    if (sorted.length >= 2) {
      const topCount = counts.get(sorted[0]) || 0;
      const secondCount = counts.get(sorted[1]) || 0;
      if (secondCount >= topCount * 0.3) {
        inferredColors.push(sorted[1]);
      }
    }

    // Check if inferred colors contain all requested colors
    if (requestedColors.every((c) => inferredColors.includes(c))) {
      matchingSeats.add(key);
    }
  }

  return matchingSeats;
}

/**
 * Return type for lookupCard — uses snake_case intentionally because
 * this shape is returned as JSON from the API, matching Scryfall's
 * convention. Compare with ScryCard which uses camelCase for the UI.
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
 * Delegates DFC handling to the shared transformApiResponse, then maps to
 * the slim LookupCardResult shape used by the API.
 */
export async function fetchFromScryfallApi(
  cardName: string
): Promise<LookupCardResult | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?exact=${encodedName}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as ScryfallApiResponse;
    const card = transformApiResponse(data);

    return {
      name: card.name,
      oracle_text: card.oracleText || null,
      type_line: card.typeLine || null,
      mana_cost: card.manaCost || null,
      color_identity: card.colorIdentity || [],
    };
  } catch {
    return null;
  }
}
