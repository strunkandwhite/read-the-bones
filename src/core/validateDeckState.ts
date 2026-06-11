import { COLUMN_KEYS } from "./deckBuilder";

type ValidationResult = { valid: true } | { valid: false; reason: string };

/**
 * Validate a deck state object for structural correctness.
 * Returns { valid: true } or { valid: false, reason } where reason is for server logging only.
 */
export function validateDeckState(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { valid: false, reason: "not an object" };
  }

  const deck = input as Record<string, unknown>;

  if (!deck.draftId || typeof deck.draftId !== "string") {
    return { valid: false, reason: "missing or invalid draftId" };
  }
  if (
    typeof deck.seat !== "number" ||
    deck.seat < 1 ||
    !Number.isInteger(deck.seat)
  ) {
    return { valid: false, reason: "seat must be a positive integer" };
  }

  if (!deck.zones || typeof deck.zones !== "object") {
    return { valid: false, reason: "missing zones" };
  }
  const zones = deck.zones as Record<string, unknown>;
  for (const zoneName of ["deck", "sideboard"]) {
    if (!zones[zoneName] || typeof zones[zoneName] !== "object") {
      return { valid: false, reason: `missing zones.${zoneName}` };
    }
    const zone = zones[zoneName] as Record<string, unknown>;
    for (const [key, value] of Object.entries(zone)) {
      // The deck reducer only knows the canonical columns; anything else
      // would be stored verbatim and crash clients on load.
      if (!(COLUMN_KEYS as readonly string[]).includes(key)) {
        return {
          valid: false,
          reason: `zones.${zoneName}.${key} is not a recognized column`,
        };
      }
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
        return {
          valid: false,
          reason: `zones.${zoneName}.${key} must be string array`,
        };
      }
    }
  }

  let totalCards = 0;
  for (const zoneName of ["deck", "sideboard"]) {
    const zone = (deck.zones as Record<string, Record<string, string[]>>)[
      zoneName
    ];
    for (const cards of Object.values(zone)) {
      totalCards += cards.length;
    }
  }
  if (totalCards > 100) {
    return {
      valid: false,
      reason: `total cards ${totalCards} exceeds limit of 100`,
    };
  }

  if (deck.basicLands !== undefined) {
    if (typeof deck.basicLands !== "object" || deck.basicLands === null) {
      return { valid: false, reason: "basicLands must be an object" };
    }
    const lands = deck.basicLands as Record<string, unknown>;
    for (const [key, value] of Object.entries(lands)) {
      if (typeof value !== "number" || value < 0 || !Number.isInteger(value)) {
        return {
          valid: false,
          reason: `basicLands.${key} must be a non-negative integer`,
        };
      }
    }
  }

  return { valid: true };
}
