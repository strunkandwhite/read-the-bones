/**
 * Tests for card code dictionary compression.
 */

import { describe, it, expect } from "vitest";
import {
  generateCardCode,
  buildCardDictionary,
  buildReverseDictionary,
  buildPoolCounts,
  formatCardDict,
  formatPoolCounts,
  encodeCards,
} from "./cardCodes";

// ============================================================================
// generateCardCode - Hash-based code generation
// ============================================================================

describe("generateCardCode", () => {
  it("should generate a 4-character alphanumeric code", () => {
    const code = generateCardCode("Lightning Bolt");
    expect(code).toMatch(/^[0-9a-z]{4}$/);
  });

  it("should be deterministic (same input = same output)", () => {
    const code1 = generateCardCode("Force of Will");
    const code2 = generateCardCode("Force of Will");
    expect(code1).toBe(code2);
  });

  it("should generate different codes for different cards", () => {
    const code1 = generateCardCode("Lightning Bolt");
    const code2 = generateCardCode("Counterspell");
    expect(code1).not.toBe(code2);
  });

  it("should be case-insensitive (same name = same code regardless of case)", () => {
    const code1 = generateCardCode("Lightning Bolt");
    const code2 = generateCardCode("lightning bolt");
    expect(code1).toBe(code2);
  });
});

// ============================================================================
// buildCardDictionary - Dictionary construction
// ============================================================================

describe("buildCardDictionary", () => {
  it("should create a map of code -> fullName", () => {
    const cards = ["Lightning Bolt", "Counterspell", "Force of Will"];
    const dict = buildCardDictionary(cards);

    expect(dict.size).toBe(3);

    // Each value should be a card name
    const values = Array.from(dict.values());
    expect(values).toContain("Lightning Bolt");
    expect(values).toContain("Counterspell");
    expect(values).toContain("Force of Will");
  });

  it("should handle empty input", () => {
    const dict = buildCardDictionary([]);
    expect(dict.size).toBe(0);
  });

  it("should handle duplicate card names by only including once", () => {
    const cards = ["Lightning Bolt", "Lightning Bolt", "Counterspell"];
    const dict = buildCardDictionary(cards);

    // Should dedupe
    const values = Array.from(dict.values());
    const boltCount = values.filter((v) => v === "Lightning Bolt").length;
    expect(boltCount).toBe(1);
  });

  it("should handle split cards like Commit // Memory", () => {
    const cards = ["Commit // Memory", "Fire // Ice"];
    const dict = buildCardDictionary(cards);

    expect(dict.size).toBe(2);
    const values = Array.from(dict.values());
    expect(values).toContain("Commit // Memory");
    expect(values).toContain("Fire // Ice");
  });

  it("should handle hash collisions by generating unique codes", () => {
    // Generate many cards to increase collision probability
    const cards: string[] = [];
    for (let i = 0; i < 200; i++) {
      cards.push(`Test Card ${i}`);
    }
    const dict = buildCardDictionary(cards);

    // All cards should have unique codes
    expect(dict.size).toBe(200);
    const codes = Array.from(dict.keys());
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(200);
  });
});

// ============================================================================
// buildReverseDictionary - Reverse lookup
// ============================================================================

describe("buildReverseDictionary", () => {
  it("should create a map of fullName -> code", () => {
    const cards = ["Lightning Bolt", "Counterspell"];
    const dict = buildCardDictionary(cards);
    const reverse = buildReverseDictionary(dict);

    expect(reverse.size).toBe(2);
    expect(reverse.has("Lightning Bolt")).toBe(true);
    expect(reverse.has("Counterspell")).toBe(true);

    // Codes should match what's in the original dict
    for (const [code, name] of dict) {
      expect(reverse.get(name)).toBe(code);
    }
  });
});

// ============================================================================
// buildPoolCounts - Duplicate tracking
// ============================================================================

describe("buildPoolCounts", () => {
  it("should return empty map when no duplicates", () => {
    const pool = ["Lightning Bolt", "Counterspell", "Force of Will"];
    const counts = buildPoolCounts(pool);
    expect(counts.size).toBe(0);
  });

  it("should track duplicates from numbered cards", () => {
    // Raw pool often has "Card Name 2" for duplicates
    const pool = ["Scalding Tarn", "Scalding Tarn 2", "Flooded Strand"];
    const counts = buildPoolCounts(pool);

    expect(counts.size).toBe(1);
    expect(counts.get("Scalding Tarn")).toBe(2);
  });

  it("should track multiple duplicates", () => {
    const pool = [
      "Lightning Bolt",
      "Lightning Bolt 2",
      "Lightning Bolt 3",
      "Counterspell",
      "Counterspell 2",
    ];
    const counts = buildPoolCounts(pool);

    expect(counts.size).toBe(2);
    expect(counts.get("Lightning Bolt")).toBe(3);
    expect(counts.get("Counterspell")).toBe(2);
  });
});

// ============================================================================
// formatCardDict - Output formatting
// ============================================================================

describe("formatCardDict", () => {
  it("should format dictionary as CARD_DICT section", () => {
    const cards = ["Lightning Bolt"];
    const dict = buildCardDictionary(cards);
    const formatted = formatCardDict(dict);

    expect(formatted).toContain("CARD_DICT:");
    expect(formatted).toContain('"Lightning Bolt"');
  });

  it("should sort codes alphabetically", () => {
    const dict = new Map<string, string>();
    dict.set("zzz1", "Card Z");
    dict.set("aaa1", "Card A");
    dict.set("mmm1", "Card M");

    const formatted = formatCardDict(dict);
    const lines = formatted.split("\n").slice(1); // Skip CARD_DICT: header

    // Should be sorted: aaa1, mmm1, zzz1
    expect(lines[0]).toContain("aaa1");
    expect(lines[1]).toContain("mmm1");
    expect(lines[2]).toContain("zzz1");
  });
});

// ============================================================================
// formatPoolCounts - Duplicate output formatting
// ============================================================================

describe("formatPoolCounts", () => {
  it("should return null when no duplicates", () => {
    const counts = new Map<string, number>();
    const reverseDict = new Map<string, string>();
    const result = formatPoolCounts(counts, reverseDict);
    expect(result).toBeNull();
  });

  it("should format pool counts when duplicates exist", () => {
    const counts = new Map<string, number>();
    counts.set("Scalding Tarn", 2);

    const reverseDict = new Map<string, string>();
    reverseDict.set("Scalding Tarn", "st01");

    const result = formatPoolCounts(counts, reverseDict);
    expect(result).not.toBeNull();
    expect(result).toContain("POOL_COUNTS:");
    expect(result).toContain("st01: 2");
  });
});

// ============================================================================
// encodeCards - Array encoding
// ============================================================================

describe("encodeCards", () => {
  it("should encode card names to codes", () => {
    const cards = ["Lightning Bolt", "Counterspell"];
    const dict = buildCardDictionary(cards);
    const reverse = buildReverseDictionary(dict);

    const encoded = encodeCards(cards, reverse);

    // Each encoded card should be a code that exists in the dict
    for (const code of encoded) {
      expect(dict.has(code)).toBe(true);
    }
  });

  it("should fall back to card name if not in dictionary", () => {
    const reverseDict = new Map<string, string>();
    reverseDict.set("Lightning Bolt", "lb01");

    const cards = ["Lightning Bolt", "Unknown Card"];
    const encoded = encodeCards(cards, reverseDict);

    expect(encoded[0]).toBe("lb01");
    expect(encoded[1]).toBe("Unknown Card"); // Fallback
  });

  it("should preserve order", () => {
    const cards = ["A Card", "B Card", "C Card"];
    const dict = buildCardDictionary(cards);
    const reverse = buildReverseDictionary(dict);

    const encoded = encodeCards(cards, reverse);

    // Verify order by decoding back
    const decoded = encoded.map((code) => dict.get(code));
    expect(decoded).toEqual(cards);
  });
});
