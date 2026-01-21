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
    image_uris?: {
      normal?: string;
    };
  }>;
}

/**
 * Shape of the Scryfall search API response.
 * Returns a list of cards in the `data` array.
 */
export interface ScryfallSearchResponse {
  data: ScryfallApiResponse[];
  total_cards: number;
  has_more: boolean;
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

  return {
    name: data.name,
    imageUri,
    manaCost: data.mana_cost ?? "",
    manaValue: data.cmc ?? 0,
    typeLine: data.type_line ?? "",
    colors: data.colors ?? [],
    colorIdentity: data.color_identity ?? [],
    oracleText,
  };
}
