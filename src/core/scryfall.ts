/**
 * Scryfall API integration for fetching card data.
 * Includes rate limiting and file-based caching.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { ScryCard } from "./types";
import {
  SCRYFALL_API_BASE,
  transformApiResponse,
  type ScryfallApiResponse,
} from "./scryfallApi";

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
 *
 * @param cachePath - Path to the cache file
 * @returns Map of card names to card data
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
      cache.set(name, card);
    }
  } catch (error) {
    console.warn(`[Scryfall] Failed to load cache from ${cachePath}:`, error);
  }

  return cache;
}

/**
 * Save card data cache to a JSON file.
 *
 * @param cachePath - Path to the cache file
 * @param cache - Map of card names to card data
 */
export function saveCache(cachePath: string, cache: Map<string, ScryCard>): void {
  // Ensure the directory exists
  const dir = dirname(cachePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const data: Record<string, ScryCard> = {};
  for (const [name, card] of cache) {
    data[name] = card;
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
 *
 * @param cardNames - Array of card names to fetch
 * @param cachePath - Path to cache file (default: cache/scryfall.json)
 * @returns Map of card names to card data (missing cards are omitted)
 */
export async function fetchCards(
  cardNames: string[],
  cachePath: string = DEFAULT_CACHE_PATH
): Promise<Map<string, ScryCard>> {
  const cache = loadCache(cachePath);

  // Deduplicate card names
  const uniqueNames = [...new Set(cardNames)];

  // Find which cards need to be fetched
  const missingNames = uniqueNames.filter((name) => !cache.has(name));

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
        cache.set(name, card);
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
  const result = new Map<string, ScryCard>();
  for (const name of uniqueNames) {
    const card = cache.get(name);
    if (card) {
      result.set(name, card);
    }
  }

  return result;
}

