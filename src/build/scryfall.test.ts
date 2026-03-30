import { describe, it, expect, vi, beforeEach } from "vitest";
import { vol } from "memfs";

vi.mock("fs", async () => {
  const memfs = await import("memfs");
  return memfs.fs;
});

import { loadCache, saveCache } from "./scryfall";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/cardNames";

const TEST_CACHE_DIR = "/cache/test";
const TEST_CACHE_PATH = `${TEST_CACHE_DIR}/scryfall-test.json`;

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
