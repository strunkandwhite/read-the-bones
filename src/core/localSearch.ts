/**
 * Local search implementation for Scryfall-style card queries.
 * Supports a subset of Scryfall operators for fast client-side filtering.
 */

import type { ScryCard } from "./types";

/**
 * Parsed search term with operator and value.
 */
type SearchTerm =
  | { type: "name"; value: string }
  | { type: "type"; value: string }
  | { type: "oracle"; value: string }
  | { type: "color"; value: string }
  | { type: "cmc"; operator: "=" | "<" | ">" | "<=" | ">="; value: number };

/**
 * Color letter to Scryfall color code mapping.
 */
const COLOR_MAP: Record<string, string> = {
  w: "W",
  u: "U",
  b: "B",
  r: "R",
  g: "G",
};

/**
 * Tokenizes a query string, respecting quoted strings.
 * Handles operators with quoted values like o:"draw a card"
 *
 * @param query - The search query string
 * @returns Array of tokens
 */
function tokenize(query: string): string[] {
  const tokens: string[] = [];
  const trimmed = query.trim();

  if (!trimmed) {
    return tokens;
  }

  // Match either:
  // 1. operator:"quoted value" or operator:'quoted value'
  // 2. operator:unquoted_value
  // 3. plain words
  const regex = /(\w+:(?:"[^"]*"|'[^']*'|\S+))|(\S+)/g;
  let match;

  while ((match = regex.exec(trimmed)) !== null) {
    tokens.push(match[0]);
  }

  return tokens;
}

/**
 * Parses a query string into individual search terms.
 *
 * @param query - The search query string
 * @returns Array of parsed search terms
 */
function parseQuery(query: string): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const tokens = tokenize(query);

  for (const token of tokens) {
    const term = parseTerm(token);
    if (term) {
      terms.push(term);
    }
  }

  return terms;
}

/**
 * Strips surrounding quotes from a value if present.
 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a single term into a SearchTerm.
 *
 * @param term - A single search term (e.g., "t:creature", 'o:"draw a card"', "cmc=3")
 * @returns Parsed SearchTerm or null if empty
 */
function parseTerm(term: string): SearchTerm | null {
  const trimmed = term.trim();
  if (!trimmed) {
    return null;
  }

  // Type operator: type: or t:
  const typeMatch = trimmed.match(/^(?:type|t):(.+)$/i);
  if (typeMatch) {
    return { type: "type", value: stripQuotes(typeMatch[1]) };
  }

  // Oracle operator: oracle: or o:
  const oracleMatch = trimmed.match(/^(?:oracle|o):(.+)$/i);
  if (oracleMatch) {
    return { type: "oracle", value: stripQuotes(oracleMatch[1]) };
  }

  // Color operator: color: or c:
  const colorMatch = trimmed.match(/^(?:color|c):(.+)$/i);
  if (colorMatch) {
    return { type: "color", value: stripQuotes(colorMatch[1]).toLowerCase() };
  }

  // CMC operator with comparison: cmc=3, cmc<3, cmc>3, cmc<=3, cmc>=3
  const cmcMatch = trimmed.match(/^cmc(<=|>=|=|<|>)(\d+)$/i);
  if (cmcMatch) {
    return {
      type: "cmc",
      operator: cmcMatch[1] as "=" | "<" | ">" | "<=" | ">=",
      value: parseInt(cmcMatch[2], 10),
    };
  }

  // MV shorthand: mv:3 (equivalent to cmc=3)
  const mvMatch = trimmed.match(/^mv:(\d+)$/i);
  if (mvMatch) {
    return {
      type: "cmc",
      operator: "=",
      value: parseInt(mvMatch[1], 10),
    };
  }

  // Default: treat as name search
  return { type: "name", value: trimmed };
}

/**
 * Checks if a card matches a single search term.
 *
 * @param card - The card to check
 * @param term - The search term to match against
 * @returns True if the card matches the term
 */
function matchesTerm(card: ScryCard, term: SearchTerm): boolean {
  switch (term.type) {
    case "name":
      return card.name.toLowerCase().includes(term.value.toLowerCase());

    case "type":
      return card.typeLine.toLowerCase().includes(term.value.toLowerCase());

    case "oracle":
      return card.oracleText.toLowerCase().includes(term.value.toLowerCase());

    case "color":
      return matchesColor(card, term.value);

    case "cmc":
      return matchesCmc(card, term.operator, term.value);

    default:
      return false;
  }
}

/**
 * Checks if a card matches a color query.
 *
 * @param card - The card to check
 * @param colorQuery - The color query string (e.g., "r", "ub", "c")
 * @returns True if the card matches all specified colors
 */
function matchesColor(card: ScryCard, colorQuery: string): boolean {
  // Handle colorless: "c" means empty colors array
  if (colorQuery === "c") {
    return card.colors.length === 0;
  }

  // Each character must be a color the card has
  for (const char of colorQuery) {
    const color = COLOR_MAP[char];
    if (!color) {
      // Unknown color letter - treat as no match
      return false;
    }
    if (!card.colors.includes(color)) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if a card matches a CMC comparison.
 *
 * @param card - The card to check
 * @param operator - The comparison operator
 * @param value - The CMC value to compare against
 * @returns True if the card's mana value satisfies the comparison
 */
function matchesCmc(
  card: ScryCard,
  operator: "=" | "<" | ">" | "<=" | ">=",
  value: number
): boolean {
  const mv = card.manaValue;

  switch (operator) {
    case "=":
      return mv === value;
    case "<":
      return mv < value;
    case ">":
      return mv > value;
    case "<=":
      return mv <= value;
    case ">=":
      return mv >= value;
    default:
      return false;
  }
}

/**
 * Searches cards locally using Scryfall-style query syntax.
 *
 * Supported operators:
 * - `type:` / `t:` - Match type line (case-insensitive substring)
 * - `oracle:` / `o:` - Match oracle text (case-insensitive substring)
 * - `color:` / `c:` - Match colors (w/u/b/r/g, c=colorless)
 * - `cmc` / `mv:` - Match mana value (=, <, >, <=, >=)
 * - Plain text - Match card name (case-insensitive substring)
 *
 * All terms are ANDed together.
 *
 * @example
 * searchLocalCards("t:creature", cards)  // all creatures
 * searchLocalCards("o:flying", cards)    // cards with "flying" in oracle text
 * searchLocalCards("c:r cmc=1", cards)   // red cards with CMC 1
 * searchLocalCards("bolt", cards)        // cards with "bolt" in name
 *
 * @param query - The search query string
 * @param cards - Array of cards to search
 * @returns Cards matching all search terms
 */
export function searchLocalCards(query: string, cards: ScryCard[]): ScryCard[] {
  const terms = parseQuery(query);

  // Empty query returns all cards
  if (terms.length === 0) {
    return cards;
  }

  // Filter cards that match ALL terms (AND logic)
  return cards.filter((card) => terms.every((term) => matchesTerm(card, term)));
}
