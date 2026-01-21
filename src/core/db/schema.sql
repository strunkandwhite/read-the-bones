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
  num_seats INTEGER NOT NULL DEFAULT 10
);

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

-- LLM opt-outs
-- Seats that have opted out of LLM queries
CREATE TABLE IF NOT EXISTS llm_opt_outs (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  PRIMARY KEY (draft_id, seat)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_pick_events_card ON pick_events(card_id);
CREATE INDEX IF NOT EXISTS idx_pick_events_seat ON pick_events(seat);
CREATE INDEX IF NOT EXISTS idx_drafts_date ON drafts(draft_date);
