-- MTG Draft Analytics Database Schema
-- Run with: pnpm db:migrate

-- Enable foreign key enforcement (SQLite/libSQL doesn't enforce by default)
PRAGMA foreign_keys = ON;

-- Card identity registry
-- Stores unique cards by oracle_id (Scryfall's canonical identifier)
CREATE TABLE IF NOT EXISTS cards (
  card_id INTEGER PRIMARY KEY,
  oracle_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scryfall_json TEXT
);

-- Cube snapshots
-- A cube_hash uniquely identifies a specific set of cards in a cube
CREATE TABLE IF NOT EXISTS cube_snapshots (
  cube_snapshot_id INTEGER PRIMARY KEY,
  cube_hash TEXT NOT NULL UNIQUE
);

-- Cards in each cube snapshot
CREATE TABLE IF NOT EXISTS cube_snapshot_cards (
  cube_snapshot_id INTEGER NOT NULL REFERENCES cube_snapshots(cube_snapshot_id),
  card_id INTEGER NOT NULL REFERENCES cards(card_id),
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cube_snapshot_id, card_id)
);

-- Draft metadata
-- draft_id is the folder name / draft identifier
-- import_hash detects when source data has changed
-- num_seats stores the number of drafters
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  draft_name TEXT NOT NULL,
  draft_date TEXT NOT NULL,
  cube_snapshot_id INTEGER NOT NULL REFERENCES cube_snapshots(cube_snapshot_id),
  import_hash TEXT NOT NULL,
  num_seats INTEGER NOT NULL DEFAULT 10,
  is_complete INTEGER NOT NULL DEFAULT 1,
  sheet_id TEXT
);

-- Migration: add is_complete to existing databases (no-op on fresh install;
-- migrate.ts catches "duplicate column" errors from the CREATE TABLE above)
ALTER TABLE drafts ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 1;

-- Add sheet_id for serverless sync (active draft filtering)
ALTER TABLE drafts ADD COLUMN sheet_id TEXT;

-- Per-draft card bans (JSON array of card names, e.g. '["Reanimate","Channel"]')
ALTER TABLE drafts ADD COLUMN banned_cards TEXT;

INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('sync_lock', '');
INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('last_synced_at', '0');

-- Canonical pick log
-- pick_n is the absolute pick number (1-N)
-- seat is the drafter's position (1-indexed)
CREATE TABLE IF NOT EXISTS pick_events (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  pick_n INTEGER NOT NULL,
  seat INTEGER NOT NULL,
  card_id INTEGER NOT NULL REFERENCES cards(card_id),
  PRIMARY KEY (draft_id, pick_n)
);

-- Match results
-- Records game wins between seats in a draft
CREATE TABLE IF NOT EXISTS match_events (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat1 INTEGER NOT NULL,
  seat2 INTEGER NOT NULL,
  seat1_wins INTEGER NOT NULL,
  seat2_wins INTEGER NOT NULL,
  PRIMARY KEY (draft_id, seat1, seat2)
);

-- Privacy opt-outs
-- Seats that have opted out of API queries
-- Migration: rename from legacy table (skipped on fresh install where table doesn't exist)
ALTER TABLE llm_opt_outs RENAME TO privacy_opt_outs;

CREATE TABLE IF NOT EXISTS privacy_opt_outs (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  PRIMARY KEY (draft_id, seat)
);

-- Decklist data from sealeddeck.tech
-- zone is 'deck' (maindecked) or 'sideboard' (in pool but not played)
CREATE TABLE IF NOT EXISTS deck_cards (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  card_id INTEGER NOT NULL REFERENCES cards(card_id),
  zone TEXT NOT NULL CHECK (zone IN ('deck', 'sideboard')),
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (draft_id, seat, card_id, zone)
);

-- Per-seat decklist hashes for incremental diffing
CREATE TABLE IF NOT EXISTS deck_hashes (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (draft_id, seat)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_pick_events_card ON pick_events(card_id);
CREATE INDEX IF NOT EXISTS idx_pick_events_seat ON pick_events(seat);
CREATE INDEX IF NOT EXISTS idx_drafts_date ON drafts(draft_date);
CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_deck_cards_seat ON deck_cards(draft_id, seat);

-- Immutable snapshots of shared decks. Distinct from deck_cards, which stores
-- actual decklists imported from sealeddeck.tech for analytics purposes.
CREATE TABLE IF NOT EXISTS shared_decks (
  deck_id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ingestion metadata (cache busting hash, etc.)
CREATE TABLE IF NOT EXISTS ingestion_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
