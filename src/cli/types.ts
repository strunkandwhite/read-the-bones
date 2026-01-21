/**
 * Types for the CLI draft suggestion tool.
 * These types capture the state of an in-progress draft and CLI options.
 */

/**
 * Captures the complete state of an in-progress draft.
 * Used to provide context to the LLM for pick suggestions.
 */
export type DraftState = {
  /** Drafter names in order (column order from CSV) */
  drafters: string[];
  /** Index of the user in the drafters array (configured via DRAFT_USER_NAME env var) */
  userIndex: number;
  /** Current pick number (1-indexed) */
  currentPickNumber: number;
  /** Index of drafter whose turn it is (0-indexed) */
  currentDrafterIndex: number;
  /** True if it's the user's turn */
  isUsersTurn: boolean;
  /** How many picks until the user's next turn (0 if their turn) */
  picksUntilUser: number;
  /** Cards the user has already picked */
  userPicks: string[];
  /** All picks by drafter name -> card names array */
  allPicks: Map<string, string[]>;
  /** Cards still available (not yet picked) */
  availableCards: string[];
  /** Total number of cards in the pool */
  poolSize: number;
  /** Round after which double-pick mode starts (from "Double Picks After:" metadata) */
  doublePickStartsAfterRound: number;
};

/**
 * CLI options for the suggest command.
 * Parsed from command-line arguments.
 */
export type SuggestOptions = {
  /** Path to the draft folder */
  draftPath: string;
  /** Use cheaper model for dev/testing */
  devMode: boolean;
  /** Print prompt without calling API */
  dryRun: boolean;
  /** Show data loading progress */
  verbose: boolean;
};

/**
 * A conversation is a chain of LLM responses that can be resumed.
 */
export type Conversation = {
  /** Unique identifier */
  id: string;
  /** LLM-generated summary (~5 words) */
  title: string;
  /** Which mode started this conversation */
  mode: "explore" | "draft";
  /** For draft mode: which draft folder was used */
  draftPath?: string;
  /** Ordered chain of OpenAI response IDs */
  responseIds: string[];
  /** ISO timestamp when conversation started */
  createdAt: string;
  /** ISO timestamp of last activity (for sorting) */
  updatedAt: string;
};

/**
 * Persistent store for all conversations.
 */
export type ConversationStore = {
  conversations: Conversation[];
};
