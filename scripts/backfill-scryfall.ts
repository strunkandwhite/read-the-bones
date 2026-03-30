/**
 * Fetch missing Scryfall data for cards in the database.
 * Queries Turso for cards with NULL scryfall_json, fetches from Scryfall API,
 * updates the local cache file, and backfills the database.
 *
 * Usage: pnpm scryfall:backfill
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { loadEnv } from "../src/core/db/ingest/utils";
loadEnv();
import { getClient } from "../src/core/db/client";
import { loadScryfallCache, backfillScryfallData } from "../src/core/db/ingest/scryfall";
import { fetchCard } from "../src/core/scryfallApi";
import type { ScryCard } from "../src/core/types";

const CACHE_PATH = join(process.cwd(), "cache", "scryfall.json");
const RATE_LIMIT_MS = 100;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const client = await getClient();

  // Find cards missing Scryfall data
  const result = await client.execute({
    sql: "SELECT card_id, name FROM cards WHERE scryfall_json IS NULL ORDER BY name",
    args: [],
  });
  const missing = result.rows.map((r) => ({ id: r.card_id as number, name: r.name as string }));
  console.log(`Found ${missing.length} cards missing Scryfall data.\n`);

  if (missing.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Load existing cache file
  const raw = JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as Record<string, ScryCard>;
  let fetched = 0;
  let failed = 0;

  // Fetch each from Scryfall API using shared transformApiResponse (handles DFCs)
  for (const { name } of missing) {
    process.stdout.write(`  Fetching: ${name}...`);
    const card = await fetchCard(name);
    if (card) {
      raw[card.name] = card;
      fetched++;
      console.log(` OK`);
    } else {
      failed++;
    }
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nFetched ${fetched} cards, ${failed} failed.\n`);

  // Save updated cache
  writeFileSync(CACHE_PATH, JSON.stringify(raw, null, 2), "utf-8");
  console.log(`Updated cache: ${CACHE_PATH}`);

  // Backfill Turso
  const scryfallCache = loadScryfallCache();
  const backfilled = await backfillScryfallData(client, scryfallCache);
  console.log(`Backfilled ${backfilled} cards in Turso.`);

  if (failed > 0) {
    console.warn(`\n⚠ ${failed} cards could not be found on Scryfall.`);
  }
}

main().catch(console.error);
