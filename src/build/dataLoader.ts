/**
 * Data loading pipeline that combines CSV parsing, stats calculation,
 * and Scryfall enrichment into a single unified flow.
 *
 * This module is designed to run at build time in Next.js.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type {
  CardPick,
  CardStats,
  DraftMetadata,
  DraftScore,
  EnrichedCardStats,
  ScryCard,
} from "../core/types";
import { parseDraft, isDraftComplete, parsePool, buildPlayerNameMap, normalizePlayerName } from "../core/parseCsv";
import { parseMatches, aggregatePlayerStats, PlayerMatchStats, MatchResult } from "../core/parseMatches";
import { calculateCardStats, extractPlayers, DISTRIBUTION_BUCKET_COUNT } from "../core/calculateStats";
import { calculateWinEquity, calculateRawWinRate } from "../core/winEquity";
import { fetchCards } from "./scryfall";

/**
 * Load metadata.json from a draft folder.
 * Returns default metadata if file doesn't exist.
 */
function loadDraftMetadata(draftPath: string, draftId: string): DraftMetadata {
  const metadataPath = join(draftPath, "metadata.json");

  if (existsSync(metadataPath)) {
    try {
      const content = readFileSync(metadataPath, "utf-8");
      const data = JSON.parse(content);
      return {
        draftId,
        name: data.name || draftId,
        date: data.date || "1970-01-01",
      };
    } catch {
      console.warn(`[DataLoader] Failed to parse metadata for "${draftId}"`);
    }
  }

  // Default metadata if file doesn't exist
  return {
    draftId,
    name: draftId,
    date: "1970-01-01",
  };
}

/**
 * Find the most recent draft's pool.csv path by metadata.json date.
 *
 * @param dataDir - Path to the data directory containing draft folders
 * @returns Object with path and date, or null if no drafts found
 */
function findMostRecentPool(dataDir: string): { path: string; date: string } | null {
  if (!existsSync(dataDir)) {
    return null;
  }

  const entries = readdirSync(dataDir);
  let mostRecentDate = "";
  let mostRecentPath = "";

  for (const entry of entries) {
    const entryPath = join(dataDir, entry);

    if (!statSync(entryPath).isDirectory()) {
      continue;
    }

    const poolPath = join(entryPath, "pool.csv");
    if (!existsSync(poolPath)) {
      continue;
    }

    const metadata = loadDraftMetadata(entryPath, entry);
    if (metadata.date > mostRecentDate) {
      mostRecentDate = metadata.date;
      mostRecentPath = poolPath;
    }
  }

  if (!mostRecentPath) {
    return null;
  }

  return { path: mostRecentPath, date: mostRecentDate };
}

/**
 * Get the card names in the current cube (most recent draft's pool).
 *
 * @param dataDir - Path to the data directory containing draft folders
 * @returns Set of card names in the current cube (empty if no drafts found)
 */
export function getCurrentCubeCards(dataDir: string): Set<string> {
  const recent = findMostRecentPool(dataDir);
  if (!recent) {
    return new Set();
  }

  const poolCsv = readFileSync(recent.path, "utf-8");
  const cards = parsePool(poolCsv);

  console.log(`[DataLoader] Current cube: ${cards.length} cards (from ${recent.date})`);
  return new Set(cards);
}

/**
 * Get copy counts for cards in the current cube (most recent draft's pool).
 *
 * @param dataDir - Path to the data directory containing draft folders
 * @returns Map of card names to copy counts (empty if no drafts found)
 */
export function getCurrentCubeCopies(dataDir: string): Map<string, number> {
  const recent = findMostRecentPool(dataDir);
  if (!recent) {
    return new Map();
  }

  const poolCsv = readFileSync(recent.path, "utf-8");
  const cards = parsePool(poolCsv);

  const copyCount = new Map<string, number>();
  for (const cardName of cards) {
    copyCount.set(cardName, (copyCount.get(cardName) || 0) + 1);
  }

  return copyCount;
}

/** Options for loading drafts */
export type LoadDraftsOptions = {
  /** Suppress console output (default: false) */
  quiet?: boolean;
};

/**
 * Load all drafts from a data directory.
 *
 * Scans the directory for subfolders, each representing a draft.
 * Each draft folder must contain both picks.csv and pool.csv.
 * Folders missing either file are skipped with a warning.
 *
 * @param dataDir - Path to the data directory containing draft folders
 * @param options - Optional settings (quiet mode)
 * @returns Object with all picks, draft IDs, and draft metadata
 */
export async function loadAllDrafts(
  dataDir: string,
  options?: LoadDraftsOptions
): Promise<{
  picks: CardPick[];
  draftIds: string[];
  draftMetadata: Map<string, DraftMetadata>;
  matchStats: Map<string, Map<string, PlayerMatchStats>>;
  rawMatches: Map<string, MatchResult[]>;
}> {
  const quiet = options?.quiet ?? false;
  const allPicks: CardPick[] = [];
  const draftIds: string[] = [];
  const draftMetadata = new Map<string, DraftMetadata>();
  const matchStats = new Map<string, Map<string, PlayerMatchStats>>();
  const rawMatches = new Map<string, MatchResult[]>();

  // Check if data directory exists
  if (!existsSync(dataDir)) {
    if (!quiet) console.warn(`[DataLoader] Data directory not found: ${dataDir}`);
    return { picks: [], draftIds: [], draftMetadata: new Map(), matchStats: new Map(), rawMatches: new Map() };
  }

  // Get all entries in the data directory
  const entries = readdirSync(dataDir);

  for (const entry of entries) {
    const entryPath = join(dataDir, entry);

    // Skip if not a directory
    if (!statSync(entryPath).isDirectory()) {
      continue;
    }

    const picksPath = join(entryPath, "picks.csv");
    const poolPath = join(entryPath, "pool.csv");

    // Check for required files
    const hasPicksCsv = existsSync(picksPath);
    const hasPoolCsv = existsSync(poolPath);

    if (!hasPicksCsv || !hasPoolCsv) {
      const missing = [];
      if (!hasPicksCsv) missing.push("picks.csv");
      if (!hasPoolCsv) missing.push("pool.csv");
      if (!quiet) {
        console.warn(`[DataLoader] Skipping draft "${entry}": missing ${missing.join(", ")}`);
      }
      continue;
    }

    // Read and parse the draft
    try {
      const picksCsv = readFileSync(picksPath, "utf-8");
      const poolCsv = readFileSync(poolPath, "utf-8");

      // Skip incomplete drafts (in-progress drafts shouldn't count for stats)
      if (!isDraftComplete(picksCsv)) {
        if (!quiet) {
          console.warn(`[DataLoader] Skipping draft "${entry}": incomplete (has empty pick cells)`);
        }
        continue;
      }

      const { picks, numDrafters } = parseDraft(picksCsv, poolCsv, entry);

      // Load metadata for this draft
      const metadata = loadDraftMetadata(entryPath, entry);
      // Add numDrafters to metadata
      metadata.numDrafters = numDrafters;

      allPicks.push(...picks);
      draftIds.push(entry);
      draftMetadata.set(entry, metadata);

      // Load matches.csv if present (optional - not all drafts have match data)
      const matchesPath = join(entryPath, "matches.csv");
      if (existsSync(matchesPath)) {
        try {
          const matchesCsv = readFileSync(matchesPath, "utf-8");
          const matches = parseMatches(matchesCsv);
          const playerStats = aggregatePlayerStats(matches);
          matchStats.set(entry, playerStats);
          rawMatches.set(entry, matches);
          if (!quiet) {
            console.log(
              `[DataLoader] Loaded matches for "${entry}": ${matches.length} matches, ${playerStats.size} players`
            );
          }
        } catch (matchError) {
          if (!quiet) {
            console.warn(`[DataLoader] Failed to parse matches for "${entry}":`, matchError);
          }
        }
      }

      if (!quiet) {
        console.log(
          `[DataLoader] Loaded draft "${entry}" (${metadata.date}): ${picks.length} picks`
        );
      }
    } catch (error) {
      if (!quiet) {
        console.warn(`[DataLoader] Failed to parse draft "${entry}":`, error);
      }
    }
  }

  // Normalize player names: lowercase variants -> canonical capitalized form
  // Collect all player names from both picks and match stats
  const allPlayerNames: string[] = allPicks.map((p) => p.drafterName);
  for (const playerStats of matchStats.values()) {
    for (const playerName of playerStats.keys()) {
      allPlayerNames.push(playerName);
    }
  }
  const canonicalNameMap = buildPlayerNameMap(allPlayerNames);

  // Apply normalization to all picks
  for (const pick of allPicks) {
    pick.drafterName = normalizePlayerName(pick.drafterName, canonicalNameMap);
  }

  // Also normalize player names in match stats
  for (const [draftId, playerStats] of matchStats) {
    const normalizedStats = new Map<string, PlayerMatchStats>();
    for (const [playerName, stats] of playerStats) {
      const normalizedName = normalizePlayerName(playerName, canonicalNameMap);
      // Merge stats if same normalized name appears multiple times
      const existing = normalizedStats.get(normalizedName);
      if (existing) {
        existing.gamesWon += stats.gamesWon;
        existing.gamesLost += stats.gamesLost;
      } else {
        normalizedStats.set(normalizedName, { ...stats });
      }
    }
    matchStats.set(draftId, normalizedStats);
  }

  return { picks: allPicks, draftIds, draftMetadata, matchStats, rawMatches };
}

/**
 * Enrich card stats with Scryfall data.
 *
 * @param stats - Array of card stats to enrich
 * @param scryfallData - Map of card names to Scryfall data
 * @returns Array of enriched card stats
 */
function enrichStats(stats: CardStats[], scryfallData: Map<string, ScryCard>): EnrichedCardStats[] {
  return stats.map((stat) => {
    const scryfall = scryfallData.get(stat.cardName);
    return {
      ...stat,
      scryfall,
    };
  });
}

/**
 * Main data loading pipeline.
 *
 * Loads all drafts from the data directory, calculates stats,
 * and enriches with Scryfall data.
 *
 * Data flow:
 *   [CSV files] -> parse -> [CardPick[]]
 *   -> aggregate + calculate geomean -> [CardStats[]]
 *   -> enrich with Scryfall -> [EnrichedCardStats[]]
 *
 * @param dataDir - Path to the data directory containing draft folders
 * @param topPlayers - Optional list of player names to weight more heavily
 * @param cachePath - Optional path to Scryfall cache file
 * @returns Object with enriched card stats, player list, and draft count
 */
export async function loadCardData(
  dataDir: string,
  topPlayers: string[] = [],
  cachePath?: string
): Promise<{
  cards: EnrichedCardStats[];
  players: string[];
  draftCount: number;
  currentCubeCards: string[];
  currentCubeCopies: Record<string, number>;
  draftIds: string[];
  draftMetadata: Record<string, { name: string; date: string; numDrafters?: number }>;
  scryfallData: Record<string, ScryCard>;
}> {
  // Load all drafts
  const { picks, draftIds, draftMetadata, matchStats } = await loadAllDrafts(dataDir);

  // Get current cube cards (most recent draft's pool)
  const currentCubeSet = getCurrentCubeCards(dataDir);
  const currentCubeCards = Array.from(currentCubeSet);

  // Get copy counts for current cube
  const currentCubeCopies = Object.fromEntries(getCurrentCubeCopies(dataDir));

  if (picks.length === 0) {
    return {
      cards: [],
      players: [],
      draftCount: 0,
      currentCubeCards,
      currentCubeCopies,
      draftIds: [],
      draftMetadata: {},
      scryfallData: {},
    };
  }

  // Extract unique players
  const players = extractPlayers(picks);

  // Calculate card stats (with draft metadata for score history)
  const stats = calculateCardStats(picks, topPlayers, draftMetadata);

  // Get unique card names for Scryfall lookup
  const cardNames = stats.map((s) => s.cardName);

  // Fetch Scryfall data (uses caching internally)
  const scryfallData = cachePath
    ? await fetchCards(cardNames, cachePath)
    : await fetchCards(cardNames);

  // Calculate win equity if we have match data
  const winEquityResults = calculateWinEquity(picks, matchStats, scryfallData);

  // Calculate raw win rate if we have match data
  const rawWinRateResults = calculateRawWinRate(picks, matchStats);

  // Apply win equity and raw win rate to stats
  for (const stat of stats) {
    const equity = winEquityResults.get(stat.cardName);
    if (equity) {
      stat.winEquity = {
        wins: equity.wins,
        losses: equity.losses,
        winRate: equity.winRate,
      };
    }

    const rawWinRate = rawWinRateResults.get(stat.cardName);
    if (rawWinRate) {
      stat.rawWinRate = {
        wins: rawWinRate.wins,
        losses: rawWinRate.losses,
        winRate: rawWinRate.winRate,
      };
    }
  }

  // Enrich stats with Scryfall data
  const cards = enrichStats(stats, scryfallData);

  // Filter to only cards in current cube (if cube is empty, show all)
  const filteredCards =
    currentCubeSet.size > 0 ? cards.filter((c) => currentCubeSet.has(c.cardName)) : cards;

  // Find new cards in current cube that have no historical data
  const cardsWithStats = new Set(stats.map((s) => s.cardName));
  const newCards = Array.from(currentCubeSet).filter((name) => !cardsWithStats.has(name));

  // Fetch Scryfall data for new cards and create stub entries
  let newCardEntries: EnrichedCardStats[] = [];
  if (newCards.length > 0) {
    const newCardScryfall = cachePath
      ? await fetchCards(newCards, cachePath)
      : await fetchCards(newCards);

    newCardEntries = newCards.map(
      (cardName): EnrichedCardStats => ({
        cardName,
        weightedGeomean: Infinity,
        topPlayerGeomean: Infinity,
        totalPicks: 0,
        timesAvailable: 0,
        draftsPickedIn: 0,
        timesUnpicked: 0,
        maxCopiesInDraft: 0,
        colors: [] as string[],
        scoreHistory: [] as DraftScore[],
        pickDistribution: new Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
        scryfall: newCardScryfall.get(cardName),
      })
    );
  }

  // Combine: historical cards first, then new cards at the bottom
  const allCards = [...filteredCards, ...newCardEntries];

  console.log(
    `[DataLoader] Loaded ${filteredCards.length} cards from ${draftIds.length} drafts (${cards.length - filteredCards.length} not in cube, ${newCards.length} new to cube)`
  );

  // Convert draftMetadata Map to plain object for serialization
  const draftMetadataObj: Record<string, { name: string; date: string; numDrafters?: number }> = {};
  for (const [id, meta] of draftMetadata) {
    draftMetadataObj[id] = { name: meta.name, date: meta.date, numDrafters: meta.numDrafters };
  }

  // Convert scryfallData Map to plain object
  const scryfallDataObj: Record<string, ScryCard> = {};
  for (const [name, card] of scryfallData) {
    scryfallDataObj[name] = card;
  }

  return {
    cards: allCards,
    players,
    draftCount: draftIds.length,
    currentCubeCards,
    currentCubeCopies,
    draftIds,
    draftMetadata: draftMetadataObj,
    scryfallData: scryfallDataObj,
  };
}
