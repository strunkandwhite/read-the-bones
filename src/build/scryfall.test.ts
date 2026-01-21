import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

// Mock fs module before importing modules that use it
vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

import { fetchCard, fetchCards, loadCache, saveCache } from "./scryfall";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/parseCsv";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Test cache directory (use absolute paths for memfs)
const TEST_CACHE_DIR = "/cache/test";
const TEST_CACHE_PATH = `${TEST_CACHE_DIR}/scryfall-test.json`;

// Sample Scryfall API responses
const mockLightningBoltResponse = {
  name: "Lightning Bolt",
  mana_cost: "{R}",
  cmc: 1,
  type_line: "Instant",
  colors: ["R"],
  color_identity: ["R"],
  oracle_text: "Lightning Bolt deals 3 damage to any target.",
  image_uris: {
    normal: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
    small: "https://cards.scryfall.io/small/front/lightning-bolt.jpg",
  },
};

const mockCounterspellResponse = {
  name: "Counterspell",
  mana_cost: "{U}{U}",
  cmc: 2,
  type_line: "Instant",
  colors: ["U"],
  color_identity: ["U"],
  oracle_text: "Counter target spell.",
  image_uris: {
    normal: "https://cards.scryfall.io/normal/front/counterspell.jpg",
    small: "https://cards.scryfall.io/small/front/counterspell.jpg",
  },
};

// Double-faced card response (image_uris and oracle_text on card_faces)
const mockDoubleFacedResponse = {
  name: "Delver of Secrets // Insectile Aberration",
  mana_cost: "{U}",
  cmc: 1,
  type_line: "Creature — Human Wizard // Creature — Human Insect",
  colors: ["U"],
  color_identity: ["U"],
  card_faces: [
    {
      oracle_text:
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/delver-front.jpg",
      },
    },
    {
      oracle_text: "Flying",
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/delver-back.jpg",
      },
    },
  ],
};

describe("fetchCard", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should fetch and transform a card from the API", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLightningBoltResponse,
    });

    const card = await fetchCard("Lightning Bolt");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Lightning%20Bolt"
    );
    expect(card).toEqual({
      name: "Lightning Bolt",
      imageUri: "https://cards.scryfall.io/normal/front/lightning-bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    });
  });

  it("should return null for 404 (card not found)", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const card = await fetchCard("Nonexistent Card");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith('[Scryfall] Card not found: "Nonexistent Card"');

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for API errors", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] API error for "Lightning Bolt": 500 Internal Server Error'
    );

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for network errors", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for malformed JSON response", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Invalid JSON");
      },
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] Failed to fetch "Lightning Bolt":',
      expect.any(Error)
    );

    consoleWarn.mockRestore();
  });

  it("should return null and log warning for 429 rate limiting response", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
    });

    const card = await fetchCard("Lightning Bolt");

    expect(card).toBeNull();
    expect(consoleWarn).toHaveBeenCalledWith(
      '[Scryfall] API error for "Lightning Bolt": 429 Too Many Requests'
    );

    consoleWarn.mockRestore();
  });

  it("should handle double-faced cards", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockDoubleFacedResponse,
    });

    const card = await fetchCard("Delver of Secrets");

    expect(card).toEqual({
      name: "Delver of Secrets // Insectile Aberration",
      imageUri: "https://cards.scryfall.io/normal/front/delver-front.jpg",
      manaCost: "{U}",
      manaValue: 1,
      typeLine: "Creature — Human Wizard // Creature — Human Insect",
      colors: ["U"],
      colorIdentity: ["U"],
      oracleText:
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n\nFlying",
    });
  });

  it("should URL-encode special characters in card names", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ...mockLightningBoltResponse,
        name: "Phelia, Exuberant Shepherd",
      }),
    });

    await fetchCard("Phelia, Exuberant Shepherd");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Phelia%2C%20Exuberant%20Shepherd"
    );
  });

  it("should handle cards with missing optional fields", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        name: "Mystery Card",
        // All optional fields missing
      }),
    });

    const card = await fetchCard("Mystery Card");

    expect(card).toEqual({
      name: "Mystery Card",
      imageUri: "",
      manaCost: "",
      manaValue: 0,
      typeLine: "",
      colors: [],
      colorIdentity: [],
      oracleText: "",
    });
  });
});

describe("loadCache", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("should return empty map when cache file does not exist", () => {
    const cache = loadCache(TEST_CACHE_PATH);
    expect(cache.size).toBe(0);
  });

  it("should load cache from existing file", () => {
    const testData: Record<string, ScryCard> = {
      "Lightning Bolt": {
        name: "Lightning Bolt",
        imageUri: "https://example.com/bolt.jpg",
        manaCost: "{R}",
        manaValue: 1,
        typeLine: "Instant",
        colors: ["R"],
        colorIdentity: ["R"],
        oracleText: "Lightning Bolt deals 3 damage to any target.",
      },
    };
    vol.fromJSON({
      [TEST_CACHE_PATH]: JSON.stringify(testData),
    });

    const cache = loadCache(TEST_CACHE_PATH);

    expect(cache.size).toBe(1);
    // Cache uses lowercase keys for case-insensitive lookup
    expect(cache.get(cardNameKey("Lightning Bolt"))).toEqual(testData["Lightning Bolt"]);
  });

  it("should return empty map and warn on invalid JSON", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vol.fromJSON({
      [TEST_CACHE_PATH]: "invalid json {{{",
    });

    const cache = loadCache(TEST_CACHE_PATH);

    expect(cache.size).toBe(0);
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });
});

describe("saveCache", () => {
  beforeEach(() => {
    vol.reset();
  });

  it("should create cache directory if it does not exist", () => {
    const cache = new Map<string, ScryCard>();
    cache.set("Lightning Bolt", {
      name: "Lightning Bolt",
      imageUri: "https://example.com/bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    });

    saveCache(TEST_CACHE_PATH, cache);

    const fsState = vol.toJSON();
    expect(fsState[TEST_CACHE_PATH]).toBeDefined();
  });

  it("should save cache as formatted JSON", () => {
    const cache = new Map<string, ScryCard>();
    const card: ScryCard = {
      name: "Lightning Bolt",
      imageUri: "https://example.com/bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    };
    cache.set("Lightning Bolt", card);

    saveCache(TEST_CACHE_PATH, cache);

    const fsState = vol.toJSON();
    const content = fsState[TEST_CACHE_PATH] as string;
    const parsed = JSON.parse(content);
    expect(parsed["Lightning Bolt"]).toEqual(card);
    // Check it's formatted (has newlines)
    expect(content).toContain("\n");
  });

  it("should overwrite existing cache file", () => {
    vol.fromJSON({
      [TEST_CACHE_PATH]: JSON.stringify({ old: "data" }),
    });

    const cache = new Map<string, ScryCard>();
    cache.set("New Card", {
      name: "New Card",
      imageUri: "",
      manaCost: "",
      manaValue: 0,
      typeLine: "",
      colors: [],
      colorIdentity: [],
      oracleText: "",
    });

    saveCache(TEST_CACHE_PATH, cache);

    const fsState = vol.toJSON();
    const content = fsState[TEST_CACHE_PATH] as string;
    const parsed = JSON.parse(content);
    expect(parsed["old"]).toBeUndefined();
    expect(parsed["New Card"]).toBeDefined();
  });

  it("should log warning when writeFileSync fails", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create a directory at the target path to cause EISDIR error
    const invalidPath = `${TEST_CACHE_DIR}/invalid-target`;
    vol.mkdirSync(invalidPath, { recursive: true });

    const cache = new Map<string, ScryCard>();
    cache.set("Lightning Bolt", {
      name: "Lightning Bolt",
      imageUri: "https://example.com/bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    });

    // This should not throw - it should catch the error and log a warning
    saveCache(invalidPath, cache);

    expect(consoleWarn).toHaveBeenCalledWith(
      `[Scryfall] Failed to save cache to ${invalidPath}:`,
      expect.any(Error)
    );

    consoleWarn.mockRestore();
  });
});

describe("fetchCards", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vol.reset();
  });

  it("should fetch multiple cards with rate limiting", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockLightningBoltResponse,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockCounterspellResponse,
      });

    const startTime = Date.now();
    const result = await fetchCards(["Lightning Bolt", "Counterspell"], TEST_CACHE_PATH);
    const elapsed = Date.now() - startTime;

    // Should have at least one rate-limit delay (~75ms)
    expect(elapsed).toBeGreaterThanOrEqual(70);

    expect(result.size).toBe(2);
    // Result uses lowercase keys for case-insensitive access
    expect(result.get(cardNameKey("Lightning Bolt"))?.name).toBe("Lightning Bolt");
    expect(result.get(cardNameKey("Counterspell"))?.name).toBe("Counterspell");

    consoleLog.mockRestore();
  });

  it("should use cached cards and only fetch missing ones", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Pre-populate cache with Lightning Bolt
    const cachedCard: ScryCard = {
      name: "Lightning Bolt",
      imageUri: "https://cached.example.com/bolt.jpg",
      manaCost: "{R}",
      manaValue: 1,
      typeLine: "Instant",
      colors: ["R"],
      colorIdentity: ["R"],
      oracleText: "Lightning Bolt deals 3 damage to any target.",
    };
    vol.fromJSON({
      [TEST_CACHE_PATH]: JSON.stringify({ "Lightning Bolt": cachedCard }),
    });

    // Only mock one fetch (for Counterspell)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockCounterspellResponse,
    });

    const result = await fetchCards(["Lightning Bolt", "Counterspell"], TEST_CACHE_PATH);

    // Should only have called fetch once (for Counterspell)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Both cards should be in result
    expect(result.size).toBe(2);
    // Cached card should retain cached data (use lowercase key)
    expect(result.get(cardNameKey("Lightning Bolt"))?.imageUri).toBe("https://cached.example.com/bolt.jpg");

    consoleLog.mockRestore();
  });

  it("should deduplicate card names", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLightningBoltResponse,
    });

    const result = await fetchCards(
      ["Lightning Bolt", "Lightning Bolt", "Lightning Bolt"],
      TEST_CACHE_PATH
    );

    // Should only fetch once despite 3 duplicates
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);

    consoleLog.mockRestore();
  });

  it("should handle cards that fail to fetch", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockLightningBoltResponse,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

    const result = await fetchCards(["Lightning Bolt", "Nonexistent Card"], TEST_CACHE_PATH);

    // Only Lightning Bolt should be in result (use lowercase keys)
    expect(result.size).toBe(1);
    expect(result.has(cardNameKey("Lightning Bolt"))).toBe(true);
    expect(result.has(cardNameKey("Nonexistent Card"))).toBe(false);

    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("should save updated cache after fetching", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockLightningBoltResponse,
    });

    await fetchCards(["Lightning Bolt"], TEST_CACHE_PATH);

    // Verify cache was saved
    const fsState = vol.toJSON();
    expect(fsState[TEST_CACHE_PATH]).toBeDefined();
    const parsed = JSON.parse(fsState[TEST_CACHE_PATH] as string);
    expect(parsed["Lightning Bolt"]).toBeDefined();

    consoleLog.mockRestore();
  });

  it("should return empty map for empty input", async () => {
    const result = await fetchCards([], TEST_CACHE_PATH);

    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("should not fetch when all cards are cached", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Pre-populate cache
    const cachedCards: Record<string, ScryCard> = {
      "Lightning Bolt": {
        name: "Lightning Bolt",
        imageUri: "https://example.com/bolt.jpg",
        manaCost: "{R}",
        manaValue: 1,
        typeLine: "Instant",
        colors: ["R"],
        colorIdentity: ["R"],
        oracleText: "Lightning Bolt deals 3 damage to any target.",
      },
      Counterspell: {
        name: "Counterspell",
        imageUri: "https://example.com/counter.jpg",
        manaCost: "{U}{U}",
        manaValue: 2,
        typeLine: "Instant",
        colors: ["U"],
        colorIdentity: ["U"],
        oracleText: "Counter target spell.",
      },
    };
    vol.fromJSON({
      [TEST_CACHE_PATH]: JSON.stringify(cachedCards),
    });

    const result = await fetchCards(["Lightning Bolt", "Counterspell"], TEST_CACHE_PATH);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(2);

    consoleLog.mockRestore();
  });
});
