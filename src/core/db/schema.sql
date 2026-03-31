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
-- num_seats stores the number of drafters
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  draft_name TEXT NOT NULL,
  draft_date TEXT NOT NULL,
  cube_snapshot_id INTEGER NOT NULL REFERENCES cube_snapshots(cube_snapshot_id),
  pool_hash TEXT,
  picks_hash TEXT,
  matches_hash TEXT,
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

-- Per-domain hashes for unified sync pipeline (replaces import_hash)
ALTER TABLE drafts ADD COLUMN pool_hash TEXT;
ALTER TABLE drafts ADD COLUMN picks_hash TEXT;
ALTER TABLE drafts ADD COLUMN matches_hash TEXT;

DELETE FROM ingestion_meta WHERE key = 'last_hash';

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

-- Card name aliases for alternate names (diacritics, Omen Paths digital names)
-- Maps alternate lowercase names to canonical card_ids
CREATE TABLE IF NOT EXISTS card_aliases (
  alias TEXT NOT NULL,
  card_id INTEGER NOT NULL REFERENCES cards(card_id),
  PRIMARY KEY (alias)
);

-- Live draft: phase replaces is_complete
ALTER TABLE drafts ADD COLUMN phase TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE drafts ADD COLUMN in_app INTEGER NOT NULL DEFAULT 0;
ALTER TABLE drafts ADD COLUMN picks_per_player INTEGER;

-- Backfill phase from is_complete
UPDATE drafts SET phase = CASE WHEN is_complete = 1 THEN 'complete' ELSE 'drafting' END;

-- Drop is_complete after migration (SQLite 3.35.0+)
ALTER TABLE drafts DROP COLUMN is_complete;

-- Match reporting attribution
ALTER TABLE match_events ADD COLUMN reported_by_seat INTEGER;

-- Seat tokens for live draft identity
CREATE TABLE IF NOT EXISTS seat_tokens (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  display_name TEXT,
  auto_pick INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (draft_id, seat)
);

-- Backfill picks_per_player for historical drafts
UPDATE drafts SET picks_per_player = (
  SELECT MAX(pe.pick_n) / d2.num_seats
  FROM pick_events pe
  JOIN drafts d2 ON d2.draft_id = pe.draft_id
  WHERE pe.draft_id = drafts.draft_id
) WHERE picks_per_player IS NULL AND phase = 'complete';

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_pick_events_card ON pick_events(card_id);
CREATE INDEX IF NOT EXISTS idx_pick_events_seat ON pick_events(seat);
CREATE INDEX IF NOT EXISTS idx_drafts_date ON drafts(draft_date);
CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards(card_id);
CREATE INDEX IF NOT EXISTS idx_deck_cards_seat ON deck_cards(draft_id, seat);

-- Unified deck storage: mutable WIP state and immutable shared snapshots.
-- Replaces shared_decks. Both kinds store DeckState JSON.
CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wip', 'snapshot')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_wip ON decks(draft_id, seat) WHERE kind = 'wip';

-- Migrate shared_decks → decks (no-op on fresh install where table doesn't exist)
INSERT OR IGNORE INTO decks (id, draft_id, seat, deck_state, kind, created_at, updated_at)
  SELECT deck_id, draft_id, seat, deck_state, 'snapshot', created_at, created_at
  FROM shared_decks;

DROP TABLE IF EXISTS shared_decks;

-- Ingestion metadata (cache busting hash, etc.)
CREATE TABLE IF NOT EXISTS ingestion_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- floated_cards: server-side storage for speculatively added cards
CREATE TABLE IF NOT EXISTS floated_cards (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  card_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (draft_id, seat, card_name),
  FOREIGN KEY (draft_id) REFERENCES drafts(draft_id)
);

-- queue_json on seat_tokens: JSON array of queue group entries
ALTER TABLE seat_tokens ADD COLUMN queue_json TEXT;
