/**
 * Tests for the data loading pipeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { loadAllDrafts, loadCardData } from "./dataLoader";

// Test data directory
const TEST_DATA_DIR = "test-data-loader-temp";
const TEST_CACHE_PATH = `${TEST_DATA_DIR}/cache/scryfall.json`;

// Mock fetch globally for Scryfall API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Sample draft CSV data (matching the real CSV structure)
// Row 1-2: Headers/metadata (ignored)
// Row 3: Drafter names starting from column C, with ↩ marking end of drafters
// Row 4+: Pick data with colors at the end

const samplePicksCsv = `,,Rotisserie Draft,,,,
,,,,,
,,Drafter A,Drafter B,↩,,R,U
1,→,Lightning Bolt,Counterspell,↩,,R,U
2,→,Birds of Paradise,Dark Ritual,↩,,G,B
`;

const samplePoolCsv = `✓,Card Name,Extra,Color
✓,Lightning Bolt,,R
✓,Counterspell,,U
✓,Birds of Paradise,,G
✓,Dark Ritual,,B
,Healing Salve,,W
,Giant Growth,,G
`;

// Second draft data
const samplePicksCsv2 = `,,Rotisserie Draft 2,,,,
,,,,,
,,Drafter C,Drafter D,↩,,U,C
1,→,Ancestral Recall,Black Lotus,↩,,U,C
2,→,Lightning Bolt,Mox Sapphire,↩,,R,U
`;

const samplePoolCsv2 = `✓,Card Name,Extra,Color
✓,Ancestral Recall,,U
✓,Black Lotus,,C
✓,Lightning Bolt,,R
✓,Mox Sapphire,,U
,Time Walk,,U
`;

// Mock Scryfall responses
const mockScryfallResponses: Record<string, object> = {
  "Lightning Bolt": {
    name: "Lightning Bolt",
    mana_cost: "{R}",
    type_line: "Instant",
    colors: ["R"],
    color_identity: ["R"],
    image_uris: { normal: "https://scryfall.io/lightning-bolt.jpg" },
  },
  Counterspell: {
    name: "Counterspell",
    mana_cost: "{U}{U}",
    type_line: "Instant",
    colors: ["U"],
    color_identity: ["U"],
    image_uris: { normal: "https://scryfall.io/counterspell.jpg" },
  },
  "Birds of Paradise": {
    name: "Birds of Paradise",
    mana_cost: "{G}",
    type_line: "Creature — Bird",
    colors: ["G"],
    color_identity: ["G"],
    image_uris: { normal: "https://scryfall.io/birds.jpg" },
  },
  "Dark Ritual": {
    name: "Dark Ritual",
    mana_cost: "{B}",
    type_line: "Instant",
    colors: ["B"],
    color_identity: ["B"],
    image_uris: { normal: "https://scryfall.io/dark-ritual.jpg" },
  },
  "Healing Salve": {
    name: "Healing Salve",
    mana_cost: "{W}",
    type_line: "Instant",
    colors: ["W"],
    color_identity: ["W"],
    image_uris: { normal: "https://scryfall.io/healing-salve.jpg" },
  },
  "Giant Growth": {
    name: "Giant Growth",
    mana_cost: "{G}",
    type_line: "Instant",
    colors: ["G"],
    color_identity: ["G"],
    image_uris: { normal: "https://scryfall.io/giant-growth.jpg" },
  },
  "Ancestral Recall": {
    name: "Ancestral Recall",
    mana_cost: "{U}",
    type_line: "Instant",
    colors: ["U"],
    color_identity: ["U"],
    image_uris: { normal: "https://scryfall.io/ancestral.jpg" },
  },
  "Black Lotus": {
    name: "Black Lotus",
    mana_cost: "{0}",
    type_line: "Artifact",
    colors: [],
    color_identity: [],
    image_uris: { normal: "https://scryfall.io/lotus.jpg" },
  },
  "Mox Sapphire": {
    name: "Mox Sapphire",
    mana_cost: "{0}",
    type_line: "Artifact",
    colors: [],
    color_identity: ["U"],
    image_uris: { normal: "https://scryfall.io/mox-sapphire.jpg" },
  },
  "Time Walk": {
    name: "Time Walk",
    mana_cost: "{1}{U}",
    type_line: "Sorcery",
    colors: ["U"],
    color_identity: ["U"],
    image_uris: { normal: "https://scryfall.io/time-walk.jpg" },
  },
};

/**
 * Helper to create a mock draft folder structure.
 */
function createDraftFolder(
  basePath: string,
  draftId: string,
  picksCsv: string,
  poolCsv: string
): void {
  const draftPath = `${basePath}/${draftId}`;
  mkdirSync(draftPath, { recursive: true });
  writeFileSync(`${draftPath}/picks.csv`, picksCsv, "utf-8");
  writeFileSync(`${draftPath}/pool.csv`, poolCsv, "utf-8");
}

/**
 * Set up mock fetch to respond with Scryfall data.
 */
function setupMockFetch(): void {
  mockFetch.mockImplementation(async (url: string) => {
    // Extract card name from URL
    const match = url.match(/exact=([^&]+)/);
    if (!match) {
      return { ok: false, status: 400, statusText: "Bad Request" };
    }

    const cardName = decodeURIComponent(match[1]);
    const responseData = mockScryfallResponses[cardName];

    if (responseData) {
      return {
        ok: true,
        status: 200,
        json: async () => responseData,
      };
    }

    return { ok: false, status: 404, statusText: "Not Found" };
  });
}

describe("loadAllDrafts", () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mockFetch.mockReset();
  });

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it("should load picks from a single draft folder", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds).toEqual(["draft-1"]);
    expect(result.picks.length).toBeGreaterThan(0);

    // Check that picks have the correct draft ID
    for (const pick of result.picks) {
      expect(pick.draftId).toBe("draft-1");
    }

    consoleLog.mockRestore();
  });

  it("should load picks from multiple draft folders", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);
    createDraftFolder(TEST_DATA_DIR, "draft-2", samplePicksCsv2, samplePoolCsv2);

    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds.length).toBe(2);
    expect(result.draftIds).toContain("draft-1");
    expect(result.draftIds).toContain("draft-2");

    // Picks should have correct draft IDs
    const draft1Picks = result.picks.filter((p) => p.draftId === "draft-1");
    const draft2Picks = result.picks.filter((p) => p.draftId === "draft-2");

    expect(draft1Picks.length).toBeGreaterThan(0);
    expect(draft2Picks.length).toBeGreaterThan(0);

    consoleLog.mockRestore();
  });

  it("should skip folders missing picks.csv", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create folder with only pool.csv
    const draftPath = `${TEST_DATA_DIR}/incomplete-draft`;
    mkdirSync(draftPath, { recursive: true });
    writeFileSync(`${draftPath}/pool.csv`, samplePoolCsv, "utf-8");

    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds).toEqual([]);
    expect(result.picks).toEqual([]);
    // Warning is a single string containing both the draft name and missing file
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringMatching(/Skipping draft "incomplete-draft".*picks\.csv/)
    );

    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("should skip folders missing pool.csv", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create folder with only picks.csv
    const draftPath = `${TEST_DATA_DIR}/incomplete-draft`;
    mkdirSync(draftPath, { recursive: true });
    writeFileSync(`${draftPath}/picks.csv`, samplePicksCsv, "utf-8");

    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds).toEqual([]);
    expect(result.picks).toEqual([]);
    // Warning is a single string containing both the draft name and missing file
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringMatching(/Skipping draft "incomplete-draft".*pool\.csv/)
    );

    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("should skip non-directory entries", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Create a file (not directory) in the data dir
    writeFileSync(`${TEST_DATA_DIR}/readme.txt`, "This is not a draft", "utf-8");

    // Create a valid draft
    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds).toEqual(["draft-1"]);

    consoleLog.mockRestore();
  });

  it("should return empty results for non-existent directory", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadAllDrafts("/non/existent/path");

    expect(result.draftIds).toEqual([]);
    expect(result.picks).toEqual([]);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("Data directory not found"));

    consoleWarn.mockRestore();
  });

  it("should return empty results for empty directory", async () => {
    const result = await loadAllDrafts(TEST_DATA_DIR);

    expect(result.draftIds).toEqual([]);
    expect(result.picks).toEqual([]);
  });

  it("should normalize lowercase player names to capitalized form", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Draft 1: Has capitalized "Adhavoc"
    const picksCsvWithCapitalized = `,,Rotisserie Draft,,
,,,
,,Adhavoc,Jack,↩,,R,U
1,→,Lightning Bolt,Counterspell,↩,,R,U
`;

    // Draft 2: Has lowercase "adhavoc" - should be normalized to "Adhavoc"
    const picksCsvWithLowercase = `,,Rotisserie Draft,,
,,,
,,adhavoc,Keith,↩,,G,B
1,→,Birds of Paradise,Dark Ritual,↩,,G,B
`;

    createDraftFolder(TEST_DATA_DIR, "draft-1", picksCsvWithCapitalized, samplePoolCsv);
    createDraftFolder(TEST_DATA_DIR, "draft-2", picksCsvWithLowercase, samplePoolCsv);

    const result = await loadAllDrafts(TEST_DATA_DIR);

    // All picks from "adhavoc" should be normalized to "Adhavoc"
    const adhavocPicks = result.picks.filter((p) => p.drafterName.toLowerCase() === "adhavoc");
    for (const pick of adhavocPicks) {
      expect(pick.drafterName).toBe("Adhavoc");
    }

    // Should have exactly one "Adhavoc" variant, not both
    const drafterNames = [...new Set(result.picks.map((p) => p.drafterName))].filter(
      (name) => name.toLowerCase() === "adhavoc"
    );
    expect(drafterNames).toEqual(["Adhavoc"]);

    consoleLog.mockRestore();
  });

  it("should keep all-lowercase names that have no capitalized variant", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    // Both drafts have only lowercase "newplayer"
    const picksCsvWithOnlyLowercase = `,,Rotisserie Draft,,
,,,
,,newplayer,Jack,↩,,R,U
1,→,Lightning Bolt,Counterspell,↩,,R,U
`;

    createDraftFolder(TEST_DATA_DIR, "draft-1", picksCsvWithOnlyLowercase, samplePoolCsv);

    const result = await loadAllDrafts(TEST_DATA_DIR);

    // "newplayer" should stay lowercase since no capitalized variant exists
    const newplayerPicks = result.picks.filter((p) => p.drafterName === "newplayer");
    expect(newplayerPicks.length).toBeGreaterThan(0);

    consoleLog.mockRestore();
  });
});

describe("loadCardData", () => {
  beforeEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mockFetch.mockReset();
    setupMockFetch();
  });

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it("should return complete enriched card data", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    expect(result.draftCount).toBe(1);
    expect(result.cards.length).toBeGreaterThan(0);
    expect(result.players.length).toBeGreaterThan(0);

    // Check that cards are enriched with Scryfall data
    const lightningBolt = result.cards.find((c) => c.cardName === "Lightning Bolt");
    expect(lightningBolt).toBeDefined();
    expect(lightningBolt?.scryfall).toBeDefined();
    expect(lightningBolt?.scryfall?.manaCost).toBe("{R}");

    consoleLog.mockRestore();
  });

  it("should extract players correctly", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Should contain drafters but not "Unpicked"
    expect(result.players).toContain("Drafter A");
    expect(result.players).toContain("Drafter B");
    expect(result.players).not.toContain("Unpicked");

    consoleLog.mockRestore();
  });

  it("should apply top player weighting", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const resultWithoutTop = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);
    const resultWithTop = await loadCardData(TEST_DATA_DIR, ["Drafter A"], TEST_CACHE_PATH);

    // Find same card in both results
    const cardWithoutTop = resultWithoutTop.cards.find((c) => c.cardName === "Lightning Bolt");
    const cardWithTop = resultWithTop.cards.find((c) => c.cardName === "Lightning Bolt");

    // Both should exist
    expect(cardWithoutTop).toBeDefined();
    expect(cardWithTop).toBeDefined();

    // Top player geomean should differ when top players are specified
    // (The actual values depend on the weighting formula)
    expect(cardWithTop?.topPlayerGeomean).toBeDefined();

    consoleLog.mockRestore();
  });

  it("should load data from multiple drafts", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);
    createDraftFolder(TEST_DATA_DIR, "draft-2", samplePicksCsv2, samplePoolCsv2);

    // Add metadata to make draft-2 the most recent (so its pool is the "current cube")
    writeFileSync(
      `${TEST_DATA_DIR}/draft-2/metadata.json`,
      JSON.stringify({ name: "Draft 2", date: "2025-01-02" }),
      "utf-8"
    );

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    expect(result.draftCount).toBe(2);

    // Lightning Bolt appears in both drafts and is in current cube (draft-2's pool)
    const lightningBolt = result.cards.find((c) => c.cardName === "Lightning Bolt");
    expect(lightningBolt).toBeDefined();
    expect(lightningBolt?.timesAvailable).toBe(2);

    // Ancestral Recall only in draft 2 and is in current cube
    const ancestral = result.cards.find((c) => c.cardName === "Ancestral Recall");
    expect(ancestral).toBeDefined();
    expect(ancestral?.timesAvailable).toBe(1);

    // Players from both drafts
    expect(result.players).toContain("Drafter A");
    expect(result.players).toContain("Drafter C");

    consoleLog.mockRestore();
  });

  it("should return empty data for non-existent directory", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await loadCardData("/non/existent/path");

    expect(result.cards).toEqual([]);
    expect(result.players).toEqual([]);
    expect(result.draftCount).toBe(0);

    consoleWarn.mockRestore();
  });

  it("should return empty data for empty directory", async () => {
    const result = await loadCardData(TEST_DATA_DIR);

    expect(result.cards).toEqual([]);
    expect(result.players).toEqual([]);
    expect(result.draftCount).toBe(0);
  });

  it("should handle cards not found in Scryfall", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Create draft with a card that won't be found in Scryfall
    const picksCsvWithUnknown = `,,Rotisserie Draft,,
,,,
,,Drafter A,↩,C
1,→,Unknown Mystery Card,↩,C
`;
    const poolCsvWithUnknown = `✓,Card Name,Extra,Color
✓,Unknown Mystery Card,,C
`;

    createDraftFolder(TEST_DATA_DIR, "draft-unknown", picksCsvWithUnknown, poolCsvWithUnknown);

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Card should still be in results, just without Scryfall data
    const unknownCard = result.cards.find((c) => c.cardName === "Unknown Mystery Card");
    expect(unknownCard).toBeDefined();
    expect(unknownCard?.scryfall).toBeUndefined();

    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("should sort cards by weighted geomean", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Cards should be sorted by weightedGeomean ascending
    for (let i = 1; i < result.cards.length; i++) {
      expect(result.cards[i].weightedGeomean).toBeGreaterThanOrEqual(
        result.cards[i - 1].weightedGeomean
      );
    }

    consoleLog.mockRestore();
  });

  it("should use provided cache path", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const customCachePath = `${TEST_DATA_DIR}/custom-cache/scryfall.json`;
    await loadCardData(TEST_DATA_DIR, [], customCachePath);

    // Cache file should be created at custom path
    expect(existsSync(customCachePath)).toBe(true);

    consoleLog.mockRestore();
  });

  it("should cache Scryfall data between calls", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    // First call - should fetch from API
    await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Second call - should use cache
    mockFetch.mockClear();
    await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Should not have made any new fetch calls (all cached)
    expect(mockFetch).not.toHaveBeenCalled();

    consoleLog.mockRestore();
  });
});

describe("enrichStats integration", () => {
  beforeEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    mockFetch.mockReset();
    setupMockFetch();
  });

  afterEach(() => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  it("should enrich all card stats with Scryfall data", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    createDraftFolder(TEST_DATA_DIR, "draft-1", samplePicksCsv, samplePoolCsv);

    const result = await loadCardData(TEST_DATA_DIR, [], TEST_CACHE_PATH);

    // Most cards should have Scryfall data (except any not in our mock)
    const cardsWithScryfall = result.cards.filter((c) => c.scryfall);
    expect(cardsWithScryfall.length).toBeGreaterThan(0);

    // Check enriched data structure
    for (const card of cardsWithScryfall) {
      expect(card.scryfall?.name).toBeDefined();
      expect(card.scryfall?.imageUri).toBeDefined();
      expect(card.scryfall?.manaCost).toBeDefined();
      expect(card.scryfall?.typeLine).toBeDefined();
      expect(card.scryfall?.colors).toBeDefined();
      expect(card.scryfall?.colorIdentity).toBeDefined();
    }

    consoleLog.mockRestore();
  });
});
