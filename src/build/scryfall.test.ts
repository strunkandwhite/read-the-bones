import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

// Mock fs module before importing modules that use it
vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

import { fetchCard, loadCache, saveCache } from "./scryfall";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/parseSheetRows";

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

// DFC response without top-level colors (as Scryfall actually returns for transform cards)
const mockDfcNoTopLevelColorsResponse = {
  name: "Jace, Vryn's Prodigy // Jace, Telepath Unbound",
  cmc: 2,
  type_line:
    "Legendary Creature — Human Wizard // Legendary Planeswalker — Jace",
  color_identity: ["U"],
  // No top-level colors — Scryfall puts them on card_faces for DFCs
  card_faces: [
    {
      name: "Jace, Vryn's Prodigy",
      mana_cost: "{1}{U}",
      oracle_text: "{T}: Draw a card, then discard a card.",
      colors: ["U"],
      image_uris: {
        normal: "https://cards.scryfall.io/normal/front/jace.jpg",
      },
    },
    {
      name: "Jace, Telepath Unbound",
      mana_cost: "",
      oracle_text: "Back face text",
      colors: ["U"],
      image_uris: {
        normal: "https://cards.scryfall.io/normal/back/jace.jpg",
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

  it("should derive colors from card_faces when top-level colors is missing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => mockDfcNoTopLevelColorsResponse,
    });

    const card = await fetchCard("Jace, Vryn's Prodigy");

    expect(card).not.toBeNull();
    expect(card!.colors).toEqual(["U"]);
    expect(card!.name).toBe("Jace, Vryn's Prodigy // Jace, Telepath Unbound");
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

