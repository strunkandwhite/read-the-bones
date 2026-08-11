/**
 * ensureCubeSnapshot machinery — in-memory libsql tests.
 *
 * Previous sync tests used pre-populated CardCaches and mocked execute calls,
 * so the ensureCubeSnapshot / consistency-check / qty-backfill / stale-snapshot
 * recreation paths had zero test coverage.
 *
 * These tests drive the real ensureCubeSnapshot function against an in-memory
 * libsql database so the SQL actually executes.
 *
 * Invariants verified:
 *   - New snapshot: creates cube_snapshots row + cube_snapshot_cards rows.
 *   - Existing consistent snapshot: returns same ID, no writes.
 *   - Qty backfill: existing snapshot with stale qty values gets updated.
 *   - Stale card_ids: snapshot with different card_id set is recreated.
 *   - CardCache.flushMissing: inserts missing cards and re-queries their IDs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { ensureCubeSnapshot } from "../../ingest/db-helpers";
import { CardCache } from "../card-cache";

let client: Client;

async function createSchema(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS cards (
      card_id INTEGER PRIMARY KEY,
      oracle_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scryfall_json TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS cube_snapshots (
      cube_snapshot_id INTEGER PRIMARY KEY,
      cube_hash TEXT NOT NULL UNIQUE
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS cube_snapshot_cards (
      cube_snapshot_id INTEGER NOT NULL REFERENCES cube_snapshots(cube_snapshot_id),
      card_id INTEGER NOT NULL REFERENCES cards(card_id),
      qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (cube_snapshot_id, card_id)
    )
  `);
}

/** Seed a card directly into the cards table and return its card_id. */
async function seedCard(db: Client, name: string): Promise<number> {
  const oracleId = `generated:${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO cards (oracle_id, name) VALUES (?, ?)`,
    args: [oracleId, name],
  });
  const row = await db.execute({
    sql: `SELECT card_id FROM cards WHERE name = ?`,
    args: [name],
  });
  return row.rows[0].card_id as number;
}

/** Read all cube_snapshot_cards for a given snapshot ID. */
async function getSnapshotCards(
  db: Client,
  snapshotId: number
): Promise<Array<{ card_id: number; qty: number }>> {
  const result = await db.execute({
    sql: `SELECT card_id, qty FROM cube_snapshot_cards WHERE cube_snapshot_id = ? ORDER BY card_id`,
    args: [snapshotId],
  });
  return result.rows.map((r) => ({
    card_id: r.card_id as number,
    qty: r.qty as number,
  }));
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await createSchema(client);
});

describe("ensureCubeSnapshot", () => {
  it("creates a new snapshot when none exists for the given hash", async () => {
    const boltId = await seedCard(client, "Lightning Bolt");
    const counterId = await seedCard(client, "Counterspell");

    const cardIds = new Map([
      ["Lightning Bolt", { cardId: boltId, qty: 1 }],
      ["Counterspell", { cardId: counterId, qty: 1 }],
    ]);

    const snapshotId = await ensureCubeSnapshot(client, "hash-abc", cardIds);
    expect(typeof snapshotId).toBe("number");
    expect(snapshotId).toBeGreaterThan(0);

    // Snapshot row must exist
    const snap = await client.execute({
      sql: `SELECT cube_hash FROM cube_snapshots WHERE cube_snapshot_id = ?`,
      args: [snapshotId],
    });
    expect(snap.rows[0].cube_hash).toBe("hash-abc");

    // Both cards must be in cube_snapshot_cards
    const cards = await getSnapshotCards(client, snapshotId);
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.card_id).sort()).toEqual([boltId, counterId].sort());
    expect(cards.every((c) => c.qty === 1)).toBe(true);
  });

  it("returns the same ID when snapshot already exists and is consistent", async () => {
    const boltId = await seedCard(client, "Lightning Bolt");
    const cardIds = new Map([["Lightning Bolt", { cardId: boltId, qty: 1 }]]);

    const firstId = await ensureCubeSnapshot(client, "hash-same", cardIds);
    const secondId = await ensureCubeSnapshot(client, "hash-same", cardIds);

    expect(secondId).toBe(firstId);

    // Only one snapshot row should exist
    const snaps = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM cube_snapshots WHERE cube_hash = 'hash-same'`,
      args: [],
    });
    expect(snaps.rows[0].cnt).toBe(1);
  });

  it("backfills stale qty values when card_ids match but qtys differ", async () => {
    const boltId = await seedCard(client, "Lightning Bolt");

    // Create snapshot with qty = 1
    const cardIds1 = new Map([["Lightning Bolt", { cardId: boltId, qty: 1 }]]);
    const snapshotId = await ensureCubeSnapshot(client, "hash-qty", cardIds1);

    // Now call with qty = 2 (multi-copy)
    const cardIds2 = new Map([["Lightning Bolt", { cardId: boltId, qty: 2 }]]);
    const sameId = await ensureCubeSnapshot(client, "hash-qty", cardIds2);

    expect(sameId).toBe(snapshotId);

    const cards = await getSnapshotCards(client, snapshotId);
    expect(cards).toHaveLength(1);
    // The qty should have been updated to 2
    expect(cards[0].qty).toBe(2);
  });

  it("recreates snapshot cards when card_id set changes (stale DFC resolution)", async () => {
    const boltId = await seedCard(client, "Lightning Bolt");
    const counterId = await seedCard(client, "Counterspell");

    // Initial snapshot with just Lightning Bolt
    const oldCardIds = new Map([["Lightning Bolt", { cardId: boltId, qty: 1 }]]);
    const snapshotId = await ensureCubeSnapshot(client, "hash-stale", oldCardIds);

    // Re-call with different card_id set (Counterspell replaces Bolt — simulates DFC fix)
    const newCardIds = new Map([["Counterspell", { cardId: counterId, qty: 1 }]]);
    const sameId = await ensureCubeSnapshot(client, "hash-stale", newCardIds);

    // Same snapshot ID — no new snapshot created
    expect(sameId).toBe(snapshotId);

    // Cards are now Counterspell only
    const cards = await getSnapshotCards(client, snapshotId);
    expect(cards).toHaveLength(1);
    expect(cards[0].card_id).toBe(counterId);
  });

  it("handles multi-copy cards with qty > 1 correctly", async () => {
    const boltId = await seedCard(client, "Lightning Bolt");

    const cardIds = new Map([["Lightning Bolt", { cardId: boltId, qty: 3 }]]);
    const snapshotId = await ensureCubeSnapshot(client, "hash-multi", cardIds);

    const cards = await getSnapshotCards(client, snapshotId);
    expect(cards[0].qty).toBe(3);
  });
});

describe("CardCache.flushMissing", () => {
  it("inserts missing cards and populates the cache with their new IDs", async () => {
    const cache = new CardCache();
    const oracleId = "generated:dark-ritual";

    // Mark a card as missing (not yet in DB)
    cache.markMissing("Dark Ritual", oracleId, null);

    await cache.flushMissing(client);

    // Card should now be in the DB
    const row = await client.execute({
      sql: `SELECT card_id, name FROM cards WHERE name = ?`,
      args: ["Dark Ritual"],
    });
    expect(row.rows).toHaveLength(1);
    const cardId = row.rows[0].card_id as number;

    // And the cache should be populated
    expect(cache.get("Dark Ritual")).toBe(cardId);
    expect(cache.get("dark ritual")).toBe(cardId); // case-insensitive
  });

  it("is idempotent — calling flushMissing twice does not insert duplicates", async () => {
    const cache = new CardCache();
    cache.markMissing("Swords to Plowshares", "generated:swords-to-plowshares", null);

    await cache.flushMissing(client);
    await cache.flushMissing(client); // second call is a no-op

    const rows = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM cards WHERE name = 'Swords to Plowshares'`,
      args: [],
    });
    expect(rows.rows[0].cnt).toBe(1);
  });

  it("does not flush cards that are already in the cache", async () => {
    const cache = new CardCache();
    // Preload an existing card
    await seedCard(client, "Force of Will");
    await cache.loadAll(client);

    // markMissing is a no-op for known cards
    cache.markMissing("Force of Will", "generated:force-of-will", null);
    await cache.flushMissing(client);

    // Still just one row
    const rows = await client.execute({
      sql: `SELECT COUNT(*) as cnt FROM cards WHERE name = 'Force of Will'`,
      args: [],
    });
    expect(rows.rows[0].cnt).toBe(1);
  });
});
