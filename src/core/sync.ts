/**
 * Shared sync module for incremental pick ingestion.
 * Used by both API routes (serverless) and CLI scripts.
 */

import type { Client } from "@libsql/client";
import type { CardPick } from "./types";
import type { ParsedPicks } from "./parseSheetRows";
import { normalizeCardName, getFrontFace } from "./cardNames";
import { fetchCard, fetchCardFuzzy } from "./scryfallApi";
import { sleep } from "./utils";
import { DEFAULT_NUM_SEATS } from "./constants";

/**
 * Given all picks parsed from CSV and the current max pick_n in the database,
 * return only the new picks that need to be inserted.
 */
export function detectNewPicks(
  allPicks: CardPick[],
  dbMaxPickN: number,
): CardPick[] {
  return allPicks.filter((pick) => pick.pickPosition > dbMaxPickN);
}

/**
 * Detect whether the CSV data has diverged from the database in a way
 * that requires a full reimport (only possible via CLI).
 *
 * Returns true if csvMaxPick < dbMaxPick (picks were removed/renumbered).
 */
export function detectDivergence(
  csvMaxPick: number,
  dbMaxPick: number,
): boolean {
  return csvMaxPick < dbMaxPick;
}

/**
 * Get the current max pick_n for a draft from the database.
 * Returns 0 if no picks exist.
 */
export async function getDbMaxPickN(
  client: Client,
  draftId: string,
): Promise<number> {
  const result = await client.execute({
    sql: "SELECT MAX(pick_n) as max_pick FROM pick_events WHERE draft_id = ?",
    args: [draftId],
  });
  return (result.rows[0]?.max_pick as number) ?? 0;
}

/**
 * Resolve a card name to its card_id in the cards table.
 * Returns null if not found (card wasn't in the initial full import).
 */
export async function resolveCardNameToId(
  client: Client,
  cardName: string,
): Promise<number | null> {
  const normalized = normalizeCardName(cardName);

  // 1. Exact match
  const result = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) = LOWER(?)",
    args: [normalized],
  });
  if (result.rows.length > 0) return result.rows[0].card_id as number;

  // 2. Front-face DFC match (name stored as "Front // Back")
  const dfcFrontResult = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) LIKE LOWER(? || ' // %')",
    args: [normalized],
  });
  if (dfcFrontResult.rows.length > 0) return dfcFrontResult.rows[0].card_id as number;

  // 3. Back-face DFC match
  const dfcBackResult = await client.execute({
    sql: "SELECT card_id FROM cards WHERE LOWER(name) LIKE LOWER('% // ' || ?)",
    args: [normalized],
  });
  if (dfcBackResult.rows.length > 0) return dfcBackResult.rows[0].card_id as number;

  // 4. Alias table lookup (diacritics, Omen Paths digital names)
  const aliasResult = await client.execute({
    sql: "SELECT card_id FROM card_aliases WHERE alias = LOWER(?)",
    args: [normalized],
  });
  if (aliasResult.rows.length > 0) return aliasResult.rows[0].card_id as number;

  // 5. Scryfall API fallback — auto-discover and cache as alias
  return resolveViaScryfall(client, normalized);
}

/** Rate limit delay between Scryfall API requests (ms) */
const SCRYFALL_RATE_LIMIT_MS = 75;

async function resolveViaScryfall(
  client: Client,
  cardName: string,
): Promise<number | null> {
  await sleep(SCRYFALL_RATE_LIMIT_MS);
  // Try exact match first, then fuzzy (handles Omen Paths digital names)
  const scryfallCard = await fetchCard(cardName) ?? await fetchCardFuzzy(cardName);
  if (!scryfallCard) return null;

  // Scryfall resolved the name — find the canonical card in our DB
  const scryfallName = scryfallCard.name;
  const frontFace = getFrontFace(scryfallName);
  const namesToTry = frontFace ? [scryfallName, frontFace] : [scryfallName];

  for (const name of namesToTry) {
    const match = await client.execute({
      sql: "SELECT card_id FROM cards WHERE LOWER(name) = LOWER(?)",
      args: [name],
    });
    if (match.rows.length > 0) {
      const cardId = match.rows[0].card_id as number;
      // Cache the alias for future lookups
      await client.execute({
        sql: "INSERT OR IGNORE INTO card_aliases (alias, card_id) VALUES (LOWER(?), ?)",
        args: [cardName, cardId],
      });
      console.log(`[alias] "${cardName}" → "${scryfallName}" (card_id: ${cardId})`);
      return cardId;
    }
  }

  return null;
}

/**
 * Insert new picks into pick_events for an active draft.
 * Resolves card names via the cards table (must already exist from initial import).
 * Returns the number of picks inserted.
 */
export async function insertNewPicks(
  client: Client,
  draftId: string,
  newPicks: CardPick[],
): Promise<number> {
  if (newPicks.length === 0) return 0;

  // Batch-resolve all card names in a single query
  const uniqueNames = [
    ...new Set(newPicks.map((p) => normalizeCardName(p.cardName))),
  ];
  const placeholders = uniqueNames.map(() => "?").join(", ");
  const result = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE LOWER(name) IN (${placeholders})`,
    args: uniqueNames.map((n) => n.toLowerCase()),
  });
  const nameToId = new Map<string, number>();
  for (const row of result.rows) {
    nameToId.set(
      (row.name as string).toLowerCase(),
      row.card_id as number,
    );
  }

  // Batch-insert picks using client.batch()
  const statements: Array<{
    sql: string;
    args: (string | number)[];
  }> = [];
  for (const pick of newPicks) {
    const normalized = normalizeCardName(pick.cardName).toLowerCase();
    const cardId = nameToId.get(normalized);
    if (cardId === undefined) {
      console.warn(
        `[sync] Warning: Card "${pick.cardName}" not found in cards table for draft ${draftId}, skipping pick ${pick.pickPosition}`,
      );
      continue;
    }
    // pick.seat is 0-indexed from parseDraftPicks, convert to 1-indexed
    statements.push({
      sql: "INSERT OR IGNORE INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
      args: [draftId, pick.pickPosition, pick.seat + 1, cardId],
    });
  }

  if (statements.length > 0) {
    await client.batch(statements);
  }

  return statements.length;
}

/**
 * Mark a draft as complete in the database.
 */
export async function markDraftComplete(
  client: Client,
  draftId: string,
): Promise<void> {
  await client.execute({
    sql: "UPDATE drafts SET phase = 'complete' WHERE draft_id = ?",
    args: [draftId],
  });
}

/**
 * Run the incremental ingestion path for a single active draft.
 * Returns a status indicating what happened.
 */
export async function incrementalIngest(
  client: Client,
  draftId: string,
  parsedPicks: ParsedPicks,
): Promise<{
  status: "no_change" | "updated" | "completed" | "diverged";
  picksInserted: number;
}> {
  const { picks, isComplete } = parsedPicks;
  if (picks.length === 0) {
    return { status: "no_change", picksInserted: 0 };
  }

  const csvMaxPick = Math.max(...picks.map((p) => p.pickPosition));
  const dbMaxPick = await getDbMaxPickN(client, draftId);

  // Check for divergence (picks removed or renumbered)
  if (detectDivergence(csvMaxPick, dbMaxPick)) {
    console.warn(
      `[sync] Divergence detected for draft ${draftId}: CSV max pick ${csvMaxPick} < DB max pick ${dbMaxPick}. Skipping — run pnpm sync to resolve.`,
    );
    return { status: "diverged", picksInserted: 0 };
  }

  // Find and insert new picks
  const newPicks = detectNewPicks(picks, dbMaxPick);
  if (newPicks.length === 0) {
    return { status: "no_change", picksInserted: 0 };
  }

  const insertedCount = await insertNewPicks(client, draftId, newPicks);
  console.log(`[sync] Inserted ${insertedCount} new picks for draft ${draftId}`);

  // Check if draft just completed
  if (isComplete) {
    await markDraftComplete(client, draftId);
    console.log(`[sync] Draft ${draftId} marked as complete`);
    return { status: "completed", picksInserted: insertedCount };
  }

  return { status: "updated", picksInserted: insertedCount };
}

// --- Lock management, rate limiting, and active draft queries ---

const LOCK_TIMEOUT_SECONDS = 120; // 2 minutes stale-lock timeout
const RATE_LIMIT_SECONDS = 30;

/**
 * Attempt to acquire the sync lock using compare-and-swap.
 * Returns true if lock was acquired, false if another sync is in progress.
 */
export async function acquireSyncLock(client: Client): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = now - LOCK_TIMEOUT_SECONDS;

  const result = await client.execute({
    sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'sync_lock' AND (value = '' OR CAST(value AS INTEGER) < ?)`,
    args: [String(now), threshold],
  });

  return result.rowsAffected > 0;
}

/**
 * Release the sync lock.
 */
export async function releaseSyncLock(client: Client): Promise<void> {
  await client.execute({
    sql: `UPDATE ingestion_meta SET value = '' WHERE key = 'sync_lock'`,
    args: [],
  });
}

/**
 * Update the last_synced_at timestamp.
 */
export async function updateLastSyncedAt(client: Client): Promise<string> {
  const now = String(Math.floor(Date.now() / 1000));
  await client.execute({
    sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'last_synced_at'`,
    args: [now],
  });
  return now;
}

/**
 * Get sync status from ingestion_meta.
 */
export async function getSyncStatus(client: Client): Promise<{
  lastSyncedAt: string;
  syncInProgress: boolean;
}> {
  const result = await client.execute({
    sql: `SELECT key, value FROM ingestion_meta WHERE key IN ('last_synced_at', 'sync_lock')`,
    args: [],
  });

  let lastSyncedAt = "0";
  let syncInProgress = false;
  const now = Math.floor(Date.now() / 1000);

  for (const row of result.rows) {
    if (row.key === "last_synced_at") {
      lastSyncedAt = row.value as string;
    }
    if (row.key === "sync_lock") {
      const lockValue = row.value as string;
      if (lockValue !== "") {
        const lockTime = parseInt(lockValue, 10);
        syncInProgress = now - lockTime < LOCK_TIMEOUT_SECONDS;
      }
    }
  }

  return { lastSyncedAt, syncInProgress };
}

/**
 * Check if a sync was performed recently (for rate limiting POST requests).
 */
export async function isRateLimited(client: Client): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT value FROM ingestion_meta WHERE key = 'last_synced_at'`,
    args: [],
  });
  if (result.rows.length === 0) return false;
  const lastSynced = parseInt(result.rows[0].value as string, 10);
  const now = Math.floor(Date.now() / 1000);
  return now - lastSynced < RATE_LIMIT_SECONDS;
}

/**
 * Get active draft IDs (phase != 'complete') with their sheet_ids.
 */
export async function getActiveDrafts(
  client: Client,
): Promise<Array<{ draftId: string; sheetId: string }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, sheet_id FROM drafts WHERE phase IN ('setup', 'drafting') AND sheet_id IS NOT NULL`,
    args: [],
  });
  return result.rows.map((row) => ({
    draftId: row.draft_id as string,
    sheetId: row.sheet_id as string,
  }));
}

/**
 * Get all active drafts with seat counts (including those without sheet_id).
 */
export async function getActiveDraftInfo(
  client: Client
): Promise<Array<{ id: string; numSeats: number }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, num_seats FROM drafts WHERE phase IN ('setup', 'drafting')`,
    args: [],
  });
  return result.rows.map((row) => ({
    id: row.draft_id as string,
    numSeats: (row.num_seats as number) || DEFAULT_NUM_SEATS,
  }));
}
