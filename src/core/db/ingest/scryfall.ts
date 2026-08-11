import { join } from "path";
import type { ScryCard } from "../../types";
import { getFrontFace } from "../../cardNames";
import { loadCache } from "../../../build/scryfall";
import { PROJECT_ROOT } from "./utils";
import { serializeScryfallEntry } from "./serializeScryfall";

const SCRYFALL_CACHE_PATH = join(PROJECT_ROOT, "cache", "scryfall.json");

export function loadScryfallCache(): Map<string, ScryCard> {
  const cache = loadCache(SCRYFALL_CACHE_PATH);

  // Index DFCs by front-face name so pool.csv lookups succeed
  // (pool.csv uses "Fable of the Mirror-Breaker", cache key is "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")
  const dfcEntries: [string, ScryCard][] = [];
  for (const [key, value] of cache) {
    const frontFace = getFrontFace(key);
    if (frontFace) {
      dfcEntries.push([frontFace, value]);
    }
  }
  for (const [key, value] of dfcEntries) {
    cache.set(key, value);
  }

  return cache;
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
    const scryfallData = scryfallCache.get(name.toLowerCase()) || scryfallCache.get(name);

    if (scryfallData) {
      const scryfallJson = serializeScryfallEntry(scryfallData);

      await client.execute({
        sql: "UPDATE cards SET scryfall_json = ? WHERE card_id = ?",
        args: [scryfallJson, cardId],
      });
      updatedCount++;
    }
  }

  return updatedCount;
}
