/**
 * Shared Scryfall serialization and card-resolution helpers.
 *
 * ScryCard (camelCase) is the in-memory representation used throughout the app.
 * The database stores Scryfall data as a JSON blob (scryfall_json) in snake_case
 * so it mirrors the Scryfall API response shape — making round-trips lossless.
 *
 * This module owns the single definition of that serialization so all ingestion
 * paths (sync/index.ts syncPool, ingest/scryfall.ts backfill, and the live-draft
 * scripts) produce identical JSON.
 */

import type { ScryCard } from "../../types";
import type { CardCache } from "../sync/card-cache";
import { cardNameKey } from "../../parseSheetRows";
import { generateOracleId } from "./utils";

/**
 * Serialize a ScryCard to the JSON string stored in the cards.scryfall_json
 * database column. The shape matches what parseScryfallJson / transformScryfallJson
 * expect when reading back out of the DB.
 */
export function serializeScryfallEntry(card: ScryCard): string {
  return JSON.stringify({
    name: card.name,
    color_identity: card.colorIdentity,
    colors: card.colors,
    type_line: card.typeLine,
    oracle_text: card.oracleText,
    mana_cost: card.manaCost,
    cmc: card.manaValue,
    image_uris: card.imageUri ? { normal: card.imageUri } : undefined,
  });
}

/**
 * Resolve a list of card names against the card cache, using the Scryfall
 * cache to populate scryfall_json for newly discovered cards.
 *
 * For each name not already in cardCache:
 *  - If found in scryfallCache: mark with serialized Scryfall data
 *  - Otherwise: mark as missing (scryfall_json = null, to be backfilled later)
 *
 * Does NOT flush to the database — call cardCache.flushMissing(client) after.
 */
export function resolveCardNamesToCache(
  cardNames: string[],
  cardCache: CardCache,
  scryfallCache: Map<string, ScryCard>,
): void {
  for (const name of cardNames) {
    if (cardCache.get(name) !== undefined) continue;

    const key = cardNameKey(name);
    const scryfallEntry = scryfallCache.get(key);
    const oracleId = generateOracleId(name);

    if (scryfallEntry) {
      cardCache.markMissing(name, oracleId, serializeScryfallEntry(scryfallEntry));
    } else {
      // Not in Scryfall cache — mark missing; scryfall_json will be backfilled
      cardCache.markMissing(name, oracleId, null);
    }
  }
}
