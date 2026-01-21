/**
 * Data loading pipeline that queries Turso database instead of CSV files.
 *
 * This module provides the same data structure as dataLoader.ts but reads
 * from Turso database instead of parsing CSV files.
 */

import type {
  CardPick,
  CardStats,
  DraftMetadata,
  DraftScore,
  EnrichedCardStats,
  ScryCard,
} from "../core/types";
import type { SeatMatchStats, MatchResult } from "../core/parseMatches";
import { calculateCardStats, DISTRIBUTION_BUCKET_COUNT } from "../core/calculateStats";
import { calculateWinEquity, calculateRawWinRate } from "../core/winEquity";
import { getClient } from "../core/db/client";
import { cardNameKey } from "../core/parseCsv";

/**
 * Transform Scryfall JSON from database to ScryCard type.
 */
function transformScryfallJson(json: string | null, cardName: string): ScryCard | undefined {
  if (!json) return undefined;

  try {
    const data = JSON.parse(json);

    // Handle double-faced cards - use front face image
    let imageUri = "";
    if (data.card_faces && data.card_faces[0]?.image_uris?.normal) {
      imageUri = data.card_faces[0].image_uris.normal;
    } else if (data.image_uris?.normal) {
      imageUri = data.image_uris.normal;
    }

    return {
      name: data.name || cardName,
      imageUri,
      manaCost: data.mana_cost || "",
      manaValue: data.cmc || 0,
      typeLine: data.type_line || "",
      colors: data.colors || [],
      colorIdentity: data.color_identity || [],
      oracleText: data.oracle_text || "",
    };
  } catch {
    return undefined;
  }
}

/**
 * Get color string from Scryfall color_identity.
 * Returns single-letter codes joined (e.g., "UB" for blue-black).
 */
function getColorFromIdentity(colorIdentity: string[]): string {
  if (!colorIdentity || colorIdentity.length === 0) return "C";
  return colorIdentity.sort().join("");
}

/** Options for loading drafts (matches dataLoader.ts interface) */
export type LoadDraftsOptions = {
  /** Suppress console output (default: false) */
  quiet?: boolean;
};

/**
 * Load all drafts from Turso database.
 *
 * This function provides the same interface as loadAllDrafts in dataLoader.ts,
 * allowing CLI tools to switch from CSV to Turso without changing their code.
 *
 * @param _dataDir - Ignored (kept for API compatibility with dataLoader.ts)
 * @param options - Optional settings (quiet mode)
 * @returns Object with all picks, draft IDs, and draft metadata
 */
export async function loadAllDraftsFromTurso(
  _dataDir?: string,
  options?: LoadDraftsOptions
): Promise<{
  picks: CardPick[];
  draftIds: string[];
  draftMetadata: Map<string, DraftMetadata>;
  matchStats: Map<string, Map<number, SeatMatchStats>>;
  rawMatches: Map<string, MatchResult[]>;
}> {
  const quiet = options?.quiet ?? false;
  const client = await getClient();

  // 1. Load all drafts with metadata
  const draftsResult = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.cube_snapshot_id, d.num_seats
          FROM drafts d
          ORDER BY d.draft_date DESC`,
    args: [],
  });

  if (draftsResult.rows.length === 0) {
    return {
      picks: [],
      draftIds: [],
      draftMetadata: new Map(),
      matchStats: new Map(),
      rawMatches: new Map(),
    };
  }

  const draftIds: string[] = [];
  const draftMetadata = new Map<string, DraftMetadata>();
  const draftCubeSnapshots = new Map<string, number>();

  for (const row of draftsResult.rows) {
    const draftId = row.draft_id as string;
    const cubeSnapshotId = row.cube_snapshot_id as number;

    draftIds.push(draftId);
    draftMetadata.set(draftId, {
      draftId,
      name: row.draft_name as string,
      date: row.draft_date as string,
      numDrafters: (row.num_seats as number) || 10,
    });
    draftCubeSnapshots.set(draftId, cubeSnapshotId);
  }

  // 2. Get pool sizes for each cube snapshot
  const uniqueCubeSnapshots = [...new Set(draftCubeSnapshots.values())];
  const cubeSnapshotPlaceholders = uniqueCubeSnapshots.map(() => "?").join(", ");

  const cubeSizesResult = await client.execute({
    sql: `SELECT cube_snapshot_id, SUM(qty) as pool_size
          FROM cube_snapshot_cards
          WHERE cube_snapshot_id IN (${cubeSnapshotPlaceholders})
          GROUP BY cube_snapshot_id`,
    args: [...uniqueCubeSnapshots],
  });

  const poolSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    poolSizes.set(row.cube_snapshot_id as number, row.pool_size as number);
  }

  // 3. Load all picks with card names and Scryfall data
  const picksResult = await client.execute({
    sql: `SELECT pe.draft_id, pe.pick_n, pe.seat,
                 c.name as card_name, c.scryfall_json
          FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          ORDER BY pe.draft_id, pe.pick_n`,
    args: [],
  });

  // Build Scryfall data map and card picks
  const scryfallDataMap = new Map<string, ScryCard>();
  const picksByDraftAndCard = new Map<string, Map<string, CardPick[]>>();

  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const cardName = row.card_name as string;
    const scryfallJson = row.scryfall_json as string | null;
    const seat = row.seat as number;
    const key = cardNameKey(cardName);

    // Build Scryfall data
    if (!scryfallDataMap.has(key)) {
      const scryData = transformScryfallJson(scryfallJson, cardName);
      if (scryData) {
        scryfallDataMap.set(key, scryData);
      }
    }

    // Get color from Scryfall data
    const scryData = scryfallDataMap.get(key);
    const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

    // Track picks by draft and card for copy number calculation
    if (!picksByDraftAndCard.has(draftId)) {
      picksByDraftAndCard.set(draftId, new Map());
    }
    const draftPicks = picksByDraftAndCard.get(draftId)!;
    if (!draftPicks.has(key)) {
      draftPicks.set(key, []);
    }

    const copyNumber = draftPicks.get(key)!.length + 1;

    const pick: CardPick = {
      cardName,
      pickPosition: row.pick_n as number,
      copyNumber,
      wasPicked: true,
      draftId,
      seat,
      color,
    };

    draftPicks.get(key)!.push(pick);
  }

  // 4. Load cube snapshot cards to find unpicked cards
  const cubeCardsResult = await client.execute({
    sql: `SELECT csc.cube_snapshot_id, csc.card_id, csc.qty,
                 c.name as card_name, c.scryfall_json
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id IN (${cubeSnapshotPlaceholders})`,
    args: [...uniqueCubeSnapshots],
  });

  // Group cube cards by snapshot
  const cubeCardsBySnapshot = new Map<number, Map<number, { cardName: string; qty: number; scryfallJson: string | null }>>();
  for (const row of cubeCardsResult.rows) {
    const snapshotId = row.cube_snapshot_id as number;
    const cardId = row.card_id as number;

    if (!cubeCardsBySnapshot.has(snapshotId)) {
      cubeCardsBySnapshot.set(snapshotId, new Map());
    }
    cubeCardsBySnapshot.get(snapshotId)!.set(cardId, {
      cardName: row.card_name as string,
      qty: row.qty as number,
      scryfallJson: row.scryfall_json as string | null,
    });
  }

  // 5. Flatten all picks into a single array and add unpicked cards
  const allPicks: CardPick[] = [];

  for (const [draftId, cardPicks] of picksByDraftAndCard) {
    for (const picks of cardPicks.values()) {
      allPicks.push(...picks);
    }
  }

  // Add unpicked cards for each draft
  for (const draftId of draftIds) {
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    if (!cubeSnapshotId) continue;

    const cubeCards = cubeCardsBySnapshot.get(cubeSnapshotId);
    if (!cubeCards) continue;

    const poolSize = poolSizes.get(cubeSnapshotId) || 540;
    const draftPicks = picksByDraftAndCard.get(draftId) || new Map<string, CardPick[]>();

    for (const [, cardInfo] of cubeCards) {
      const key = cardNameKey(cardInfo.cardName);
      const pickedCount = draftPicks.get(key)?.length || 0;
      const unpickedQty = cardInfo.qty - pickedCount;

      if (unpickedQty > 0) {
        // Add Scryfall data if not already present
        if (!scryfallDataMap.has(key)) {
          const scryData = transformScryfallJson(cardInfo.scryfallJson, cardInfo.cardName);
          if (scryData) {
            scryfallDataMap.set(key, scryData);
          }
        }

        const scryData = scryfallDataMap.get(key);
        const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

        // Create unpicked entries for remaining copies
        // Unpicked cards don't belong to any seat (use -1)
        for (let i = 0; i < unpickedQty; i++) {
          allPicks.push({
            cardName: cardInfo.cardName,
            pickPosition: poolSize,
            copyNumber: pickedCount + i + 1,
            wasPicked: false,
            draftId,
            seat: -1,
            color,
          });
        }
      }
    }
  }

  // 6. Load match data
  const matchesResult = await client.execute({
    sql: `SELECT me.draft_id, me.seat1, me.seat2,
                 me.seat1_wins, me.seat2_wins
          FROM match_events me`,
    args: [],
  });

  // Aggregate match stats by draft and seat
  const matchStats = new Map<string, Map<number, SeatMatchStats>>();
  const rawMatches = new Map<string, MatchResult[]>();

  for (const row of matchesResult.rows) {
    const draftId = row.draft_id as string;
    const seat1 = row.seat1 as number;
    const seat2 = row.seat2 as number;
    const seat1Wins = row.seat1_wins as number;
    const seat2Wins = row.seat2_wins as number;

    // Build rawMatches
    if (!rawMatches.has(draftId)) {
      rawMatches.set(draftId, []);
    }
    rawMatches.get(draftId)!.push({
      seat1,
      seat2,
      seat1GamesWon: seat1Wins,
      seat2GamesWon: seat2Wins,
    });

    // Build aggregated matchStats
    if (!matchStats.has(draftId)) {
      matchStats.set(draftId, new Map());
    }
    const draftStats = matchStats.get(draftId)!;

    // Ensure both seats exist
    if (!draftStats.has(seat1)) {
      draftStats.set(seat1, { gamesWon: 0, gamesLost: 0 });
    }
    if (!draftStats.has(seat2)) {
      draftStats.set(seat2, { gamesWon: 0, gamesLost: 0 });
    }

    // Update stats
    const s1Stats = draftStats.get(seat1)!;
    s1Stats.gamesWon += seat1Wins;
    s1Stats.gamesLost += seat2Wins;

    const s2Stats = draftStats.get(seat2)!;
    s2Stats.gamesWon += seat2Wins;
    s2Stats.gamesLost += seat1Wins;
  }

  if (!quiet) {
    console.log(
      `[TursoDataLoader] Loaded ${allPicks.length} picks from ${draftIds.length} drafts`
    );
  }

  return {
    picks: allPicks,
    draftIds,
    draftMetadata,
    matchStats,
    rawMatches,
  };
}

/**
 * Load all card data from Turso database.
 *
 * This is the main entry point for the web app. It queries:
 * - All drafts with metadata
 * - All picks (converted to CardPick format)
 * - Current cube (most recent draft's pool)
 * - Match data for win equity
 * - Scryfall data from card records
 *
 * @returns Object with enriched card stats and draft count
 */
export async function loadCardDataFromTurso(): Promise<{
  cards: EnrichedCardStats[];
  draftCount: number;
  currentCubeCards: string[];
  currentCubeCopies: Record<string, number>;
  draftIds: string[];
  draftMetadata: Record<string, { name: string; date: string; numDrafters?: number }>;
  scryfallData: Record<string, ScryCard>;
}> {
  const client = await getClient();

  // 1. Load all drafts with metadata
  const draftsResult = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.cube_snapshot_id, d.num_seats
          FROM drafts d
          ORDER BY d.draft_date DESC`,
    args: [],
  });

  if (draftsResult.rows.length === 0) {
    return {
      cards: [],
      draftCount: 0,
      currentCubeCards: [],
      currentCubeCopies: {},
      draftIds: [],
      draftMetadata: {},
      scryfallData: {},
    };
  }

  const draftIds: string[] = [];
  const draftMetadataMap = new Map<string, DraftMetadata>();
  const draftCubeSnapshots = new Map<string, number>();
  let mostRecentCubeSnapshotId: number | null = null;

  for (const row of draftsResult.rows) {
    const draftId = row.draft_id as string;
    const cubeSnapshotId = row.cube_snapshot_id as number;

    draftIds.push(draftId);
    draftMetadataMap.set(draftId, {
      draftId,
      name: row.draft_name as string,
      date: row.draft_date as string,
      numDrafters: (row.num_seats as number) || 10,
    });
    draftCubeSnapshots.set(draftId, cubeSnapshotId);

    // First row is most recent (ordered by date DESC)
    if (mostRecentCubeSnapshotId === null) {
      mostRecentCubeSnapshotId = cubeSnapshotId;
    }
  }

  // 2. Get pool sizes for each cube snapshot (total cards with qty)
  const uniqueCubeSnapshots = [...new Set(draftCubeSnapshots.values())];
  const cubeSnapshotPlaceholders = uniqueCubeSnapshots.map(() => "?").join(", ");

  const cubeSizesResult = await client.execute({
    sql: `SELECT cube_snapshot_id, SUM(qty) as pool_size
          FROM cube_snapshot_cards
          WHERE cube_snapshot_id IN (${cubeSnapshotPlaceholders})
          GROUP BY cube_snapshot_id`,
    args: [...uniqueCubeSnapshots],
  });

  const poolSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    poolSizes.set(row.cube_snapshot_id as number, row.pool_size as number);
  }

  // 3. Load all picks with card names and Scryfall data
  const picksResult = await client.execute({
    sql: `SELECT pe.draft_id, pe.pick_n, pe.seat,
                 c.name as card_name, c.scryfall_json
          FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          ORDER BY pe.draft_id, pe.pick_n`,
    args: [],
  });

  // Build Scryfall data map and card picks
  const scryfallDataMap = new Map<string, ScryCard>();
  const picksByDraftAndCard = new Map<string, Map<string, CardPick[]>>();

  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const cardName = row.card_name as string;
    const scryfallJson = row.scryfall_json as string | null;
    const seat = row.seat as number;
    const key = cardNameKey(cardName);

    // Build Scryfall data
    if (!scryfallDataMap.has(key)) {
      const scryData = transformScryfallJson(scryfallJson, cardName);
      if (scryData) {
        scryfallDataMap.set(key, scryData);
      }
    }

    // Get color from Scryfall data
    const scryData = scryfallDataMap.get(key);
    const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

    // Track picks by draft and card for copy number calculation
    if (!picksByDraftAndCard.has(draftId)) {
      picksByDraftAndCard.set(draftId, new Map());
    }
    const draftPicks = picksByDraftAndCard.get(draftId)!;
    if (!draftPicks.has(key)) {
      draftPicks.set(key, []);
    }

    const copyNumber = draftPicks.get(key)!.length + 1;

    const pick: CardPick = {
      cardName,
      pickPosition: row.pick_n as number,
      copyNumber,
      wasPicked: true,
      draftId,
      seat,
      color,
    };

    draftPicks.get(key)!.push(pick);
  }

  // 4. Load cube snapshot cards to find unpicked cards
  // Query all cards in each cube snapshot
  const cubeCardsResult = await client.execute({
    sql: `SELECT csc.cube_snapshot_id, csc.card_id, csc.qty,
                 c.name as card_name, c.scryfall_json
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id IN (${cubeSnapshotPlaceholders})`,
    args: [...uniqueCubeSnapshots],
  });

  // Group cube cards by snapshot
  const cubeCardsBySnapshot = new Map<number, Map<number, { cardName: string; qty: number; scryfallJson: string | null }>>();
  for (const row of cubeCardsResult.rows) {
    const snapshotId = row.cube_snapshot_id as number;
    const cardId = row.card_id as number;

    if (!cubeCardsBySnapshot.has(snapshotId)) {
      cubeCardsBySnapshot.set(snapshotId, new Map());
    }
    cubeCardsBySnapshot.get(snapshotId)!.set(cardId, {
      cardName: row.card_name as string,
      qty: row.qty as number,
      scryfallJson: row.scryfall_json as string | null,
    });
  }

  // 5. Create unpicked CardPick entries for each draft
  // Flatten all picks into a single array
  const allPicks: CardPick[] = [];

  for (const [draftId, cardPicks] of picksByDraftAndCard) {
    for (const picks of cardPicks.values()) {
      allPicks.push(...picks);
    }
  }

  // Add unpicked cards for each draft
  for (const draftId of draftIds) {
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    if (!cubeSnapshotId) continue;

    const cubeCards = cubeCardsBySnapshot.get(cubeSnapshotId);
    if (!cubeCards) continue;

    const poolSize = poolSizes.get(cubeSnapshotId) || 540;
    const draftPicks = picksByDraftAndCard.get(draftId) || new Map<string, CardPick[]>();

    for (const [, cardInfo] of cubeCards) {
      const key = cardNameKey(cardInfo.cardName);
      const pickedCount = draftPicks.get(key)?.length || 0;
      const unpickedQty = cardInfo.qty - pickedCount;

      if (unpickedQty > 0) {
        // Add Scryfall data if not already present
        if (!scryfallDataMap.has(key)) {
          const scryData = transformScryfallJson(cardInfo.scryfallJson, cardInfo.cardName);
          if (scryData) {
            scryfallDataMap.set(key, scryData);
          }
        }

        const scryData = scryfallDataMap.get(key);
        const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

        // Create unpicked entries for remaining copies
        // Unpicked cards don't belong to any seat (use -1)
        for (let i = 0; i < unpickedQty; i++) {
          allPicks.push({
            cardName: cardInfo.cardName,
            pickPosition: poolSize,
            copyNumber: pickedCount + i + 1,
            wasPicked: false,
            draftId,
            seat: -1,
            color,
          });
        }
      }
    }
  }

  // 6. Load match data for win equity calculation
  const matchesResult = await client.execute({
    sql: `SELECT me.draft_id, me.seat1, me.seat2,
                 me.seat1_wins, me.seat2_wins
          FROM match_events me`,
    args: [],
  });

  // Aggregate match stats by draft and seat
  const matchStats = new Map<string, Map<number, SeatMatchStats>>();

  for (const row of matchesResult.rows) {
    const draftId = row.draft_id as string;
    const seat1 = row.seat1 as number;
    const seat2 = row.seat2 as number;
    const seat1Wins = row.seat1_wins as number;
    const seat2Wins = row.seat2_wins as number;

    if (!matchStats.has(draftId)) {
      matchStats.set(draftId, new Map());
    }
    const draftStats = matchStats.get(draftId)!;

    // Ensure both seats exist
    if (!draftStats.has(seat1)) {
      draftStats.set(seat1, { gamesWon: 0, gamesLost: 0 });
    }
    if (!draftStats.has(seat2)) {
      draftStats.set(seat2, { gamesWon: 0, gamesLost: 0 });
    }

    // Update stats
    const s1Stats = draftStats.get(seat1)!;
    s1Stats.gamesWon += seat1Wins;
    s1Stats.gamesLost += seat2Wins;

    const s2Stats = draftStats.get(seat2)!;
    s2Stats.gamesWon += seat2Wins;
    s2Stats.gamesLost += seat1Wins;
  }

  // 7. Load current cube cards (from most recent draft's cube snapshot)
  let currentCubeCards: string[] = [];
  let currentCubeCopies: Record<string, number> = {};

  if (mostRecentCubeSnapshotId !== null) {
    const currentCube = cubeCardsBySnapshot.get(mostRecentCubeSnapshotId);
    if (currentCube) {
      for (const cardInfo of currentCube.values()) {
        currentCubeCards.push(cardInfo.cardName);
        currentCubeCopies[cardInfo.cardName] = cardInfo.qty;

        // Add Scryfall data for current cube cards
        const key = cardNameKey(cardInfo.cardName);
        if (!scryfallDataMap.has(key)) {
          const scryData = transformScryfallJson(cardInfo.scryfallJson, cardInfo.cardName);
          if (scryData) {
            scryfallDataMap.set(key, scryData);
          }
        }
      }
    }
  }

  const currentCubeSet = new Set(currentCubeCards);

  // 8. Calculate card stats
  const stats = calculateCardStats(allPicks, draftMetadataMap);

  // 10. Calculate win equity and raw win rate
  const winEquityResults = calculateWinEquity(allPicks, matchStats, scryfallDataMap);
  const rawWinRateResults = calculateRawWinRate(allPicks, matchStats);

  // Apply win equity to stats
  for (const stat of stats) {
    const key = cardNameKey(stat.cardName);
    const equity = winEquityResults.get(key);
    if (equity) {
      stat.winEquity = {
        wins: equity.wins,
        losses: equity.losses,
        winRate: equity.winRate,
      };
    }

    const rawWinRate = rawWinRateResults.get(key);
    if (rawWinRate) {
      stat.rawWinRate = {
        wins: rawWinRate.wins,
        losses: rawWinRate.losses,
        winRate: rawWinRate.winRate,
      };
    }
  }

  // 11. Enrich stats with Scryfall data
  const enrichedStats: EnrichedCardStats[] = stats.map((stat) => ({
    ...stat,
    scryfall: scryfallDataMap.get(cardNameKey(stat.cardName)),
  }));

  // 12. Filter to only cards in current cube
  const filteredCards =
    currentCubeSet.size > 0
      ? enrichedStats.filter((c) => currentCubeSet.has(c.cardName))
      : enrichedStats;

  // 13. Find new cards in current cube that have no historical data
  const cardsWithStats = new Set(stats.map((s) => s.cardName));
  const newCards = Array.from(currentCubeSet).filter((name) => !cardsWithStats.has(name));

  // Create stub entries for new cards
  const newCardEntries: EnrichedCardStats[] = newCards.map((cardName) => ({
    cardName,
    weightedGeomean: Infinity,
    totalPicks: 0,
    timesAvailable: 0,
    draftsPickedIn: 0,
    timesUnpicked: 0,
    maxCopiesInDraft: 0,
    colors: [] as string[],
    scoreHistory: [] as DraftScore[],
    pickDistribution: new Array(DISTRIBUTION_BUCKET_COUNT).fill(0),
    scryfall: scryfallDataMap.get(cardNameKey(cardName)),
  }));

  // Combine: historical cards first, then new cards
  const allCards = [...filteredCards, ...newCardEntries];

  console.log(
    `[TursoDataLoader] Loaded ${filteredCards.length} cards from ${draftIds.length} drafts (${enrichedStats.length - filteredCards.length} not in cube, ${newCards.length} new to cube)`
  );

  // Convert draftMetadata Map to plain object
  const draftMetadataObj: Record<string, { name: string; date: string; numDrafters?: number }> = {};
  for (const [id, meta] of draftMetadataMap) {
    draftMetadataObj[id] = { name: meta.name, date: meta.date, numDrafters: meta.numDrafters };
  }

  // Convert scryfallData Map to plain object
  const scryfallDataObj: Record<string, ScryCard> = {};
  for (const [key, card] of scryfallDataMap) {
    scryfallDataObj[key] = card;
  }

  return {
    cards: allCards,
    draftCount: draftIds.length,
    currentCubeCards,
    currentCubeCopies,
    draftIds,
    draftMetadata: draftMetadataObj,
    scryfallData: scryfallDataObj,
  };
}
