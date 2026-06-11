import { describe, it, expect } from "vitest";
import { serializeScryfallEntry, resolveCardNamesToCache } from "./serializeScryfall";
import type { ScryCard } from "../../types";

describe("serializeScryfallEntry", () => {
  it("serializes a complete card to snake_case JSON", () => {
    const card: ScryCard = {
      name: "Lightning Bolt",
      imageUri: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    };

    const json = serializeScryfallEntry(card);
    const parsed = JSON.parse(json);

    expect(parsed).toEqual({
      name: "Lightning Bolt",
      color_identity: ["R"],
      colors: ["R"],
      type_line: "Instant",
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      mana_cost: "{R}",
      cmc: 1,
      image_uris: { normal: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg" },
    });
  });

  it("omits image_uris when imageUri is empty string", () => {
    const card: ScryCard = {
      name: "Phantom Card",
      imageUri: "",
      manaCost: "",
      manaValue: 0,
      typeLine: "",
      colors: [],
      colorIdentity: [],
      oracleText: "",
    };

    const json = serializeScryfallEntry(card);
    const parsed = JSON.parse(json);

    expect(parsed.image_uris).toBeUndefined();
  });

  it("serializes multi-color cards", () => {
    const card: ScryCard = {
      name: "Teferi, Hero of Dominaria",
      imageUri: "https://cards.scryfall.io/normal/front/teferi.jpg",
      manaCost: "{3}{W}{U}",
      manaValue: 5,
      typeLine: "Legendary Planeswalker — Teferi",
      colors: ["W", "U"],
      colorIdentity: ["W", "U"],
      oracleText: "+1: Draw a card. At the beginning of the next end step, untap two lands.",
    };

    const json = serializeScryfallEntry(card);
    const parsed = JSON.parse(json);

    expect(parsed.colors).toEqual(["W", "U"]);
    expect(parsed.color_identity).toEqual(["W", "U"]);
    expect(parsed.cmc).toBe(5);
  });
});

describe("resolveCardNamesToCache", () => {
  function makeCache() {
    const nameToId = new Map<string, number>();
    const missing: Array<{ name: string; oracleId: string; scryfallJson: string | null }> = [];
    return {
      get: (name: string) => nameToId.get(name.toLowerCase()),
      set: (name: string, id: number) => { nameToId.set(name.toLowerCase(), id); },
      markMissing: (name: string, oracleId: string, scryfallJson: string | null) => {
        missing.push({ name, oracleId, scryfallJson });
      },
      getMissing: () => missing,
      // Satisfy the interface for flushMissing (not called in these tests)
      flushMissing: async () => {},
      size: 0,
    };
  }

  const mockScryfallCache = new Map<string, ScryCard>([
    ["lightning bolt", {
      name: "Lightning Bolt",
      imageUri: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    }],
  ]);

  it("skips names already in the card cache", () => {
    const cache = makeCache();
    cache.set("Lightning Bolt", 42);

    resolveCardNamesToCache(["Lightning Bolt"], cache as never, mockScryfallCache);

    expect(cache.getMissing()).toHaveLength(0);
  });

  it("marks card as missing with scryfall JSON when found in scryfall cache", () => {
    const cache = makeCache();

    resolveCardNamesToCache(["Lightning Bolt"], cache as never, mockScryfallCache);

    const missing = cache.getMissing();
    expect(missing).toHaveLength(1);
    expect(missing[0].name).toBe("Lightning Bolt");

    const parsed = JSON.parse(missing[0].scryfallJson!);
    expect(parsed.name).toBe("Lightning Bolt");
    expect(parsed.mana_cost).toBe("{R}");
  });

  it("marks card as missing with null JSON when not in scryfall cache", () => {
    const cache = makeCache();

    resolveCardNamesToCache(["Force of Will"], cache as never, mockScryfallCache);

    const missing = cache.getMissing();
    expect(missing).toHaveLength(1);
    expect(missing[0].name).toBe("Force of Will");
    expect(missing[0].scryfallJson).toBeNull();
  });

  it("processes multiple names in one call", () => {
    const cache = makeCache();

    resolveCardNamesToCache(
      ["Lightning Bolt", "Force of Will"],
      cache as never,
      mockScryfallCache,
    );

    const missing = cache.getMissing();
    expect(missing).toHaveLength(2);
    expect(missing.map(m => m.name).sort()).toEqual(["Force of Will", "Lightning Bolt"]);
  });
});
