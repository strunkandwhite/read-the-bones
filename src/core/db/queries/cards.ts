/**
 * Card resolution queries (exact, fuzzy, lookup).
 */

import type { Client } from "@libsql/client";
import type { Card } from "../schema";
import { rowToCard, parseScryfallJson, placeholders, type LookupCardResult } from "./helpers";
import { fetchFromScryfallApi } from "../../scryfallApi";

/**
 * Resolve a card by name (case-insensitive).
 * Returns the full card record or null if not found.
 */
export async function resolveCard(client: Client, cardName: string): Promise<Card | null> {
  const result = await resolveCardFuzzy(client, cardName);
  return result.match?.card ?? null;
}

// ============================================================================
// Fuzzy Card Resolution
// ============================================================================

export interface FuzzyCardMatch {
  card: Card;
  match_type: 'exact' | 'front_face' | 'back_face' | 'prefix' | 'substring';
}

export interface FuzzyCardResult {
  match: FuzzyCardMatch | null;
  candidates: string[] | null;  // non-null when ambiguous
}

/**
 * Resolve a card by name using cascading fuzzy matching.
 * Tries exact match, then front-face DFC, back-face DFC, prefix, and substring.
 * Returns the match with its type, or candidates when ambiguous.
 */
export async function resolveCardFuzzy(client: Client, cardName: string): Promise<FuzzyCardResult> {

  // 1. Exact match
  const exact = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json FROM cards WHERE LOWER(name) = LOWER(?) LIMIT 1`,
    args: [cardName],
  });
  if (exact.rows.length === 1) {
    return { match: { card: rowToCard(exact.rows[0]), match_type: 'exact' }, candidates: null };
  }

  // 2. Front-face DFC match
  const frontFace = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json FROM cards WHERE LOWER(name) LIKE LOWER(? || ' // %') LIMIT 5`,
    args: [cardName],
  });
  if (frontFace.rows.length === 1) {
    return { match: { card: rowToCard(frontFace.rows[0]), match_type: 'front_face' }, candidates: null };
  }
  if (frontFace.rows.length > 1) {
    return { match: null, candidates: frontFace.rows.map(r => r.name as string) };
  }

  // 3. Back-face DFC match
  const backFace = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json FROM cards WHERE LOWER(name) LIKE LOWER('% // ' || ?) LIMIT 5`,
    args: [cardName],
  });
  if (backFace.rows.length === 1) {
    return { match: { card: rowToCard(backFace.rows[0]), match_type: 'back_face' }, candidates: null };
  }
  if (backFace.rows.length > 1) {
    return { match: null, candidates: backFace.rows.map(r => r.name as string) };
  }

  // 4. Prefix match
  const prefix = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json FROM cards WHERE LOWER(name) LIKE LOWER(? || '%') LIMIT 5`,
    args: [cardName],
  });
  if (prefix.rows.length === 1) {
    return { match: { card: rowToCard(prefix.rows[0]), match_type: 'prefix' }, candidates: null };
  }
  if (prefix.rows.length > 1) {
    return { match: null, candidates: prefix.rows.map(r => r.name as string) };
  }

  // 5. Substring match
  const substring = await client.execute({
    sql: `SELECT card_id, oracle_id, name, scryfall_json FROM cards WHERE LOWER(name) LIKE LOWER('%' || ? || '%') LIMIT 5`,
    args: [cardName],
  });
  if (substring.rows.length === 1) {
    return { match: { card: rowToCard(substring.rows[0]), match_type: 'substring' }, candidates: null };
  }
  if (substring.rows.length > 1) {
    return { match: null, candidates: substring.rows.map(r => r.name as string) };
  }

  return { match: null, candidates: null };
}

/**
 * Look up a card by name and return parsed Scryfall data.
 * First checks the local database. If not found, falls back to a live Scryfall
 * API call — callers should be aware this may make a network request.
 */
export async function lookupCardWithApiFallback(
  client: Client,
  cardName: string
): Promise<LookupCardResult | null> {
  // First, try to find the card in the database
  const card = await resolveCard(client, cardName);
  if (card) {
    const scryfall = parseScryfallJson(card.scryfall_json);

    return {
      name: card.name,
      oracle_text: scryfall?.oracle_text || null,
      type_line: scryfall?.type_line || null,
      mana_cost: scryfall?.mana_cost || null,
      color_identity: scryfall?.color_identity || [],
    };
  }

  // Fallback: query the Scryfall API directly when the card isn't in the DB
  return fetchFromScryfallApi(cardName);
}

// ============================================================================
// Live Draft Card Queries
// ============================================================================

/**
 * Resolve a card name to its card_id.
 * Uses exact name match (case-sensitive, matching the pick route behavior).
 * Returns null if the card doesn't exist.
 */
export async function resolveCardId(
  client: Client,
  cardName: string,
): Promise<number | null> {
  const result = await client.execute({
    sql: "SELECT card_id FROM cards WHERE name = ?",
    args: [cardName],
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].card_id as number;
}

/**
 * Batch resolve card names to card_ids.
 * Returns a Map<string, number> of name → card_id for all found cards.
 */
export async function resolveCardIds(
  client: Client,
  cardNames: string[],
): Promise<Map<string, number>> {
  if (cardNames.length === 0) return new Map();
  const result = await client.execute({
    sql: `SELECT card_id, name FROM cards WHERE name IN (${placeholders(cardNames.length)})`,
    args: cardNames,
  });
  const map = new Map<string, number>();
  for (const row of result.rows) {
    map.set(row.name as string, row.card_id as number);
  }
  return map;
}
