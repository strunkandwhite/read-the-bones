/**
 * Search utilities for card name filtering and Scryfall operator detection.
 */

/**
 * Regex pattern to detect Scryfall search operators.
 * Matches common operators like type:, t:, c:, color:, cmc=, etc.
 */
const SCRYFALL_OPERATOR_PATTERN = /\b(type|t|c|color|cmc|mv|o|oracle)[:=<>]/i;

/**
 * Detects whether a search query contains Scryfall operators.
 * Used to determine search routing:
 * - With operators: use structured local search
 * - Without operators: use fast client-side name filter
 *
 * @example
 * hasScryfallOperators("type:creature") // true
 * hasScryfallOperators("c:r cmc<3") // true
 * hasScryfallOperators("Lightning Bolt") // false
 */
export function hasScryfallOperators(query: string): boolean {
  return SCRYFALL_OPERATOR_PATTERN.test(query);
}
