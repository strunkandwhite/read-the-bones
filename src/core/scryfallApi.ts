/**
 * Shared Scryfall API types and utilities.
 * This module has no Node.js dependencies and can be safely imported in browser context.
 */

import type { ScryCard } from "./types";

/** Scryfall API base URL */
export const SCRYFALL_API_BASE = "https://api.scryfall.com";

/**
 * Shape of the Scryfall API response for card lookup.
 * We only type the fields we actually use.
 */
export interface ScryfallApiResponse {
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  colors?: string[];
  color_identity?: string[];
  oracle_text?: string;
  image_uris?: {
    normal?: string;
    small?: string;
    large?: string;
    png?: string;
    art_crop?: string;
    border_crop?: string;
  };
  // For double-faced cards, image_uris and oracle_text may be missing; use card_faces instead
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    colors?: string[];
    image_uris?: {
      normal?: string;
    };
  }>;
}

/**
 * Transform Scryfall API response to our ScryCard type.
 */
export function transformApiResponse(data: ScryfallApiResponse): ScryCard {
  // Handle double-faced cards where image_uris is at card_faces level
  let imageUri = data.image_uris?.normal ?? "";
  if (!imageUri && data.card_faces?.[0]?.image_uris?.normal) {
    imageUri = data.card_faces[0].image_uris.normal;
  }

  // Handle oracle text - for double-faced cards, concatenate both faces
  let oracleText = data.oracle_text ?? "";
  if (!oracleText && data.card_faces) {
    oracleText = data.card_faces
      .map((face) => face.oracle_text ?? "")
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  // Handle mana cost - for DFCs, mana_cost is on the front face
  let manaCost = data.mana_cost ?? "";
  if (!manaCost && data.card_faces?.[0]?.mana_cost) {
    manaCost = data.card_faces[0].mana_cost;
  }

  // Handle colors - for DFCs, colors is per-face, not top-level
  let colors = data.colors;
  if (!colors && data.card_faces) {
    const faceColors = data.card_faces.flatMap((face) => face.colors ?? []);
    colors = [...new Set(faceColors)];
  }

  return {
    name: data.name,
    imageUri,
    manaCost,
    manaValue: data.cmc ?? 0,
    typeLine: data.type_line ?? "",
    colors: colors ?? [],
    colorIdentity: data.color_identity ?? [],
    oracleText,
  };
}

/**
 * Fetch a single card from the Scryfall API.
 *
 * @param cardName - The exact card name to look up
 * @returns The card data, or null if not found
 */
export async function fetchCard(cardName: string): Promise<ScryCard | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?exact=${encodedName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`[Scryfall] Card not found: "${cardName}"`);
        return null;
      }
      console.warn(
        `[Scryfall] API error for "${cardName}": ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as ScryfallApiResponse;
    return transformApiResponse(data);
  } catch (error) {
    console.warn(`[Scryfall] Failed to fetch "${cardName}":`, error);
    return null;
  }
}

/**
 * Fetch a single card using Scryfall's fuzzy name matching.
 * Handles Omen Paths digital names and other alternate names.
 */
export async function fetchCardFuzzy(cardName: string): Promise<ScryCard | null> {
  const encodedName = encodeURIComponent(cardName);
  const url = `${SCRYFALL_API_BASE}/cards/named?fuzzy=${encodedName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      console.warn(
        `[Scryfall] Fuzzy API error for "${cardName}": ${response.status} ${response.statusText}`
      );
      return null;
    }

    const data = (await response.json()) as ScryfallApiResponse;
    return transformApiResponse(data);
  } catch (error) {
    console.warn(`[Scryfall] Failed fuzzy fetch "${cardName}":`, error);
    return null;
  }
}
