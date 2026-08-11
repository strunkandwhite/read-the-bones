/**
 * Search utilities for card name filtering and Scryfall operator detection.
 */

/**
 * Regex pattern to detect Scryfall search operators.
 * Matches operators like type:, t:, c:, color:, id:, identity:, m:, mana:, mv=, cmc=, etc.
 * Also detects negation (-prefix), OR keyword, parentheses, and exact name (!prefix).
 */
const SCRYFALL_OPERATOR_PATTERN = /\b(type|t|c|color|cmc|mv|o|oracle|id|identity|m|mana)[:=<>!]/i;
const SCRYFALL_SYNTAX_PATTERN = /[()]|\bor\b|^!/i;

/**
 * Detects whether a search query contains Scryfall operators or syntax.
 * Used to determine search routing:
 * - With operators: use structured local search
 * - Without operators: use fast client-side name filter
 *
 * @example
 * hasScryfallOperators("type:creature") // true
 * hasScryfallOperators("c:r mv<3") // true
 * hasScryfallOperators("Lightning Bolt") // false
 * hasScryfallOperators("-t:creature") // true
 * hasScryfallOperators("!Lightning Bolt") // true
 */
export function hasScryfallOperators(query: string): boolean {
  return (
    SCRYFALL_OPERATOR_PATTERN.test(query) ||
    SCRYFALL_SYNTAX_PATTERN.test(query) ||
    /\s-\w/.test(query) // negation mid-query like "bolt -t:creature"
  );
}
