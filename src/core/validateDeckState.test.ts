import { describe, it, expect } from "vitest";
import { validateDeckState } from "./validateDeckState";

function validDeck() {
  return {
    draftId: "tarkir",
    seat: 1,
    zones: {
      deck: { "mv-0-1": ["Lightning Bolt", "Counterspell"] } as Record<string, string[]>,
      sideboard: { "mv-0-1": ["Dark Ritual"] } as Record<string, string[]>,
    },
    basicLands: { Plains: 0, Island: 5, Swamp: 0, Mountain: 3, Forest: 0 },
  };
}

describe("validateDeckState", () => {
  it("accepts a valid deck state", () => {
    expect(validateDeckState(validDeck())).toEqual({ valid: true });
  });

  it("accepts valid deck with optional fields omitted", () => {
    const deck = { draftId: "tarkir", seat: 2, zones: { deck: {}, sideboard: {} } };
    expect(validateDeckState(deck)).toEqual({ valid: true });
  });

  it("rejects null", () => {
    expect(validateDeckState(null)).toEqual({ valid: false, reason: "not an object" });
  });

  it("rejects non-object input", () => {
    expect(validateDeckState("hello")).toEqual({ valid: false, reason: "not an object" });
    expect(validateDeckState(42)).toEqual({ valid: false, reason: "not an object" });
    expect(validateDeckState(undefined)).toEqual({ valid: false, reason: "not an object" });
  });

  it("rejects missing draftId", () => {
    const deck = validDeck();
    delete (deck as Record<string, unknown>).draftId;
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "missing or invalid draftId" });
  });

  it("rejects non-string draftId", () => {
    const deck = { ...validDeck(), draftId: 123 };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "missing or invalid draftId" });
  });

  it("rejects non-number seat", () => {
    const deck = { ...validDeck(), seat: "one" };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "seat must be a positive integer" });
  });

  it("rejects negative seat", () => {
    const deck = { ...validDeck(), seat: -1 };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "seat must be a positive integer" });
  });

  it("rejects zero seat", () => {
    const deck = { ...validDeck(), seat: 0 };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "seat must be a positive integer" });
  });

  it("rejects non-integer seat", () => {
    const deck = { ...validDeck(), seat: 1.5 };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "seat must be a positive integer" });
  });

  it("rejects missing zones", () => {
    const deck = validDeck();
    delete (deck as Record<string, unknown>).zones;
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "missing zones" });
  });

  it("rejects missing zones.deck", () => {
    const deck = validDeck();
    delete (deck.zones as Record<string, unknown>).deck;
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "missing zones.deck" });
  });

  it("rejects missing zones.sideboard", () => {
    const deck = validDeck();
    delete (deck.zones as Record<string, unknown>).sideboard;
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "missing zones.sideboard" });
  });

  it("rejects non-string-array column values", () => {
    const deck = validDeck();
    (deck.zones.deck as Record<string, unknown>)["mv-2"] = [1, 2, 3];
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "zones.deck.mv-2 must be string array" });
  });

  it("rejects unrecognized column keys", () => {
    const deck = validDeck();
    (deck.zones.deck as Record<string, unknown>).creatures = ["Baleful Strix"];
    const result = validateDeckState(deck);
    expect(result).toEqual({
      valid: false,
      reason: "zones.deck.creatures is not a recognized column",
    });
  });

  it("rejects legacy cmc-* column keys on write", () => {
    const deck = validDeck();
    (deck.zones.sideboard as Record<string, unknown>)["cmc-2"] = ["Counterspell"];
    const result = validateDeckState(deck);
    expect(result).toEqual({
      valid: false,
      reason: "zones.sideboard.cmc-2 is not a recognized column",
    });
  });

  it("accepts all canonical column keys", () => {
    const deck = validDeck();
    deck.zones.deck = {
      "mv-0-1": [],
      "mv-2": [],
      "mv-3": [],
      "mv-4": [],
      "mv-5": [],
      "mv-6+": ["Griselbrand"],
      lands: ["Tundra"],
    };
    expect(validateDeckState(deck)).toEqual({ valid: true });
  });

  it("accepts deck with exactly 100 total cards (boundary — limit is inclusive)", () => {
    const deck = validDeck();
    deck.zones.deck["mv-0-1"] = Array.from({ length: 100 }, (_, i) => `Card ${i}`);
    deck.zones.sideboard = { "mv-0-1": [] };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: true });
  });

  it("rejects deck with > 100 total cards", () => {
    const deck = validDeck();
    deck.zones.deck["mv-0-1"] = Array.from({ length: 101 }, (_, i) => `Card ${i}`);
    deck.zones.sideboard = { "mv-0-1": [] };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "total cards 101 exceeds limit of 100" });
  });

  it("rejects negative basicLand counts", () => {
    const deck = { ...validDeck(), basicLands: { Plains: -1 } };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "basicLands.Plains must be a non-negative integer" });
  });

  it("rejects non-integer basicLand counts", () => {
    const deck = { ...validDeck(), basicLands: { Island: 2.5 } };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "basicLands.Island must be a non-negative integer" });
  });

  it("rejects non-object basicLands", () => {
    const deck = { ...validDeck(), basicLands: "not-an-object" };
    const result = validateDeckState(deck);
    expect(result).toEqual({ valid: false, reason: "basicLands must be an object" });
  });
});
