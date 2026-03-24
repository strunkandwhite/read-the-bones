/**
 * Local search implementation for Scryfall-style card queries.
 * Supports a subset of Scryfall operators for fast client-side filtering.
 *
 * Supports: negation (-), OR logic, parentheses grouping, and these operators:
 * - name (plain text), !exact name
 * - t:/type:, o:/oracle:, c:/color:, id:/identity:, m:/mana:
 * - mv/cmc with =, <, >, <=, >=, !=
 */

import type { ScryCard } from "./types";

// ─── Term Types ──────────────────────────────────────────────────────────────

type SearchTerm =
  | { type: "name"; value: string }
  | { type: "exact_name"; value: string }
  | { type: "type"; value: string }
  | { type: "oracle"; value: string }
  | { type: "color"; operator: ColorOperator; value: string }
  | { type: "identity"; operator: ColorOperator; value: string }
  | { type: "mana"; value: string }
  | {
      type: "mv";
      operator: "=" | "<" | ">" | "<=" | ">=" | "!=";
      value: number;
    };

type ColorOperator = ":" | "=" | ">=" | "<=" | ">" | "<";

// ─── AST Types ───────────────────────────────────────────────────────────────

type SearchExpr =
  | { kind: "term"; negated: boolean; term: SearchTerm }
  | { kind: "and"; children: SearchExpr[] }
  | { kind: "or"; children: SearchExpr[] };

// ─── Token Types ─────────────────────────────────────────────────────────────

type Token =
  | { kind: "word"; value: string }
  | { kind: "or" }
  | { kind: "lparen" }
  | { kind: "rparen" };

// ─── Color Constants ─────────────────────────────────────────────────────────

const COLOR_MAP: Record<string, string> = {
  w: "W",
  u: "U",
  b: "B",
  r: "R",
  g: "G",
};

// ─── Tokenizer ───────────────────────────────────────────────────────────────

/**
 * Tokenizes a query string into structured tokens.
 * Handles quoted strings, parentheses, and the `or` keyword.
 */
function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  const trimmed = query.trim();
  if (!trimmed) return tokens;

  // Match: parens, operator:"quoted", operator:'quoted', operator:value, or plain words
  // Use [^\s()]+ instead of \S+ so parens aren't consumed as part of values
  const regex =
    /([()])|(\w+:(?:(?:<=|>=|!=|[=<>]))?(?:"[^"]*"|'[^']*'|[^\s()]+))|(!(?:"[^"]*"|'[^']*'|[^\s()]+))|([^\s()]+)/g;
  let match;

  while ((match = regex.exec(trimmed)) !== null) {
    const [full, paren, operatorTerm, exactName, plain] = match;

    if (paren) {
      tokens.push({ kind: paren === "(" ? "lparen" : "rparen" });
    } else if (operatorTerm) {
      tokens.push({ kind: "word", value: operatorTerm });
    } else if (exactName) {
      tokens.push({ kind: "word", value: exactName });
    } else if (plain) {
      if (plain.toLowerCase() === "or") {
        tokens.push({ kind: "or" });
      } else {
        tokens.push({ kind: "word", value: plain });
      }
    } else {
      tokens.push({ kind: "word", value: full });
    }
  }

  return tokens;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

/**
 * Parses tokens into an AST. Grammar:
 *   expr     = or_expr
 *   or_expr  = and_expr ("or" and_expr)*
 *   and_expr = atom+
 *   atom     = "(" or_expr ")" | "-"? term
 */
function parseExpr(tokens: Token[]): SearchExpr {
  let pos = 0;

  function parseOrExpr(): SearchExpr {
    const children: SearchExpr[] = [parseAndExpr()];
    while (pos < tokens.length && tokens[pos].kind === "or") {
      pos++; // consume "or"
      children.push(parseAndExpr());
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  function parseAndExpr(): SearchExpr {
    const children: SearchExpr[] = [];
    while (pos < tokens.length && tokens[pos].kind !== "or" && tokens[pos].kind !== "rparen") {
      children.push(parseAtom());
    }
    if (children.length === 0) {
      // Empty group — return a no-op that matches everything
      return { kind: "and", children: [] };
    }
    return children.length === 1 ? children[0] : { kind: "and", children };
  }

  function parseAtom(): SearchExpr {
    const tok = tokens[pos];

    // Parenthesized group (with optional leading negation)
    if (tok.kind === "lparen") {
      pos++; // consume "("
      const inner = parseOrExpr();
      if (pos < tokens.length && tokens[pos].kind === "rparen") {
        pos++; // consume ")"
      }
      return inner;
    }

    // Negated group: -(...)
    if (tok.kind === "word" && tok.value === "-" && pos + 1 < tokens.length && tokens[pos + 1].kind === "lparen") {
      pos++; // consume "-"
      pos++; // consume "("
      const inner = parseOrExpr();
      if (pos < tokens.length && tokens[pos].kind === "rparen") {
        pos++; // consume ")"
      }
      return negate(inner);
    }

    // Word token — parse as term
    if (tok.kind === "word") {
      pos++;
      const negated = tok.value.startsWith("-");
      const raw = negated ? tok.value.slice(1) : tok.value;
      const term = parseTerm(raw);
      if (!term) {
        // Unknown term, return no-op
        return { kind: "and", children: [] };
      }
      return { kind: "term", negated, term };
    }

    // Unexpected token — skip
    pos++;
    return { kind: "and", children: [] };
  }

  const result = parseOrExpr();
  return result;
}

/**
 * Negates an expression by wrapping each leaf term.
 */
function negate(expr: SearchExpr): SearchExpr {
  switch (expr.kind) {
    case "term":
      return { ...expr, negated: !expr.negated };
    case "and":
      // -(A AND B) = (-A OR -B) by De Morgan's
      return { kind: "or", children: expr.children.map(negate) };
    case "or":
      // -(A OR B) = (-A AND -B) by De Morgan's
      return { kind: "and", children: expr.children.map(negate) };
  }
}

// ─── Term Parser ─────────────────────────────────────────────────────────────

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
 * Parses a single raw string into a SearchTerm.
 */
function parseTerm(raw: string): SearchTerm | null {
  if (!raw) return null;

  // Exact name: !Lightning Bolt or !"Lightning Bolt"
  if (raw.startsWith("!")) {
    return { type: "exact_name", value: stripQuotes(raw.slice(1)) };
  }

  // Type operator: type: or t:
  const typeMatch = raw.match(/^(?:type|t):(.+)$/i);
  if (typeMatch) {
    return { type: "type", value: stripQuotes(typeMatch[1]) };
  }

  // Oracle operator: oracle: or o:
  const oracleMatch = raw.match(/^(?:oracle|o):(.+)$/i);
  if (oracleMatch) {
    return { type: "oracle", value: stripQuotes(oracleMatch[1]) };
  }

  // Color operator: color: or c: (with optional comparison operator)
  const colorMatch = raw.match(/^(?:color|c)(<=|>=|=|<|>|:)(.+)$/i);
  if (colorMatch) {
    return {
      type: "color",
      operator: colorMatch[1] as ColorOperator,
      value: stripQuotes(colorMatch[2]).toLowerCase(),
    };
  }

  // Color identity operator: id: or identity:
  const identityMatch = raw.match(/^(?:id|identity)(<=|>=|=|<|>|:)(.+)$/i);
  if (identityMatch) {
    return {
      type: "identity",
      operator: identityMatch[1] as ColorOperator,
      value: stripQuotes(identityMatch[2]).toLowerCase(),
    };
  }

  // Mana cost operator: m: or mana:
  const manaMatch = raw.match(/^(?:m|mana):(.+)$/i);
  if (manaMatch) {
    return { type: "mana", value: stripQuotes(manaMatch[1]) };
  }

  // Mana value operator: mv=3, mv<3, mv>3, mv<=3, mv>=3, mv!=3 (also cmc)
  const mvMatch = raw.match(/^(?:mv|cmc)(<=|>=|!=|=|<|>)(\d+)$/i);
  if (mvMatch) {
    return {
      type: "mv",
      operator: mvMatch[1] as "=" | "<" | ">" | "<=" | ">=" | "!=",
      value: parseInt(mvMatch[2], 10),
    };
  }

  // MV colon shorthand: mv:3
  const mvColonMatch = raw.match(/^(?:mv|cmc):(\d+)$/i);
  if (mvColonMatch) {
    return {
      type: "mv",
      operator: "=",
      value: parseInt(mvColonMatch[1], 10),
    };
  }

  // Default: treat as name search
  return { type: "name", value: raw };
}

// ─── Matching ────────────────────────────────────────────────────────────────

/**
 * Evaluates a search expression against a card.
 */
function evaluate(card: ScryCard, expr: SearchExpr): boolean {
  switch (expr.kind) {
    case "term": {
      const result = matchesTerm(card, expr.term);
      return expr.negated ? !result : result;
    }
    case "and":
      // Empty AND matches everything (no-op)
      return expr.children.every((child) => evaluate(card, child));
    case "or":
      return expr.children.some((child) => evaluate(card, child));
  }
}

function matchesTerm(card: ScryCard, term: SearchTerm): boolean {
  switch (term.type) {
    case "name":
      return card.name.toLowerCase().includes(term.value.toLowerCase());

    case "exact_name":
      return card.name.toLowerCase() === term.value.toLowerCase();

    case "type":
      return card.typeLine.toLowerCase().includes(term.value.toLowerCase());

    case "oracle":
      return card.oracleText.toLowerCase().includes(term.value.toLowerCase());

    case "color":
      return matchesColorExpr(card.colors, term.operator, term.value);

    case "identity":
      return matchesColorExpr(card.colorIdentity, term.operator, term.value);

    case "mana":
      return matchesMana(card, term.value);

    case "mv":
      return matchesMv(card, term.operator, term.value);

    default:
      return false;
  }
}

/**
 * Matches a color expression with comparison operators.
 *
 * Scryfall color semantics:
 * - `c:r` (colon) = card colors include all specified (superset or equal)
 * - `c=r` = card colors are exactly the specified set
 * - `c>=ub` = card colors are a superset of (or equal to) ub
 * - `c<=ub` = card colors are a subset of (or equal to) ub
 * - `c>ub` = strict superset
 * - `c<ub` = strict subset
 * - `c:m` = multicolor (2+ colors)
 * - `c:c` = colorless (0 colors)
 */
function matchesColorExpr(
  cardColors: string[],
  operator: ColorOperator,
  query: string
): boolean {
  // Special: multicolor — comparison operators don't have meaningful
  // semantics here, so all operators behave the same as `c:m`
  if (query === "m") {
    return cardColors.length >= 2;
  }

  // Special: colorless — same rationale as multicolor
  if (query === "c") {
    return cardColors.length === 0;
  }

  // Parse query colors
  const queryColors = parseColorQuery(query);
  if (!queryColors) return false;

  const cardSet = new Set(cardColors);
  const querySet = new Set(queryColors);

  // Check subset/superset relationships
  const cardHasAll = queryColors.every((c) => cardSet.has(c));
  const queryHasAll = cardColors.every((c) => querySet.has(c));
  const sameSize = cardSet.size === querySet.size;

  switch (operator) {
    case ":":
      // Colon = "includes all specified colors" (Scryfall default)
      return cardHasAll;
    case "=":
      // Exact match
      return cardHasAll && queryHasAll && sameSize;
    case ">=":
      // Card colors are superset or equal
      return cardHasAll;
    case ">":
      // Card colors are strict superset
      return cardHasAll && cardSet.size > querySet.size;
    case "<=":
      // Card colors are subset or equal
      return queryHasAll;
    case "<":
      // Card colors are strict subset
      return queryHasAll && cardSet.size < querySet.size;
    default:
      return false;
  }
}

/**
 * Parses a color query string into an array of uppercase color codes.
 * Returns null if any character is unknown.
 */
function parseColorQuery(query: string): string[] | null {
  const colors: string[] = [];
  for (const char of query) {
    const color = COLOR_MAP[char];
    if (!color) return null;
    colors.push(color);
  }
  return colors;
}

/**
 * Matches a mana cost query against a card's manaCost string.
 * Normalizes both to compare mana symbols.
 */
function matchesMana(card: ScryCard, query: string): boolean {
  const cardMana = card.manaCost.toLowerCase();
  const queryLower = query.toLowerCase();

  // If query uses {X} notation, match directly
  if (queryLower.includes("{")) {
    return cardMana.includes(queryLower);
  }

  // Otherwise treat each character as a mana symbol shorthand
  // e.g., "gg" means the card must contain {G}{G} (two green symbols)
  // Count occurrences of each symbol in the query
  const queryCounts = new Map<string, number>();
  for (const char of queryLower) {
    const symbol = `{${char}}`;
    queryCounts.set(symbol, (queryCounts.get(symbol) ?? 0) + 1);
  }

  // Count occurrences in card mana cost
  for (const [symbol, needed] of queryCounts) {
    const regex = new RegExp(symbol.replace(/[{}]/g, "\\$&"), "gi");
    const found = (cardMana.match(regex) ?? []).length;
    if (found < needed) return false;
  }

  return true;
}

function matchesMv(
  card: ScryCard,
  operator: "=" | "<" | ">" | "<=" | ">=" | "!=",
  value: number
): boolean {
  const mv = card.manaValue;

  switch (operator) {
    case "=":
      return mv === value;
    case "!=":
      return mv !== value;
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Searches cards locally using Scryfall-style query syntax.
 *
 * Supported operators:
 * - `type:` / `t:` - Match type line (case-insensitive substring)
 * - `oracle:` / `o:` - Match oracle text (case-insensitive substring)
 * - `color:` / `c:` - Match colors (w/u/b/r/g, c=colorless, m=multicolor)
 * - `id:` / `identity:` - Match color identity
 * - `m:` / `mana:` - Match mana cost symbols
 * - `mv` / `cmc` - Match mana value (=, <, >, <=, >=, !=)
 * - `!name` - Exact card name match
 * - `-term` - Negate any term
 * - `or` - OR logic between terms
 * - `(...)` - Group sub-expressions
 * - Plain text - Match card name (case-insensitive substring)
 *
 * All terms are ANDed together unless separated by `or`.
 *
 * @param query - The search query string
 * @param cards - Array of cards to search
 * @returns Cards matching the search expression
 */
export function searchLocalCards(query: string, cards: ScryCard[]): ScryCard[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return cards;

  const expr = parseExpr(tokens);
  return cards.filter((card) => evaluate(card, expr));
}
