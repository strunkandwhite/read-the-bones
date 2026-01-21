/**
 * Core types for the card rankings system.
 * These types are framework-agnostic and shared across web app and CLI.
 */

/**
 * Represents a single card pick from a draft.
 * Created during CSV parsing, one record per card per drafter.
 */
/**
 * Metadata for a draft, loaded from metadata.json.
 */
export type DraftMetadata = {
  /** Folder name / draft identifier */
  draftId: string;
  /** Display name for the draft */
  name: string;
  /** ISO date string (e.g., "2025-12-01") */
  date: string;
  /** Number of drafters in this draft (optional for backwards compatibility) */
  numDrafters?: number;
};

/**
 * A card's score in a single draft, for building score history.
 */
export type DraftScore = {
  /** Draft identifier */
  draftId: string;
  /** ISO date string */
  date: string;
  /** Display name of the draft */
  draftName: string;
  /** Pick position in this draft (1-N or poolSize if unpicked) */
  pickPosition: number;
  /** Whether the card was picked (vs unpicked) */
  wasPicked: boolean;
  /** Number of drafters in this draft (for calculating round number) */
  numDrafters: number;
  /** Round number: ceil(pickPosition / numDrafters) */
  round: number;
  /** For aggregated dates: how many drafts picked this card */
  pickedCount?: number;
  /** For aggregated dates: total drafts on this date */
  totalCount?: number;
};

export type CardPick = {
  /** Card name, normalized (numeric suffix stripped) */
  cardName: string;
  /** Pick position: 1-N for picked cards, or poolSize for unpicked */
  pickPosition: number;
  /** Which copy in this draft: 1st, 2nd, etc. */
  copyNumber: number;
  /** False if card went unpicked and was assigned pool-size position */
  wasPicked: boolean;
  /** Identifier for the draft this pick came from */
  draftId: string;
  /** Seat number (0-indexed) - the drafter's position in the draft */
  seat: number;
  /** Color identity of the card (e.g., "W", "UB", "C" for colorless) */
  color: string;
};

/**
 * Aggregated statistics for a card across all drafts.
 * Computed from CardPick[] by calculateStats.
 */
export type CardStats = {
  /** Card name (normalized) */
  cardName: string;
  /** Weighted geometric mean of pick positions (lower = better) */
  weightedGeomean: number;
  /** Total number of times this card was picked */
  totalPicks: number;
  /** Number of drafts where this card was in the pool */
  timesAvailable: number;
  /** Number of drafts where at least one copy was picked */
  draftsPickedIn: number;
  /** Number of drafts where this card went unpicked */
  timesUnpicked: number;
  /** Highest copy number seen in any single draft (for annotation) */
  maxCopiesInDraft: number;
  /** Color identities associated with this card */
  colors: string[];
  /** Score history across drafts, sorted by date */
  scoreHistory: DraftScore[];
  /**
   * Distribution of picks across 15 buckets, each covering 30 picks:
   * [0] = Picks 1-30, [1] = Picks 31-60, ..., [14] = Picks 421-450+
   */
  pickDistribution: number[];
  /**
   * Win equity attribution for this card.
   * Optional because not all drafts have match data.
   */
  winEquity?: {
    /** Probability-weighted wins attributed to this card */
    wins: number;
    /** Probability-weighted losses attributed to this card */
    losses: number;
    /** Win rate: wins / (wins + losses) */
    winRate: number;
  };
  /**
   * Raw win rate for this card (no play probability weighting).
   * Distributes wins/losses equally among all cards in a player's pool.
   * Optional because not all drafts have match data.
   */
  rawWinRate?: {
    /** Wins attributed to this card (equally distributed among pool) */
    wins: number;
    /** Losses attributed to this card (equally distributed among pool) */
    losses: number;
    /** Win rate: wins / (wins + losses) */
    winRate: number;
  };
};

/**
 * Card data fetched from Scryfall API.
 * Cached locally to avoid repeated API calls.
 */
export type ScryCard = {
  /** Official card name from Scryfall */
  name: string;
  /** URI for card image (normal size) */
  imageUri: string;
  /** Mana cost string (e.g., "{2}{U}{U}") */
  manaCost: string;
  /** Converted mana cost / mana value (integer) */
  manaValue: number;
  /** Type line (e.g., "Creature - Human Wizard") */
  typeLine: string;
  /** Card's colors (e.g., ["U"] or ["W", "B"]) */
  colors: string[];
  /** Color identity for deck building purposes */
  colorIdentity: string[];
  /** Oracle text describing the card's abilities */
  oracleText: string;
};

/**
 * CardStats enriched with Scryfall metadata for display.
 * Used by the web UI to render the full card table.
 */
export type EnrichedCardStats = CardStats & {
  /** Scryfall data, undefined if card not found in API */
  scryfall?: ScryCard;
};

/**
 * Match result for a single match between two players.
 * Used in DraftDataFile for client-side win equity calculation.
 */
export type MatchResult = {
  seat1: number;
  seat2: number;
  seat1GamesWon: number;
  seat2GamesWon: number;
};

/**
 * Draft data for client-side recalculation.
 * Loaded lazily when user changes draft selection.
 */
export type DraftDataFile = {
  /** All picks from all drafts */
  picks: CardPick[];
  /** Map of draftId to card names in that draft's pool */
  pools: Record<string, string[]>;
  /** Map of draftId to metadata */
  metadata: Record<string, { name: string; date: string; numDrafters?: number }>;
  /** Map of draftId to match results for that draft */
  matchResults?: Record<string, MatchResult[]>;
};
