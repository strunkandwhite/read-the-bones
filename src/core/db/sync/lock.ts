/**
 * Sync lock management and active-draft queries.
 *
 * The lock guards concurrent serverless cron executions — only one sync
 * runs at a time. updateLastSyncedAt tracks when the last successful sync
 * finished. getSyncStatus / getActiveDrafts / getActiveDraftInfo are the
 * read-side queries consumed by /api/sync and /api/sync-status.
 */

import type { Client } from "@libsql/client";
import { DEFAULT_NUM_SEATS } from "../../constants";
import { computeIngestionHash } from "./domains";

const LOCK_TIMEOUT_SECONDS = 120; // 2 minutes stale-lock timeout

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
 * Get the current ingestion hash from the drafts table.
 *
 * The hash is computed from pool/picks/matches hashes across all drafts — the
 * same computation used by getCards/getDraftStats. Clients use this as a ?v=
 * cache-buster when refetching /api/cards: they want the server's CURRENT hash
 * (the data they need), not their own stale hash (the data they already have).
 */
export async function getServerIngestionHash(client: Client): Promise<string> {
  const result = await client.execute({
    sql: `SELECT pool_hash, picks_hash, matches_hash FROM drafts`,
    args: [],
  });
  return computeIngestionHash(
    result.rows as unknown as Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
  );
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
 * Get active draft IDs (phase in setup/drafting/playing) with their sheet_ids.
 * Used by the cron sync route to determine which drafts to sync. 'playing'
 * drafts stay in the window so late match entry and post-hoc pick edits
 * keep syncing; completeAgedPlayingDrafts caps how long that lasts.
 */
export async function getActiveDrafts(
  client: Client,
): Promise<Array<{ draftId: string; sheetId: string }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, sheet_id FROM drafts WHERE phase IN ('setup', 'drafting', 'playing') AND sheet_id IS NOT NULL`,
    args: [],
  });
  return result.rows.map((row) => ({
    draftId: row.draft_id as string,
    sheetId: row.sheet_id as string,
  }));
}

/** How long a playing sheet draft keeps syncing before it is force-completed. */
const PLAYING_SYNC_WINDOW_DAYS = 60;

/**
 * Age backstop for the playing phase: pods that never record their full
 * round robin would otherwise sync forever. Only sheet drafts — live
 * (in-app) drafts manage their own lifecycle.
 */
export async function completeAgedPlayingDrafts(client: Client): Promise<number> {
  const result = await client.execute({
    sql: `UPDATE drafts SET phase = 'complete'
          WHERE phase = 'playing' AND sheet_id IS NOT NULL
            AND draft_date < date('now', ?)`,
    args: [`-${PLAYING_SYNC_WINDOW_DAYS} days`],
  });
  return result.rowsAffected;
}

/**
 * Get all active drafts with seat counts (including those without sheet_id).
 * Used by /api/sync-status to report live-draft info to the client.
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
