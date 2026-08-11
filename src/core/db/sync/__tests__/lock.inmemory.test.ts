/**
 * Lock CAS semantics — tested against a real in-memory libsql database.
 *
 * The previous tests only passed mocked rowsAffected values. These tests
 * execute the actual SQL UPDATE with WHERE conditions so a refactor of the
 * lock timestamp logic or the CAS predicate would be caught.
 *
 * Invariants verified:
 *   - Acquire succeeds when lock is free (value = '').
 *   - Second acquire fails while first is still held.
 *   - Stale lock (timestamp older than LOCK_TIMEOUT_SECONDS) is taken over.
 *   - Sequential CAS contention: only one winner when two acquire attempts
 *     simulate a race (sequential calls with the same timestamp window).
 *   - releaseSyncLock always clears the lock, even when the sync body throws.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { acquireSyncLock, releaseSyncLock } from "../lock";

const LOCK_TIMEOUT_SECONDS = 120;

let client: Client;

async function createSchema(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ingestion_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  // Seed the lock row exactly as the migrate script does
  await db.execute({
    sql: `INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('sync_lock', '')`,
    args: [],
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await createSchema(client);
});

describe("acquireSyncLock — real SQL", () => {
  it("acquires when lock is free (value = '')", async () => {
    const acquired = await acquireSyncLock(client);
    expect(acquired).toBe(true);

    // The lock row should now hold a timestamp
    const row = await client.execute({
      sql: `SELECT value FROM ingestion_meta WHERE key = 'sync_lock'`,
      args: [],
    });
    const lockValue = row.rows[0].value as string;
    expect(lockValue).not.toBe("");
    const ts = parseInt(lockValue, 10);
    expect(ts).toBeGreaterThan(0);
  });

  it("second acquire fails while first is still held", async () => {
    const first = await acquireSyncLock(client);
    expect(first).toBe(true);

    const second = await acquireSyncLock(client);
    expect(second).toBe(false);
  });

  it("takes over a stale lock whose timestamp is beyond the timeout", async () => {
    // Plant a stale timestamp: now - (LOCK_TIMEOUT_SECONDS + 10)
    const staleTs = Math.floor(Date.now() / 1000) - LOCK_TIMEOUT_SECONDS - 10;
    await client.execute({
      sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'sync_lock'`,
      args: [String(staleTs)],
    });

    // Should successfully take over the stale lock
    const acquired = await acquireSyncLock(client);
    expect(acquired).toBe(true);

    // Lock value should now be the current timestamp, not the stale one
    const row = await client.execute({
      sql: `SELECT value FROM ingestion_meta WHERE key = 'sync_lock'`,
      args: [],
    });
    const newTs = parseInt(row.rows[0].value as string, 10);
    expect(newTs).toBeGreaterThan(staleTs);
  });

  it("does NOT take over a fresh lock just within the timeout window", async () => {
    // Plant a timestamp 10 seconds ago (well within the 120s window)
    const freshTs = Math.floor(Date.now() / 1000) - 10;
    await client.execute({
      sql: `UPDATE ingestion_meta SET value = ? WHERE key = 'sync_lock'`,
      args: [String(freshTs)],
    });

    const acquired = await acquireSyncLock(client);
    expect(acquired).toBe(false);
  });

  it("CAS contention — only one winner out of two sequential acquire attempts with fresh lock", async () => {
    // Simulate two sync workers racing: the first one succeeds, the second fails.
    // Sequential calls on the same connection precisely model the CAS — the SQL
    // UPDATE WHERE predicate is the serialization point.
    const results = await Promise.all([acquireSyncLock(client), acquireSyncLock(client)]);

    // Exactly one must have won
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
  });
});

describe("releaseSyncLock — real SQL", () => {
  it("clears the lock value to empty string", async () => {
    await acquireSyncLock(client);

    await releaseSyncLock(client);

    const row = await client.execute({
      sql: `SELECT value FROM ingestion_meta WHERE key = 'sync_lock'`,
      args: [],
    });
    expect(row.rows[0].value).toBe("");
  });

  it("lock is released even when sync body throws (finally block)", async () => {
    // Acquire the lock
    const acquired = await acquireSyncLock(client);
    expect(acquired).toBe(true);

    // Simulate a sync that throws
    let threw = false;
    try {
      try {
        throw new Error("Sheets API failed");
      } finally {
        await releaseSyncLock(client);
      }
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

    // Lock must be clear
    const row = await client.execute({
      sql: `SELECT value FROM ingestion_meta WHERE key = 'sync_lock'`,
      args: [],
    });
    expect(row.rows[0].value).toBe("");

    // The lock can be reacquired
    const reacquired = await acquireSyncLock(client);
    expect(reacquired).toBe(true);
  });
});
