/**
 * Shared in-memory database helpers for query-layer integration tests.
 *
 * Provides a single source of truth for schema creation and common seed
 * helpers so each test file doesn't re-derive the same DDL. Import what
 * you need — helpers are individually exported to keep test files lean.
 */

import { createClient, type Client } from "@libsql/client";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function createTestSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS cards (
      card_id INTEGER PRIMARY KEY,
      oracle_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scryfall_json TEXT
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS cube_snapshots (
      cube_snapshot_id INTEGER PRIMARY KEY,
      cube_hash TEXT NOT NULL UNIQUE
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS cube_snapshot_cards (
      cube_snapshot_id INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (cube_snapshot_id, card_id)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id TEXT PRIMARY KEY,
      draft_name TEXT NOT NULL DEFAULT '',
      draft_date TEXT NOT NULL DEFAULT '',
      cube_snapshot_id INTEGER NOT NULL DEFAULT 0,
      pool_hash TEXT,
      picks_hash TEXT,
      matches_hash TEXT,
      num_seats INTEGER NOT NULL DEFAULT 10,
      phase TEXT NOT NULL DEFAULT 'complete',
      in_app INTEGER NOT NULL DEFAULT 0,
      banned_cards TEXT
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS pick_events (
      draft_id TEXT NOT NULL,
      pick_n INTEGER NOT NULL,
      seat INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      PRIMARY KEY (draft_id, pick_n)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS match_events (
      draft_id TEXT NOT NULL,
      seat1 INTEGER NOT NULL,
      seat2 INTEGER NOT NULL,
      seat1_wins INTEGER NOT NULL,
      seat2_wins INTEGER NOT NULL,
      PRIMARY KEY (draft_id, seat1, seat2)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      zone TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (draft_id, seat, card_id, zone)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS privacy_opt_outs (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      PRIMARY KEY (draft_id, seat)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS seat_tokens (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      display_name TEXT,
      auto_pick INTEGER NOT NULL DEFAULT 1,
      queue_json TEXT,
      PRIMARY KEY (draft_id, seat)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS floated_cards (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      card_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (draft_id, seat, card_name)
    )
  `);
}

/**
 * Create a fresh in-memory client with the full test schema applied.
 */
export async function createMemDb(): Promise<Client> {
  const client = createClient({ url: ":memory:" });
  await createTestSchema(client);
  return client;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

export async function insertCard(
  client: Client,
  cardId: number,
  name: string,
  opts: { scryfallJson?: object } = {}
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cards (card_id, oracle_id, name, scryfall_json) VALUES (?, ?, ?, ?)`,
    args: [cardId, `oracle-${cardId}`, name, opts.scryfallJson ? JSON.stringify(opts.scryfallJson) : null],
  });
}

export async function insertCubeSnapshot(
  client: Client,
  snapshotId: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cube_snapshots (cube_snapshot_id, cube_hash) VALUES (?, ?)`,
    args: [snapshotId, `hash-${snapshotId}`],
  });
}

export async function insertCubeCard(
  client: Client,
  snapshotId: number,
  cardId: number,
  qty = 1
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO cube_snapshot_cards (cube_snapshot_id, card_id, qty) VALUES (?, ?, ?)`,
    args: [snapshotId, cardId, qty],
  });
}

export async function insertDraft(
  client: Client,
  draftId: string,
  opts: {
    name?: string;
    date?: string;
    phase?: string;
    numSeats?: number;
    cubeSnapshotId?: number;
    bannedCards?: string[];
  } = {}
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, draft_name, draft_date, phase, num_seats, cube_snapshot_id, banned_cards)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      draftId,
      opts.name ?? draftId,
      opts.date ?? "2026-01-01",
      opts.phase ?? "complete",
      opts.numSeats ?? 10,
      opts.cubeSnapshotId ?? 1,
      opts.bannedCards ? JSON.stringify(opts.bannedCards) : null,
    ],
  });
}

export async function insertPickEvent(
  client: Client,
  draftId: string,
  pickN: number,
  seat: number,
  cardId: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)`,
    args: [draftId, pickN, seat, cardId],
  });
}

export async function insertMatch(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins) VALUES (?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins],
  });
}

export async function insertDeckCard(
  client: Client,
  draftId: string,
  seat: number,
  cardId: number,
  zone: "deck" | "sideboard" = "deck"
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO deck_cards (draft_id, seat, card_id, zone) VALUES (?, ?, ?, ?)`,
    args: [draftId, seat, cardId, zone],
  });
}

export async function insertPrivacyOptOut(
  client: Client,
  draftId: string,
  seat: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO privacy_opt_outs (draft_id, seat) VALUES (?, ?)`,
    args: [draftId, seat],
  });
}

export async function insertSeatToken(
  client: Client,
  draftId: string,
  seat: number,
  opts: { displayName?: string | null; autoPick?: boolean; queueJson?: string | null } = {}
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO seat_tokens (draft_id, seat, token, display_name, auto_pick, queue_json) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      draftId,
      seat,
      `token-${draftId}-${seat}`,
      opts.displayName ?? null,
      opts.autoPick === false ? 0 : 1,
      opts.queueJson ?? null,
    ],
  });
}

export async function insertFloatedCard(
  client: Client,
  draftId: string,
  seat: number,
  cardName: string
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO floated_cards (draft_id, seat, card_name) VALUES (?, ?, ?)`,
    args: [draftId, seat, cardName],
  });
}
