/**
 * Card code dictionary for prompt compression.
 *
 * Generates short, deterministic codes from card names to reduce token usage
 * in LLM prompts while maintaining full names in output.
 */

import { normalizeCardName, cardNameKey } from "../core/parseCsv";

/** Length of generated card codes */
const CODE_LENGTH = 4;

/** Maximum collision resolution attempts before throwing */
const MAX_COLLISION_ATTEMPTS = 100;

/**
 * Simple string hash function (djb2 algorithm).
 * Returns a positive integer hash.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Generate a short code from a card name.
 * Uses hash-based approach for deterministic, collision-resistant codes.
 *
 * @param cardName - The normalized card name
 * @returns A CODE_LENGTH-character alphanumeric code
 */
export function generateCardCode(cardName: string): string {
  const hash = hashString(cardName.toLowerCase());
  return hash.toString(36).slice(0, CODE_LENGTH).padStart(CODE_LENGTH, "0");
}

/**
 * Build a card dictionary mapping codes to full names.
 *
 * @param cardNames - Array of normalized card names (may contain duplicates)
 * @returns Map of code -> fullName
 */
export function buildCardDictionary(cardNames: string[]): Map<string, string> {
  const dict = new Map<string, string>();
  const usedCodes = new Set<string>();
  const seenNames = new Set<string>();

  for (const name of cardNames) {
    // Skip duplicates
    if (seenNames.has(name)) {
      continue;
    }
    seenNames.add(name);

    let code = generateCardCode(name);

    // Handle collisions by appending a suffix
    let suffix = 0;
    while (usedCodes.has(code)) {
      suffix++;
      if (suffix > MAX_COLLISION_ATTEMPTS) {
        throw new Error(`Too many hash collisions for card: ${name}`);
      }
      code = generateCardCode(name + suffix.toString());
    }

    usedCodes.add(code);
    dict.set(code, name);
  }

  return dict;
}

/**
 * Build a reverse dictionary mapping full names to codes.
 *
 * @param dict - Map of code -> fullName from buildCardDictionary
 * @returns Map of fullName -> code
 */
export function buildReverseDictionary(dict: Map<string, string>): Map<string, string> {
  const reverse = new Map<string, string>();
  for (const [code, name] of dict) {
    reverse.set(name, code);
  }
  return reverse;
}

/**
 * Count occurrences of each normalized card name in a pool.
 * Used to track duplicates (e.g., "Scalding Tarn" appearing twice).
 *
 * @param rawPool - Array of card names (may include duplicates like "Scalding Tarn 2")
 * @returns Map of display name -> count (only entries with count > 1)
 */
export function buildPoolCounts(rawPool: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  const displayNames = new Map<string, string>(); // key -> first display name seen

  for (const name of rawPool) {
    const normalized = normalizeCardName(name);
    const key = cardNameKey(name);
    counts.set(key, (counts.get(key) || 0) + 1);
    // Keep first display name seen for proper casing
    if (!displayNames.has(key)) {
      displayNames.set(key, normalized);
    }
  }

  // Filter to only duplicates, using display names as keys
  const duplicates = new Map<string, number>();
  for (const [key, count] of counts) {
    if (count > 1) {
      const displayName = displayNames.get(key)!;
      duplicates.set(displayName, count);
    }
  }

  return duplicates;
}

/**
 * Format the CARD_DICT section for the prompt.
 *
 * @param dict - Map of code -> fullName
 * @returns Formatted string for prompt
 */
export function formatCardDict(dict: Map<string, string>): string {
  const lines: string[] = ["CARD_DICT:"];

  // Sort by code for consistent output
  const sorted = Array.from(dict.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  for (const [code, name] of sorted) {
    lines.push(`  ${code}: "${name}"`);
  }

  return lines.join("\n");
}

/**
 * Format the POOL_COUNTS section for the prompt.
 * Only includes cards with count > 1.
 *
 * @param counts - Map of normalized name -> count (duplicates only)
 * @param reverseDict - Map of fullName -> code
 * @returns Formatted string, or null if no duplicates
 */
export function formatPoolCounts(
  counts: Map<string, number>,
  reverseDict: Map<string, string>
): string | null {
  if (counts.size === 0) {
    return null;
  }

  const lines: string[] = ["POOL_COUNTS:"];

  for (const [name, count] of counts) {
    const code = reverseDict.get(name);
    if (code) {
      lines.push(`  ${code}: ${count}`);
    }
  }

  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Encode a list of card names as codes.
 *
 * @param cardNames - Array of card names to encode
 * @param reverseDict - Map of fullName -> code
 * @returns Array of codes
 */
export function encodeCards(cardNames: string[], reverseDict: Map<string, string>): string[] {
  return cardNames.map((name) => reverseDict.get(name) || name);
}
