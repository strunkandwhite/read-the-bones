/**
 * TypeScript types matching the Turso database tables.
 * These types represent row data as returned from SQL queries.
 */

/**
 * Card identity registry.
 * Stores unique cards by oracle_id (Scryfall's canonical identifier).
 */
export interface Card {
  card_id: number;
  oracle_id: string;
  name: string;
  scryfall_json: string | null;
}

/**
 * Cube snapshot.
 * A cube_hash uniquely identifies a specific set of cards in a cube.
 */
export interface CubeSnapshot {
  cube_snapshot_id: number;
  cube_hash: string;
}

/**
 * Cards in a cube snapshot.
 * Links cards to cube snapshots with quantity.
 */
export interface CubeSnapshotCard {
  cube_snapshot_id: number;
  card_id: number;
  qty: number;
}

/**
 * Draft metadata.
 * draft_id is the folder name / draft identifier.
 * import_hash detects when source data has changed.
 * num_seats is the number of drafters.
 */
export interface Draft {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  cube_snapshot_id: number;
  import_hash: string;
  num_seats: number;
}

/**
 * Canonical pick event.
 * pick_n is the absolute pick number (1-N).
 * seat is the drafter's position (1-indexed).
 */
export interface PickEvent {
  draft_id: string;
  pick_n: number;
  seat: number;
  card_id: number;
}

/**
 * Match result between two seats.
 * Records game wins for each seat.
 */
export interface MatchEvent {
  draft_id: string;
  seat1: number;
  seat2: number;
  seat1_wins: number;
  seat2_wins: number;
}

/**
 * LLM opt-out entry.
 * Seats that have opted out of LLM queries.
 */
export interface LlmOptOut {
  draft_id: string;
  seat: number;
}

/**
 * Parsed Scryfall card data from scryfall_json.
 * Used for filtering by color, type, etc.
 */
export interface ScryfallCardData {
  name: string;
  color_identity?: string[];
  colors?: string[];
  type_line?: string;
  oracle_text?: string;
  mana_cost?: string;
  cmc?: number;
}
