import { join } from "path";
import type { ScryCard } from "../../types";
import { cardNameKey } from "../../parseCsv";
import { fetchCard, loadCache, saveCache } from "../../../build/scryfall";
import { sleep } from "../../utils";
import { PROJECT_ROOT, log } from "./utils";

const SCRYFALL_CACHE_PATH = join(PROJECT_ROOT, "cache", "scryfall.json");

/** Rate limit delay between Scryfall API requests (ms) */
const RATE_LIMIT_DELAY_MS = 75;

export function loadScryfallCache(): Map<string, ScryCard> {
  const cache = loadCache(SCRYFALL_CACHE_PATH);

  // Index DFCs by front-face name so pool.csv lookups succeed
  // (pool.csv uses "Fable of the Mirror-Breaker", cache key is "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")
  const dfcEntries: [string, ScryCard][] = [];
  for (const [key, value] of cache) {
    if (key.includes(" // ")) {
      const frontFace = key.split(" // ")[0];
      dfcEntries.push([frontFace, value]);
    }
  }
  for (const [key, value] of dfcEntries) {
    cache.set(key, value);
  }

  return cache;
}

/**
 * Fetch any cards missing from the Scryfall cache.
 * Updates the cache map in place and saves to disk.
 */
export async function fetchMissingScryfallCards(
  cache: Map<string, ScryCard>,
  cardNames: string[]
): Promise<number> {
  const missing = cardNames.filter((name) => !cache.has(cardNameKey(name)));
  if (missing.length === 0) return 0;

  log(`Fetching ${missing.length} cards from Scryfall...`);

  let fetched = 0;
  for (let i = 0; i < missing.length; i++) {
    if (i > 0) await sleep(RATE_LIMIT_DELAY_MS);

    const card = await fetchCard(missing[i]);
    if (card) {
      cache.set(cardNameKey(missing[i]), card);
      // Index DFC front face
      if (card.name.includes(" // ")) {
        const frontFace = card.name.split(" // ")[0];
        cache.set(cardNameKey(frontFace), card);
      }
      fetched++;
    }
  }

  if (fetched > 0) {
    saveCache(SCRYFALL_CACHE_PATH, cache);
  }

  log(`Fetched ${fetched}/${missing.length} cards from Scryfall`);
  return fetched;
}

/**
 * Backfill scryfall_json for cards that are missing it.
 * This handles cases where cards were ingested before the Scryfall cache was available.
 */
export async function backfillScryfallData(
  client: import("@libsql/client").Client,
  scryfallCache: Map<string, ScryCard>
): Promise<number> {
  // Find cards missing scryfall_json
  const missing = await client.execute({
    sql: "SELECT card_id, name FROM cards WHERE scryfall_json IS NULL OR scryfall_json = ''",
    args: [],
  });

  if (missing.rows.length === 0) {
    return 0;
  }

  let updatedCount = 0;

  for (const row of missing.rows) {
    const cardId = row.card_id as number;
    const name = row.name as string;

    // Look up in scryfall cache (try exact name and lowercase)
    const scryfallData = scryfallCache.get(name.toLowerCase()) ||
      scryfallCache.get(name);

    if (scryfallData) {
      const scryfallJson = JSON.stringify({
        name: scryfallData.name,
        color_identity: scryfallData.colorIdentity,
        colors: scryfallData.colors,
        type_line: scryfallData.typeLine,
        oracle_text: scryfallData.oracleText,
        mana_cost: scryfallData.manaCost,
        cmc: scryfallData.manaValue,
        image_uris: scryfallData.imageUri ? { normal: scryfallData.imageUri } : undefined,
      });

      await client.execute({
        sql: "UPDATE cards SET scryfall_json = ? WHERE card_id = ?",
        args: [scryfallJson, cardId],
      });
      updatedCount++;
    }
  }

  return updatedCount;
}
