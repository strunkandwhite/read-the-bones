// scripts/draft-create-live.ts
//
// Create a new live (in-app) draft record in Turso.
// Usage: pnpm draft:create-live --name "Tarkir Rotisserie" --date 2026-04-01 --seats 10 --picks-per-player 45 --pool cubecobra:modern_cube_id [--banned-cards "Card A,Card B"]

import { createClient } from "@libsql/client";
import { loadEnv, generateOracleId, computeCubeHash } from "../src/core/db/ingest/utils";
import { loadCardPool } from "../src/core/cubecobra";
import { CardCache } from "../src/core/db/sync/card-cache";
import { batchInsertCubeSnapshotCards } from "../src/core/db/sync/batch";
import { generateSeatTokens } from "../src/core/db/queries/seatTokens";
import { loadScryfallCache } from "../src/core/db/ingest/scryfall";
import { cardNameKey } from "../src/core/parseSheetRows";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseArgs(args: string[]) {
  let name = "",
    date = "",
    pool = "",
    seats = 0,
    picksPerPlayer = 0,
    bannedCards: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--name":
        name = args[++i];
        break;
      case "--date":
        date = args[++i];
        break;
      case "--seats":
        seats = parseInt(args[++i], 10);
        break;
      case "--picks-per-player":
        picksPerPlayer = parseInt(args[++i], 10);
        break;
      case "--pool":
        pool = args[++i];
        break;
      case "--banned-cards":
        bannedCards = args[++i].split(",").map((s) => s.trim());
        break;
    }
  }

  if (!name) throw new Error("--name is required");
  if (!date) throw new Error("--date is required (YYYY-MM-DD)");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("--date must be in YYYY-MM-DD format");
  if (!seats || seats < 2) throw new Error("--seats is required (minimum 2)");
  if (!picksPerPlayer || picksPerPlayer < 1)
    throw new Error("--picks-per-player is required (minimum 1)");
  if (!pool) throw new Error("--pool is required (cubecobra:<id> or file:<path>)");

  return { name, date, seats, picksPerPlayer, pool, bannedCards };
}

async function main() {
  loadEnv();
  const { name, date, seats, picksPerPlayer, pool, bannedCards } = parseArgs(
    process.argv.slice(2),
  );
  const draftId = slugify(name);

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  // 1. Load card pool from CubeCobra or file
  console.log(`Loading card pool from ${pool}...`);
  const cardNames = await loadCardPool(pool);
  console.log(`  ${cardNames.length} cards in pool`);

  // 2. Resolve cards via CardCache + Scryfall cache
  const cardCache = new CardCache();
  await cardCache.loadAll(client);

  const scryfallCache = loadScryfallCache();

  // Count occurrences for qty
  const nameCounts = new Map<string, number>();
  for (const name of cardNames) {
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  const uniqueNames = Array.from(nameCounts.keys());

  // Resolve each unique card name
  for (const cardName of uniqueNames) {
    if (cardCache.get(cardName) !== undefined) continue;

    const key = cardNameKey(cardName);
    const scryfallEntry = scryfallCache.get(key);

    if (scryfallEntry) {
      const oracleId = generateOracleId(cardName);
      const scryfallJson = JSON.stringify({
        name: scryfallEntry.name,
        color_identity: scryfallEntry.colorIdentity,
        colors: scryfallEntry.colors,
        type_line: scryfallEntry.typeLine,
        oracle_text: scryfallEntry.oracleText,
        mana_cost: scryfallEntry.manaCost,
        cmc: scryfallEntry.manaValue,
        image_uris: scryfallEntry.imageUri
          ? { normal: scryfallEntry.imageUri }
          : undefined,
      });
      cardCache.markMissing(cardName, oracleId, scryfallJson);
    } else {
      const oracleId = generateOracleId(cardName);
      cardCache.markMissing(cardName, oracleId, null);
    }
  }

  await cardCache.flushMissing(client);
  console.log(`  ${cardCache.size} cards in cache after resolution`);

  // 3. Create cube snapshot
  const cubeHash = computeCubeHash(uniqueNames);
  const snapshotResult = await client.execute({
    sql: "INSERT OR IGNORE INTO cube_snapshots (cube_hash) VALUES (?)",
    args: [cubeHash],
  });

  let cubeSnapshotId: number;
  const isNewSnapshot = snapshotResult.rowsAffected > 0;
  if (isNewSnapshot) {
    cubeSnapshotId = Number(snapshotResult.lastInsertRowid);
  } else {
    const existing = await client.execute({
      sql: "SELECT cube_snapshot_id FROM cube_snapshots WHERE cube_hash = ?",
      args: [cubeHash],
    });
    cubeSnapshotId = existing.rows[0].cube_snapshot_id as number;
    console.log(`  Reusing existing cube snapshot ${cubeSnapshotId}`);
  }

  // Insert cube snapshot cards (skip if snapshot already exists with its cards)
  if (isNewSnapshot) {
    const cardEntries: Array<{ cardId: number; qty: number }> = [];
    for (const cardName of uniqueNames) {
      const cardId = cardCache.get(cardName);
      if (cardId !== undefined) {
        cardEntries.push({ cardId, qty: nameCounts.get(cardName) || 1 });
      }
    }
    await batchInsertCubeSnapshotCards(client, cubeSnapshotId, cardEntries);
  }

  // 4. Insert draft record
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, num_seats, phase, in_app, picks_per_player, banned_cards, import_hash)
          VALUES (?, ?, ?, ?, ?, 'setup', 1, ?, ?, '')`,
    args: [
      draftId,
      name,
      date,
      cubeSnapshotId,
      seats,
      picksPerPlayer,
      bannedCards.length > 0 ? JSON.stringify(bannedCards) : null,
    ],
  });

  console.log(`\nCreated live draft: ${draftId} (${name}, ${date})`);
  console.log(`  Seats: ${seats}, Picks per player: ${picksPerPlayer}`);
  if (bannedCards.length > 0) console.log(`  Banned: ${bannedCards.join(", ")}`);

  // 5. Generate seat tokens
  const tokens = await generateSeatTokens(client, draftId, seats);

  console.log(`\nSeat URLs:`);
  for (const { seat, token } of tokens) {
    console.log(`  Seat ${seat}: https://read-the-bones.vercel.app/drafts/${draftId}?token=${token}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
