/**
 * Scryfall API integration for fetching card data.
 * Includes rate limiting and file-based caching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ScryCard } from "../core/types";
import {
  SCRYFALL_API_BASE,
  transformApiResponse,
  type ScryfallApiResponse,
} from "../core/scryfallApi";
import { cardNameKey } from "../core/parseCsv";

/** Default delay between API requests (ms) - Scryfall asks for 50-100ms */
const RATE_LIMIT_DELAY_MS = 75;

/** Default cache file path */
const DEFAULT_CACHE_PATH = "cache/scryfall.json";

/**
 * Sleep utility for rate limiting.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

/**
 * Fetch multiple cards from Scryfall, using cache and rate limiting.
 *
 * Cards already in cache are returned immediately.
 * Missing cards are fetched with rate limiting (50-100ms between requests).
 * The cache is updated and saved after fetching.
 * Uses case-insensitive matching for cache lookups.
 *
 * @param cardNames - Array of card names to fetch
 * @param cachePath - Path to cache file (default: cache/scryfall.json)
 * @returns Map of lowercase card key to card data (missing cards are omitted)
 */
export async function fetchCards(
  cardNames: string[],
  cachePath: string = DEFAULT_CACHE_PATH
): Promise<Map<string, ScryCard>> {
  const cache = loadCache(cachePath);

  // Deduplicate card names (case-insensitive)
  const seenKeys = new Set<string>();
  const uniqueNames: string[] = [];
  for (const name of cardNames) {
    const key = cardNameKey(name);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueNames.push(name);
    }
  }

  // Find which cards need to be fetched (case-insensitive lookup)
  const missingNames = uniqueNames.filter((name) => !cache.has(cardNameKey(name)));

  if (missingNames.length > 0) {
    console.log(
      `[Scryfall] Fetching ${missingNames.length} cards (${uniqueNames.length - missingNames.length} cached)`
    );

    for (let i = 0; i < missingNames.length; i++) {
      const name = missingNames[i];

      // Rate limiting - wait between requests
      if (i > 0) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      const card = await fetchCard(name);
      if (card) {
        // Store with lowercase key for case-insensitive lookup
        cache.set(cardNameKey(name), card);
      }

      // Progress indicator for large batches
      if (missingNames.length > 10 && (i + 1) % 10 === 0) {
        console.log(`[Scryfall] Progress: ${i + 1}/${missingNames.length}`);
      }
    }

    // Save updated cache
    saveCache(cachePath, cache);
  }

  // Return only the requested cards (in case cache has more)
  // Key is the lowercase card name key for consistent lookups
  const result = new Map<string, ScryCard>();
  for (const name of uniqueNames) {
    const card = cache.get(cardNameKey(name));
    if (card) {
      // Use lowercase key for consistent case-insensitive access
      result.set(cardNameKey(name), card);
    }
  }

  return result;
}

