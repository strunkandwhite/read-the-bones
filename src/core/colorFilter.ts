/**
 * Color filtering logic for card tables.
 *
 * Two modes:
 * - Inclusive: Card matches if it has ANY of the selected colors
 * - Exclusive: Card matches if ALL its colors are in the selected colors
 */

import type { ColorFilterMode } from "../app/components/ColorFilter";

/**
 * A card-like object with color information.
 * Can have colors in either scryfall.colorIdentity or colors array.
 */
export interface ColorFilterableCard {
  scryfall?: { colorIdentity?: string[] };
  colors?: string[];
}

/**
 * Filter cards by color with support for inclusive and exclusive modes.
 *
 * @param cards - Array of cards to filter
 * @param colorFilter - Array of selected color codes (W, U, B, R, G, C for colorless)
 * @param colorFilterMode - "inclusive" (ANY selected color) or "exclusive" (ONLY selected colors)
 * @returns Filtered array of cards
 */
export function filterCardsByColor<T extends ColorFilterableCard>(
  cards: T[],
  colorFilter: string[],
  colorFilterMode: ColorFilterMode
): T[] {
  // No filter active - return all cards
  if (colorFilter.length === 0) {
    return cards;
  }

  const selectedColors = colorFilter.filter((c) => c !== "C");
  const includesColorless = colorFilter.includes("C");

  return cards.filter((card) => {
    const cardColors = card.scryfall?.colorIdentity || card.colors || [];

    // Colorless check: if "C" is selected and card has no colors, it matches
    if (includesColorless && cardColors.length === 0) {
      return true;
    }

    if (colorFilterMode === "inclusive") {
      // Inclusive: card matches if it contains ANY selected color
      return selectedColors.some((color) => cardColors.includes(color));
    } else {
      // Exclusive: card matches if ALL its colors are in selected colors
      // (card colors must be a subset of selected colors)
      return cardColors.length > 0 && cardColors.every((color) => selectedColors.includes(color));
    }
  });
}
