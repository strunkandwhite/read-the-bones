/**
 * Data ingestion script.
 * Reads CSVs from data/<draft-name>/ directories and populates the Turso database.
 *
 * Usage:
 *   pnpm ingest              # Ingest all drafts from data/
 *   pnpm ingest tarkir       # Ingest specific draft
 *
 * Requires environment variables:
 *   TURSO_DATABASE_URL - libsql://your-database.turso.io
 *   TURSO_AUTH_TOKEN - your-auth-token
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { createClient, type Client } from "@libsql/client";
import dotenv from "dotenv";

import {
  parseDraftPicks,
  parsePool,
  normalizeCardName,
} from "../parseCsv";
import { parseMatches } from "../parseMatches";
import type { ScryCard } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const OPT_OUTS_PATH = join(PROJECT_ROOT, ".opt-outs.json");

// ============================================================================
// Types
// ============================================================================

interface DraftMetadata {
  name: string;
  date: string;
  sheetId?: string;
  status?: string;
}

interface DraftFolder {
  draftId: string;
  path: string;
  hasPicksCsv: boolean;
  hasPoolCsv: boolean;
  hasMatchesCsv: boolean;
  hasMetadata: boolean;
}

interface CardInPool {
  name: string;
  oracleId: string;
  scryfallJson: string | null;
}

// ============================================================================
// Environment Setup
// ============================================================================

function loadEnv(): void {
  dotenv.config({ path: join(PROJECT_ROOT, ".env.local") });
  dotenv.config({ path: join(PROJECT_ROOT, ".env") });
}

// ============================================================================
// Utilities
// ============================================================================

function log(message: string): void {
  console.log(`[ingest] ${message}`);
}

function logIndent(message: string): void {
  console.log(`  - ${message}`);
}

/**
 * Generate a stable oracle_id from a card name.
 *
 * NOTE: The Scryfall cache (cache/scryfall.json) does not contain the actual
 * Scryfall oracle_id field. Instead, we generate a deterministic ID based on
 * the card name. This means our oracle_id values are NOT compatible with
 * Scryfall's oracle_id values, but they serve the same purpose within our
 * system: providing a stable identifier for card equivalence across drafts.
 *
 * Format: "generated:<normalized-name>" where normalized-name is lowercase
 * with non-alphanumeric characters replaced by hyphens.
 */
function generateOracleId(cardName: string): string {
  const normalized = cardName.toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `generated:${normalized}`;
}

/**
 * Compute SHA256 hash of file contents.
 */
function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute import hash from picks.csv, pool.csv, and matches.csv.
 */
function computeImportHash(draftPath: string): string {
  const picksHash = hashFile(join(draftPath, "picks.csv"));
  const poolHash = hashFile(join(draftPath, "pool.csv"));
  const matchesHash = hashFile(join(draftPath, "matches.csv"));
  const combined = `${picksHash}:${poolHash}:${matchesHash}`;
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

/**
 * Compute cube hash from sorted card names.
 */
function computeCubeHash(cardNames: string[]): string {
  const sorted = [...cardNames].sort();
  const combined = sorted.join("\n");
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

// ============================================================================
// Opt-Outs
// ============================================================================

/**
 * Load opt-out player names from .opt-outs.json if it exists.
 * Returns a Set of player names (case-insensitive matching).
 */
function loadOptOuts(): Set<string> {
  if (!existsSync(OPT_OUTS_PATH)) {
    return new Set();
  }

  try {
    const content = readFileSync(OPT_OUTS_PATH, "utf-8");
    const names = JSON.parse(content) as string[];
    // Store lowercase for case-insensitive matching
    return new Set(names.map((name) => name.toLowerCase()));
  } catch (error) {
    log(`Warning: Failed to parse .opt-outs.json: ${error}`);
    return new Set();
  }
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Scan data/ directory for draft folders with required files.
 */
function discoverDrafts(dataDir: string, filterDraftId?: string): DraftFolder[] {
  const drafts: DraftFolder[] = [];

  if (!existsSync(dataDir)) {
    return drafts;
  }

  const entries = readdirSync(dataDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Skip hidden directories
    if (entry.name.startsWith(".")) continue;

    // Skip if filtering and this isn't the target draft
    if (filterDraftId && entry.name !== filterDraftId) continue;

    const draftPath = join(dataDir, entry.name);

    const draft: DraftFolder = {
      draftId: entry.name,
      path: draftPath,
      hasPicksCsv: existsSync(join(draftPath, "picks.csv")),
      hasPoolCsv: existsSync(join(draftPath, "pool.csv")),
      hasMatchesCsv: existsSync(join(draftPath, "matches.csv")),
      hasMetadata: existsSync(join(draftPath, "metadata.json")),
    };

    // Only include drafts with both picks.csv and pool.csv
    if (draft.hasPicksCsv && draft.hasPoolCsv) {
      drafts.push(draft);
    }
  }

  return drafts.sort((a, b) => a.draftId.localeCompare(b.draftId));
}

// ============================================================================
// Scryfall Cache
// ============================================================================

/**
 * Load Scryfall cache from cache/scryfall.json.
 */
function loadScryfallCache(): Map<string, ScryCard> {
  const cachePath = join(PROJECT_ROOT, "cache", "scryfall.json");

  if (!existsSync(cachePath)) {
    log("Warning: Scryfall cache not found at cache/scryfall.json");
    return new Map();
  }

  try {
    const content = readFileSync(cachePath, "utf-8");
    const data = JSON.parse(content) as Record<string, ScryCard>;
    const cache = new Map<string, ScryCard>();

    for (const [key, value] of Object.entries(data)) {
      // Index by both the key and the full name (for double-faced cards)
      cache.set(key.toLowerCase(), value);
      if (value.name && value.name.toLowerCase() !== key.toLowerCase()) {
        cache.set(value.name.toLowerCase(), value);
      }
    }

    return cache;
  } catch (error) {
    log(`Warning: Failed to parse Scryfall cache: ${error}`);
    return new Map();
  }
}

// ============================================================================
// Database Operations
// ============================================================================

/**
 * Check if a draft exists and return its import hash.
 */
async function getDraftImportHash(
  client: Client,
  draftId: string
): Promise<string | null> {
  const result = await client.execute({
    sql: "SELECT import_hash FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0].import_hash as string;
}

/**
 * Delete a draft and all related data.
 */
async function deleteDraft(client: Client, draftId: string): Promise<void> {
  // Delete in order respecting foreign key constraints
  await client.execute({
    sql: "DELETE FROM match_events WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  await client.execute({
    sql: "DELETE FROM drafts WHERE draft_id = ?",
    args: [draftId],
  });
}

/**
 * Ensure a card exists in the cards table, return card_id.
 */
async function ensureCard(
  client: Client,
  oracleId: string,
  name: string,
  scryfallJson: string | null
): Promise<number> {
  // Try to find existing card by oracle_id
  const existing = await client.execute({
    sql: "SELECT card_id, scryfall_json FROM cards WHERE oracle_id = ?",
    args: [oracleId],
  });

  if (existing.rows.length > 0) {
    const cardId = existing.rows[0].card_id as number;
    const existingJson = existing.rows[0].scryfall_json as string | null;

    // Update scryfall_json if we have new data but the existing record is missing it
    if (scryfallJson && !existingJson) {
      await client.execute({
        sql: "UPDATE cards SET scryfall_json = ? WHERE card_id = ?",
        args: [scryfallJson, cardId],
      });
    }

    return cardId;
  }

  // Insert new card
  const result = await client.execute({
    sql: "INSERT INTO cards (oracle_id, name, scryfall_json) VALUES (?, ?, ?)",
    args: [oracleId, name, scryfallJson],
  });

  return Number(result.lastInsertRowid);
}

/**
 * Backfill scryfall_json for cards that are missing it.
 * This handles cases where cards were ingested before the Scryfall cache was available.
 */
async function backfillScryfallData(
  client: Client,
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

/**
 * Get or create a cube snapshot, return cube_snapshot_id.
 */
async function ensureCubeSnapshot(
  client: Client,
  cubeHash: string,
  cardIds: Map<string, { cardId: number; qty: number }>
): Promise<number> {
  // Check if cube snapshot already exists
  const existing = await client.execute({
    sql: "SELECT cube_snapshot_id FROM cube_snapshots WHERE cube_hash = ?",
    args: [cubeHash],
  });

  if (existing.rows.length > 0) {
    return existing.rows[0].cube_snapshot_id as number;
  }

  // Create new cube snapshot
  const result = await client.execute({
    sql: "INSERT INTO cube_snapshots (cube_hash) VALUES (?)",
    args: [cubeHash],
  });

  const cubeSnapshotId = Number(result.lastInsertRowid);

  // Insert cube_snapshot_cards
  for (const [, { cardId, qty }] of cardIds) {
    await client.execute({
      sql: "INSERT INTO cube_snapshot_cards (cube_snapshot_id, card_id, qty) VALUES (?, ?, ?)",
      args: [cubeSnapshotId, cardId, qty],
    });
  }

  return cubeSnapshotId;
}

/**
 * Create a draft record.
 */
async function createDraft(
  client: Client,
  draftId: string,
  draftName: string,
  draftDate: string,
  cubeSnapshotId: number,
  importHash: string,
  numSeats: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, cube_snapshot_id, import_hash, num_seats)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [draftId, draftName, draftDate, cubeSnapshotId, importHash, numSeats],
  });
}

/**
 * Insert a pick event.
 */
async function insertPickEvent(
  client: Client,
  draftId: string,
  pickN: number,
  seat: number,
  cardId: number
): Promise<void> {
  await client.execute({
    sql: "INSERT INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
    args: [draftId, pickN, seat, cardId],
  });
}

/**
 * Insert a match event.
 */
async function insertMatchEvent(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins)
          VALUES (?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins],
  });
}

/**
 * Insert opt-out records for players who have opted out.
 * Matches drafter names against the opt-out list (case-insensitive).
 */
async function insertOptOuts(
  client: Client,
  draftId: string,
  drafterNames: string[],
  optOutNames: Set<string>
): Promise<number> {
  let count = 0;

  for (let i = 0; i < drafterNames.length; i++) {
    const name = drafterNames[i];
    if (optOutNames.has(name.toLowerCase())) {
      const seat = i + 1; // Convert to 1-indexed
      await client.execute({
        sql: "INSERT OR IGNORE INTO llm_opt_outs (draft_id, seat) VALUES (?, ?)",
        args: [draftId, seat],
      });
      count++;
    }
  }

  return count;
}

// ============================================================================
// Main Ingestion Logic
// ============================================================================

/**
 * Process a single draft folder.
 */
async function processDraft(
  client: Client,
  draft: DraftFolder,
  scryfallCache: Map<string, ScryCard>,
  optOutNames: Set<string>
): Promise<{ imported: boolean; skipped: boolean; error?: string }> {
  const { draftId, path: draftPath } = draft;

  // Compute import hash
  const importHash = computeImportHash(draftPath);

  // Check if draft exists with same hash
  const existingHash = await getDraftImportHash(client, draftId);

  if (existingHash === importHash) {
    logIndent(`Skipped (unchanged, hash: ${importHash})`);
    return { imported: false, skipped: true };
  }

  // Delete existing draft if hash changed
  if (existingHash !== null) {
    logIndent(`Reimporting (hash changed: ${existingHash} -> ${importHash})`);
    await deleteDraft(client, draftId);
  }

  // Note: We don't use explicit transactions because libsql HTTP client
  // doesn't maintain transaction state across separate execute() calls.
  // If ingestion fails partway through, re-run after fixing the issue.
  return await processDraftInner(client, draft, scryfallCache, importHash, optOutNames);
}

/**
 * Inner function that processes draft data.
 * Called by processDraft after checking for existing data.
 */
async function processDraftInner(
  client: Client,
  draft: DraftFolder,
  scryfallCache: Map<string, ScryCard>,
  importHash: string,
  optOutNames: Set<string>
): Promise<{ imported: boolean; skipped: boolean; error?: string }> {
  const { draftId, path: draftPath } = draft;

  // Load metadata
  let metadata: DraftMetadata = {
    name: draftId,
    date: new Date().toISOString().split("T")[0],
  };

  if (draft.hasMetadata) {
    try {
      const metadataContent = readFileSync(
        join(draftPath, "metadata.json"),
        "utf-8"
      );
      metadata = JSON.parse(metadataContent) as DraftMetadata;
    } catch (error) {
      log(`Warning: Failed to parse metadata.json: ${error}`);
    }
  }

  // Load pool.csv
  const poolCsv = readFileSync(join(draftPath, "pool.csv"), "utf-8");
  const poolCardNames = parsePool(poolCsv);

  if (poolCardNames.length === 0) {
    return { imported: false, skipped: false, error: "Empty pool" };
  }

  // Resolve cards from pool
  const cardNameCounts = new Map<string, number>();
  for (const cardName of poolCardNames) {
    const normalized = normalizeCardName(cardName);
    cardNameCounts.set(normalized, (cardNameCounts.get(normalized) || 0) + 1);
  }

  // Map card names to card info (oracleId, cardId, qty)
  const poolCards: CardInPool[] = [];
  const cardNameToId = new Map<string, number>();

  for (const [cardName] of cardNameCounts) {
    const scryfallData = scryfallCache.get(cardName.toLowerCase());

    let oracleId: string;
    let scryfallJson: string | null = null;
    let displayName = cardName;

    if (scryfallData) {
      // Generate oracle_id from card name (Scryfall cache doesn't have oracle_id)
      oracleId = generateOracleId(scryfallData.name);
      displayName = scryfallData.name;
      // Store full Scryfall data as JSON
      scryfallJson = JSON.stringify({
        name: scryfallData.name,
        color_identity: scryfallData.colorIdentity,
        colors: scryfallData.colors,
        type_line: scryfallData.typeLine,
        oracle_text: scryfallData.oracleText,
        mana_cost: scryfallData.manaCost,
        cmc: scryfallData.manaValue,
        image_uris: scryfallData.imageUri ? { normal: scryfallData.imageUri } : undefined,
      });
    } else {
      oracleId = generateOracleId(cardName);
      log(`Warning: Card not in Scryfall cache: "${cardName}"`);
    }

    const cardId = await ensureCard(client, oracleId, displayName, scryfallJson);
    cardNameToId.set(cardName.toLowerCase(), cardId);

    poolCards.push({
      name: displayName,
      oracleId,
      scryfallJson,
    });
  }

  // Build cube snapshot
  const cubeHash = computeCubeHash(poolCardNames);
  const cardIdsForSnapshot = new Map<
    string,
    { cardId: number; qty: number }
  >();

  for (const [cardName, qty] of cardNameCounts) {
    const cardId = cardNameToId.get(cardName.toLowerCase())!;
    cardIdsForSnapshot.set(cardName, { cardId, qty });
  }

  const cubeSnapshotId = await ensureCubeSnapshot(
    client,
    cubeHash,
    cardIdsForSnapshot
  );

  // Load picks.csv
  const picksCsv = readFileSync(join(draftPath, "picks.csv"), "utf-8");
  const { picks, drafterNames } = parseDraftPicks(picksCsv, draftId);

  if (picks.length === 0) {
    return { imported: false, skipped: false, error: "No picks found" };
  }

  // Number of seats = number of unique drafter columns
  const numSeats = drafterNames.length;

  // Create draft with num_seats
  await createDraft(
    client,
    draftId,
    metadata.name,
    metadata.date,
    cubeSnapshotId,
    importHash,
    numSeats
  );

  // Validate and insert picks
  // Sort by pick position for contiguity check
  const sortedPicks = [...picks].sort(
    (a, b) => a.pickPosition - b.pickPosition
  );

  // Build map of pick positions for gap detection
  const pickPositions = new Set<number>();
  for (const pick of sortedPicks) {
    pickPositions.add(pick.pickPosition);
  }

  // Check for gaps in picks (warn but continue)
  const maxPick = Math.max(...pickPositions);
  const missingPicks: number[] = [];
  for (let i = 1; i <= maxPick; i++) {
    if (!pickPositions.has(i)) {
      missingPicks.push(i);
    }
  }
  if (missingPicks.length > 0) {
    logIndent(
      `Warning: ${missingPicks.length} missing pick(s): ${missingPicks.slice(0, 5).join(", ")}${missingPicks.length > 5 ? "..." : ""}`
    );
  }

  // Insert pick events with seat (1-indexed)
  for (const pick of sortedPicks) {
    const normalizedName = normalizeCardName(pick.cardName);
    const cardId = cardNameToId.get(normalizedName.toLowerCase());

    if (!cardId) {
      return {
        imported: false,
        skipped: false,
        error: `Pick ${pick.pickPosition} references "${pick.cardName}" - no matching card in cube`,
      };
    }

    // pick.seat is 0-indexed from parseDraftPicks, convert to 1-indexed
    const seat = pick.seat + 1;
    await insertPickEvent(client, draftId, pick.pickPosition, seat, cardId);
  }

  // Process matches if available
  let matchCount = 0;

  if (draft.hasMatchesCsv) {
    const matchesCsv = readFileSync(join(draftPath, "matches.csv"), "utf-8");

    // Build a map from player names to seat numbers (0-indexed for parseMatches)
    const playerNameToSeat = new Map<string, number>();
    for (let seat = 0; seat < drafterNames.length; seat++) {
      const name = drafterNames[seat];
      playerNameToSeat.set(name, seat);
      playerNameToSeat.set(name.toLowerCase(), seat);
    }

    // Parse matches - returns seat-based match results (0-indexed)
    const matches = parseMatches(matchesCsv, playerNameToSeat);

    // Insert matches with seats (convert to 1-indexed)
    for (const match of matches) {
      // Convert from 0-indexed to 1-indexed seats
      const seat1 = match.seat1 + 1;
      const seat2 = match.seat2 + 1;

      if (seat1 < 1 || seat1 > numSeats) {
        return {
          imported: false,
          skipped: false,
          error: `Match references invalid seat ${seat1}`,
        };
      }

      if (seat2 < 1 || seat2 > numSeats) {
        return {
          imported: false,
          skipped: false,
          error: `Match references invalid seat ${seat2}`,
        };
      }

      await insertMatchEvent(
        client,
        draftId,
        seat1,
        seat2,
        match.seat1GamesWon,
        match.seat2GamesWon
      );
      matchCount++;
    }
  }

  // Process opt-outs
  let optOutCount = 0;
  if (optOutNames.size > 0) {
    optOutCount = await insertOptOuts(client, draftId, drafterNames, optOutNames);
  }

  // Log summary
  logIndent(`${cardNameCounts.size} cards in pool`);
  logIndent(`${numSeats} seats`);
  logIndent(`${picks.length} picks`);
  if (matchCount > 0) {
    logIndent(`${matchCount} matches`);
  }
  if (optOutCount > 0) {
    logIndent(`${optOutCount} opt-out(s)`);
  }
  logIndent(`Done (import_hash: ${importHash})`);

  return { imported: true, skipped: false };
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  loadEnv();

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    console.error("[ingest] Error: TURSO_DATABASE_URL not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  if (!authToken) {
    console.error("[ingest] Error: TURSO_AUTH_TOKEN not set");
    console.error("  Set it in .env.local or as an environment variable");
    process.exit(1);
  }

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const filterDraftId = args.length > 0 ? args[0] : undefined;

  // Discover drafts
  log("Discovering drafts...");
  const dataDir = join(PROJECT_ROOT, "data");
  const drafts = discoverDrafts(dataDir, filterDraftId);

  if (drafts.length === 0) {
    if (filterDraftId) {
      console.error(`[ingest] Error: Draft "${filterDraftId}" not found`);
      console.error(
        `  Make sure data/${filterDraftId}/ exists with picks.csv and pool.csv`
      );
    } else {
      console.error("[ingest] Error: No drafts found in data/");
    }
    process.exit(1);
  }

  log(`Found ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`);
  console.log();

  // Load Scryfall cache
  const scryfallCache = loadScryfallCache();
  log(`Loaded Scryfall cache with ${scryfallCache.size} cards`);

  // Load opt-outs
  const optOutNames = loadOptOuts();
  if (optOutNames.size > 0) {
    log(`Loaded ${optOutNames.size} opt-out name(s)`);
  }
  console.log();

  // Connect to database
  const client = createClient({ url, authToken });

  // Enable foreign key enforcement
  await client.execute("PRAGMA foreign_keys = ON");

  let importedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  try {
    for (const draft of drafts) {
      log(`Processing ${draft.draftId}...`);

      try {
        const result = await processDraft(client, draft, scryfallCache, optOutNames);

        if (result.error) {
          console.error(`  Error: ${result.error}`);
          errorCount++;
        } else if (result.imported) {
          importedCount++;
        } else if (result.skipped) {
          skippedCount++;
        }
      } catch (error) {
        console.error(`  Error: ${error}`);
        errorCount++;
      }

      console.log();
    }

    // Backfill scryfall_json for cards that are missing it
    const backfillCount = await backfillScryfallData(client, scryfallCache);
    if (backfillCount > 0) {
      log(`Backfilled Scryfall data for ${backfillCount} cards`);
    }

    // Final summary
    log(
      `Complete: ${importedCount} imported, ${skippedCount} skipped${errorCount > 0 ? `, ${errorCount} errors` : ""}${backfillCount > 0 ? `, ${backfillCount} backfilled` : ""}`
    );
  } finally {
    client.close();
  }

  if (errorCount > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("[ingest] Fatal error:", error);
  process.exit(1);
});
