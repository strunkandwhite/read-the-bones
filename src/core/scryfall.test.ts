import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";
import { fetchCard, fetchCards, loadCache, saveCache } from "./scryfall";
import type { ScryCard } from "./types";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Test cache directory
const TEST_CACHE_DIR = "cache/test";
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
    // Clean up test cache directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test cache directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  it("should return empty map when cache file does not exist", () => {
    const cache = loadCache(TEST_CACHE_PATH);
    expect(cache.size).toBe(0);
  });

  it("should load cache from existing file", () => {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
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
    writeFileSync(TEST_CACHE_PATH, JSON.stringify(testData), "utf-8");

    const cache = loadCache(TEST_CACHE_PATH);

    expect(cache.size).toBe(1);
    expect(cache.get("Lightning Bolt")).toEqual(testData["Lightning Bolt"]);
  });

  it("should return empty map and warn on invalid JSON", () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    writeFileSync(TEST_CACHE_PATH, "invalid json {{{", "utf-8");

    const cache = loadCache(TEST_CACHE_PATH);

    expect(cache.size).toBe(0);
    expect(consoleWarn).toHaveBeenCalled();

    consoleWarn.mockRestore();
  });
});

describe("saveCache", () => {
  beforeEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
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

    expect(existsSync(TEST_CACHE_DIR)).toBe(true);
    expect(existsSync(TEST_CACHE_PATH)).toBe(true);
  });

  it("should save cache as formatted JSON", () => {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
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

    const content = readFileSync(TEST_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed["Lightning Bolt"]).toEqual(card);
    // Check it's formatted (has newlines)
    expect(content).toContain("\n");
  });

  it("should overwrite existing cache file", () => {
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
    writeFileSync(TEST_CACHE_PATH, JSON.stringify({ old: "data" }), "utf-8");

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

    const content = readFileSync(TEST_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed["old"]).toBeUndefined();
    expect(parsed["New Card"]).toBeDefined();
  });
});

describe("fetchCards", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
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
    expect(result.get("Lightning Bolt")?.name).toBe("Lightning Bolt");
    expect(result.get("Counterspell")?.name).toBe("Counterspell");

    consoleLog.mockRestore();
  });

  it("should use cached cards and only fetch missing ones", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Pre-populate cache with Lightning Bolt
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
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
    writeFileSync(TEST_CACHE_PATH, JSON.stringify({ "Lightning Bolt": cachedCard }), "utf-8");

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
    // Cached card should retain cached data
    expect(result.get("Lightning Bolt")?.imageUri).toBe("https://cached.example.com/bolt.jpg");

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

    // Only Lightning Bolt should be in result
    expect(result.size).toBe(1);
    expect(result.has("Lightning Bolt")).toBe(true);
    expect(result.has("Nonexistent Card")).toBe(false);

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
    expect(existsSync(TEST_CACHE_PATH)).toBe(true);
    const content = readFileSync(TEST_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(content);
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
    mkdirSync(TEST_CACHE_DIR, { recursive: true });
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
    writeFileSync(TEST_CACHE_PATH, JSON.stringify(cachedCards), "utf-8");

    const result = await fetchCards(["Lightning Bolt", "Counterspell"], TEST_CACHE_PATH);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.size).toBe(2);

    consoleLog.mockRestore();
  });
});
