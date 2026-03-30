/**
 * Scryfall file-based cache operations.
 * Uses Node.js fs for reading/writing cache files.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/cardNames";

/**
 * Load cached card data from a JSON file.
 * Uses lowercase keys for case-insensitive matching.
 *
 * @param cachePath - Path to the cache file
 * @returns Map of lowercase card name key to card data
 */
export function loadCache(cachePath: string): Map<string, ScryCard> {
  const cache = new Map<string, ScryCard>();

  if (!existsSync(cachePath)) {
    return cache;
  }

  try {
    const content = readFileSync(cachePath, "utf-8");
    const data = JSON.parse(content) as Record<string, ScryCard>;

    for (const [name, card] of Object.entries(data)) {
      // Use lowercase key for case-insensitive lookup
      cache.set(cardNameKey(name), card);
    }
  } catch (error) {
    console.warn(`[Scryfall] Failed to load cache from ${cachePath}:`, error);
  }

  return cache;
}

/**
 * Save card data cache to a JSON file.
 * Uses the card's Scryfall name as the key in the JSON file.
 *
 * @param cachePath - Path to the cache file
 * @param cache - Map of lowercase key to card data
 */
export function saveCache(cachePath: string, cache: Map<string, ScryCard>): void {
  // Ensure the directory exists
  const dir = dirname(cachePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data: Record<string, ScryCard> = {};
  for (const [, card] of cache) {
    // Use Scryfall's canonical name as the JSON key
    data[card.name] = card;
  }

  try {
    writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.warn(`[Scryfall] Failed to save cache to ${cachePath}:`, error);
  }
}
