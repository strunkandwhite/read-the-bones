"use client";

import { useCardData } from "./CardDataContext";

/**
 * Resolve a card name to its image URL.
 * Checks local card data first, falls back to Scryfall API.
 */
export function useCardImage(cardName: string): string {
  const { cards } = useCardData();

  // Normalize: strip numeric suffixes like "Scalding Tarn 2"
  const normalized = cardName.replace(/\s+\d+$/, "").trim();

  // Check local data (case-insensitive)
  const card = cards.find(
    (c) => c.cardName.toLowerCase() === normalized.toLowerCase()
  );

  if (card?.scryfall?.imageUri) {
    return card.scryfall.imageUri;
  }

  // Fallback: Scryfall direct image URL
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(normalized)}&format=image`;
}
