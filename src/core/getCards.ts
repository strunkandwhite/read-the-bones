/**
 * Server-side card stats computation.
 *
 * Queries the Turso database and returns enriched card statistics.
 * This is the primary data-fetching function for the API layer,
 * replacing the build-time loadCardDataFromTurso().
 */

import {
  DEFAULT_POOL_SIZE,
  type CardPick,
  type DraftMetadata,
  type DraftScore,
  type EnrichedCardStats,
  type ScryCard,
} from "./types";
import { calculateCardStats, DISTRIBUTION_BUCKET_COUNT } from "./calculateStats";
import { getClient, type Client } from "./db/client";
import { computeIngestionHash } from "./db/sync/domains";
import { transformScryfallJson, parseBannedCardNames } from "./db/queries/helpers";
import { cardNameKey } from "./parseSheetRows";
import { round3 } from "./utils";

// --- Internal types for extracted subfunctions ---

type DraftRow = {
  draft_id: string;
  draft_name: string;
  draft_date: string;
  cube_snapshot_id: number;
  num_seats: number;
  phase: string;
  banned_cards: string | null;
  pool_hash: unknown;
  picks_hash: unknown;
  matches_hash: unknown;
};

type DraftMetadataResult = {
  draftIds: string[];
  completedDraftIds: string[];
  draftMetadataMap: Map<string, DraftMetadata>;
  draftCubeSnapshots: Map<string, number>;
  mostRecentCubeSnapshotId: number | null;
  bannedCardsByDraft: Map<string, Set<string>>;
  bannedCardNamesByDraft: Map<string, string[]>;
  ingestionHash: string;
};

type CubeCardInfo = {
  cardName: string;
  qty: number;
  scryfallJson: string | null;
};

type PickEventsResult = {
  scryfallDataMap: Map<string, ScryCard>;
  picksByDraftAndCard: Map<string, Map<string, CardPick[]>>;
};

type DecklistWinRateData = {
  winRate: number;
  gameWins: number;
  gameLosses: number;
  timesMaindecked: number;
  draftsWithData: number;
};

type CubeDisplayData = {
  cubeCopies: Record<string, number>;
  currentCubeSet: Set<string>;
  currentCubeKeySet: Set<string>;
};

export type GetCardsParams = {
  draftIds?: string[];
  includeMatchData: boolean;
  activeDraft?: string;
  /** Use this draft's cube snapshot for pool filtering instead of the most recent */
  poolAsOfDraft?: string;
};

export type CardStatsResponse = {
  cards: EnrichedCardStats[];
  draftCount: number;
  cubeCopies: Record<string, number>;
  draftMetadata: Record<string, { name: string; date: string; numDrafters: number }>;
  draftIds: string[];
  completedDraftIds: string[];
  ingestionHash: string;
  takenCards?: Array<{ name: string; seat: number }>;
  bannedCardNames?: string[];
};

/**
 * Get color string from Scryfall color_identity.
 * Returns single-letter codes joined (e.g., "UB" for blue-black).
 */
function getColorFromIdentity(colorIdentity: string[]): string {
  if (!colorIdentity || colorIdentity.length === 0) return "C";
  return colorIdentity.sort().join("");
}

/**
 * Step 1: Query all drafts, build metadata maps, compute ingestion hash, track banned cards.
 */
async function loadDraftMetadata(client: Client): Promise<DraftMetadataResult | null> {
  const draftsResult = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.cube_snapshot_id, d.num_seats, d.phase, d.banned_cards,
                 d.pool_hash, d.picks_hash, d.matches_hash
          FROM drafts d
          ORDER BY d.draft_date DESC`,
    args: [],
  });

  const ingestionHash = computeIngestionHash(
    draftsResult.rows as unknown as Array<{ pool_hash: unknown; picks_hash: unknown; matches_hash: unknown }>
  );

  if (draftsResult.rows.length === 0) {
    return null;
  }

  const draftIds: string[] = [];
  const draftMetadataMap = new Map<string, DraftMetadata>();
  const draftCubeSnapshots = new Map<string, number>();
  let mostRecentCubeSnapshotId: number | null = null;

  const completedDraftSet = new Set<string>();
  const bannedCardsByDraft = new Map<string, Set<string>>();
  const bannedCardNamesByDraft = new Map<string, string[]>();

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

    const bannedCardsJson = row.banned_cards as string | null;
    const bannedNames = parseBannedCardNames(bannedCardsJson);
    if (bannedNames.length > 0) {
      const banKeys = new Set(bannedNames.map(n => cardNameKey(n)));
      bannedCardsByDraft.set(draftId, banKeys);
      bannedCardNamesByDraft.set(draftId, bannedNames);
    }

    if (row.phase === 'complete') {
      completedDraftSet.add(draftId);
    }

    if (mostRecentCubeSnapshotId === null) {
      mostRecentCubeSnapshotId = cubeSnapshotId;
    }
  }

  const completedDraftIds = draftIds.filter((id) => completedDraftSet.has(id));

  return {
    draftIds,
    completedDraftIds,
    draftMetadataMap,
    draftCubeSnapshots,
    mostRecentCubeSnapshotId,
    bannedCardsByDraft,
    bannedCardNamesByDraft,
    ingestionHash,
  };
}

/**
 * Step 2: Query pool sizes for each cube snapshot.
 */
async function getCubePoolSizes(
  client: Client,
  uniqueCubeSnapshots: number[],
): Promise<Map<number, number>> {
  if (uniqueCubeSnapshots.length === 0) return new Map();

  const placeholders = uniqueCubeSnapshots.map(() => "?").join(", ");
  const cubeSizesResult = await client.execute({
    sql: `SELECT cube_snapshot_id, SUM(qty) as pool_size
          FROM cube_snapshot_cards
          WHERE cube_snapshot_id IN (${placeholders})
          GROUP BY cube_snapshot_id`,
    args: [...uniqueCubeSnapshots],
  });

  const poolSizes = new Map<number, number>();
  for (const row of cubeSizesResult.rows) {
    poolSizes.set(row.cube_snapshot_id as number, row.pool_size as number);
  }
  return poolSizes;
}

/**
 * Step 3: Load all pick events with Scryfall data.
 * Builds scryfallDataMap (card key -> ScryCard) and picksByDraftAndCard (draftId -> cardKey -> CardPick[]).
 */
async function loadPickEvents(client: Client): Promise<PickEventsResult> {
  const picksResult = await client.execute({
    sql: `SELECT pe.draft_id, pe.pick_n, pe.seat,
                 c.name as card_name, c.scryfall_json
          FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          ORDER BY pe.draft_id, pe.pick_n`,
    args: [],
  });

  const scryfallDataMap = new Map<string, ScryCard>();
  const picksByDraftAndCard = new Map<string, Map<string, CardPick[]>>();

  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const cardName = row.card_name as string;
    const scryfallJson = row.scryfall_json as string | null;
    const seat = row.seat as number;
    const key = cardNameKey(cardName);

    if (!scryfallDataMap.has(key)) {
      const scryData = transformScryfallJson(scryfallJson, cardName);
      if (scryData) {
        scryfallDataMap.set(key, scryData);
      }
    }

    const scryData = scryfallDataMap.get(key);
    const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

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

  return { scryfallDataMap, picksByDraftAndCard };
}

/**
 * Step 4: Load all cards in each cube snapshot, grouped by snapshot ID.
 */
async function loadCubeCards(
  client: Client,
  uniqueCubeSnapshots: number[],
): Promise<Map<number, Map<number, CubeCardInfo>>> {
  if (uniqueCubeSnapshots.length === 0) return new Map();

  const placeholders = uniqueCubeSnapshots.map(() => "?").join(", ");
  const cubeCardsResult = await client.execute({
    sql: `SELECT csc.cube_snapshot_id, csc.card_id, csc.qty,
                 c.name as card_name, c.scryfall_json
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id IN (${placeholders})`,
    args: [...uniqueCubeSnapshots],
  });

  const cubeCardsBySnapshot = new Map<number, Map<number, CubeCardInfo>>();
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

  return cubeCardsBySnapshot;
}

/**
 * Step 5: Combine picked + unpicked cards from selected drafts.
 * Pure computation (no DB queries). Mutates scryfallDataMap to add Scryfall data
 * for cube cards not seen in pick events.
 */
function buildAllPicks(
  selectedDraftIds: string[],
  selectedDraftSet: Set<string>,
  picksByDraftAndCard: Map<string, Map<string, CardPick[]>>,
  cubeCardsBySnapshot: Map<number, Map<number, CubeCardInfo>>,
  draftCubeSnapshots: Map<string, number>,
  poolSizes: Map<number, number>,
  bannedCardsByDraft: Map<string, Set<string>>,
  scryfallDataMap: Map<string, ScryCard>,
): CardPick[] {
  const allPicks: CardPick[] = [];

  // Add all picked cards from selected drafts
  for (const [draftId, cardPicks] of picksByDraftAndCard) {
    if (!selectedDraftSet.has(draftId)) continue;
    for (const picks of cardPicks.values()) {
      allPicks.push(...picks);
    }
  }

  // Add unpicked cards for each selected draft
  for (const draftId of selectedDraftIds) {
    const cubeSnapshotId = draftCubeSnapshots.get(draftId);
    if (!cubeSnapshotId) continue;

    const cubeCards = cubeCardsBySnapshot.get(cubeSnapshotId);
    if (!cubeCards) continue;

    const poolSize = poolSizes.get(cubeSnapshotId) || DEFAULT_POOL_SIZE;
    const draftPicks = picksByDraftAndCard.get(draftId) || new Map<string, CardPick[]>();

    for (const [, cardInfo] of cubeCards) {
      const key = cardNameKey(cardInfo.cardName);

      const draftBans = bannedCardsByDraft.get(draftId);
      if (draftBans?.has(key)) continue;

      const pickedCount = draftPicks.get(key)?.length || 0;
      const unpickedQty = cardInfo.qty - pickedCount;

      if (unpickedQty > 0) {
        if (!scryfallDataMap.has(key)) {
          const scryData = transformScryfallJson(cardInfo.scryfallJson, cardInfo.cardName);
          if (scryData) {
            scryfallDataMap.set(key, scryData);
          }
        }

        const scryData = scryfallDataMap.get(key);
        const color = scryData ? getColorFromIdentity(scryData.colorIdentity) : "";

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

  return allPicks;
}

/**
 * Compute card statistics from the Turso database.
 *
 * When no draftIds are specified, stats are computed across all completed drafts.
 * When draftIds are provided, only those drafts contribute to the stats.
 * The full list of draftIds/completedDraftIds is always returned (for the Settings panel).
 */
export async function getCards(params: GetCardsParams): Promise<CardStatsResponse> {
  const client = await getClient();

  // 1. Load all drafts with metadata
  const draftMeta = await loadDraftMetadata(client);

  if (!draftMeta) {
    return {
      cards: [],
      draftCount: 0,
      cubeCopies: {},
      draftMetadata: {},
      draftIds: [],
      completedDraftIds: [],
      ingestionHash: computeIngestionHash([]),
    };
  }

  const {
    draftIds, completedDraftIds, draftMetadataMap, draftCubeSnapshots,
    mostRecentCubeSnapshotId, bannedCardsByDraft, bannedCardNamesByDraft, ingestionHash,
  } = draftMeta;

  const selectedDraftIds: string[] = params.draftIds
    ? params.draftIds.filter((id) => new Set(completedDraftIds).has(id))
    : completedDraftIds;

  const selectedDraftSet = new Set(selectedDraftIds);

  // 2. Get pool sizes for each cube snapshot
  const uniqueCubeSnapshots = [...new Set(draftCubeSnapshots.values())];
  const poolSizes = await getCubePoolSizes(client, uniqueCubeSnapshots);

  // 3. Load all picks with card names and Scryfall data
  const { scryfallDataMap, picksByDraftAndCard } = await loadPickEvents(client);

  // 4. Load cube snapshot cards to find unpicked cards
  const cubeCardsBySnapshot = await loadCubeCards(client, uniqueCubeSnapshots);

  // 5. Build picks array from selected drafts, including unpicked entries
  const allPicks = buildAllPicks(
    selectedDraftIds, selectedDraftSet, picksByDraftAndCard,
    cubeCardsBySnapshot, draftCubeSnapshots, poolSizes,
    bannedCardsByDraft, scryfallDataMap,
  );

  // 6. Conditionally load decklist win rate data
  const decklistWinRates = new Map<string, {
    winRate: number;
    gameWins: number;
    gameLosses: number;
    timesMaindecked: number;
    draftsWithData: number;
  }>();

  if (params.includeMatchData) {
    const decklistWinResult = await client.execute({
      sql: `SELECT c.name as card_name,
                   COUNT(DISTINCT dc.draft_id || '-' || dc.seat) as times_maindecked,
                   COUNT(DISTINCT dc.draft_id) as drafts_with_data,
                   SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                            WHEN me.seat2 = dc.seat THEN me.seat2_wins
                            ELSE 0 END) as game_wins,
                   SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                            WHEN me.seat2 = dc.seat THEN me.seat1_wins
                            ELSE 0 END) as game_losses
            FROM deck_cards dc
            JOIN cards c ON dc.card_id = c.card_id
            JOIN match_events me ON me.draft_id = dc.draft_id
                 AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
            WHERE dc.zone = 'deck'
            GROUP BY c.name`,
      args: [],
    });

    for (const row of decklistWinResult.rows) {
      const cardName = row.card_name as string;
      const gameWins = row.game_wins as number;
      const gameLosses = row.game_losses as number;
      const total = gameWins + gameLosses;

      decklistWinRates.set(cardNameKey(cardName), {
        winRate: total > 0 ? round3(gameWins / total) : 0,
        gameWins,
        gameLosses,
        timesMaindecked: row.times_maindecked as number,
        draftsWithData: row.drafts_with_data as number,
      });
    }
  }

  // 7. Load cube cards for the selected pool snapshot
  // Use poolAsOfDraft's snapshot if specified, otherwise most recent
  const displayCubeSnapshotId = params.poolAsOfDraft
    ? draftCubeSnapshots.get(params.poolAsOfDraft) ?? mostRecentCubeSnapshotId
    : mostRecentCubeSnapshotId;

  const cubeCopies: Record<string, number> = {};

  if (displayCubeSnapshotId !== null) {
    const currentCube = cubeCardsBySnapshot.get(displayCubeSnapshotId);
    if (currentCube) {
      for (const cardInfo of currentCube.values()) {
        cubeCopies[cardInfo.cardName] = cardInfo.qty;

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

  const currentCubeSet = new Set(Object.keys(cubeCopies));
  const currentCubeKeySet = new Set(Object.keys(cubeCopies).map((n) => cardNameKey(n)));

  // 8. Calculate card stats
  const stats = calculateCardStats(allPicks, draftMetadataMap);

  // Attach decklist win rates
  if (params.includeMatchData) {
    for (const stat of stats) {
      const key = cardNameKey(stat.cardName);
      const decklistWR = decklistWinRates.get(key);
      if (decklistWR) {
        stat.decklistWinRate = decklistWR;
      }
    }
  }

  // 9. Enrich stats with Scryfall data
  const enrichedStats: EnrichedCardStats[] = stats.map((stat) => ({
    ...stat,
    scryfall: scryfallDataMap.get(cardNameKey(stat.cardName)),
  }));

  // 10. Filter to only cards in current cube (key-based to handle DFC name variants)
  const filteredCards =
    currentCubeKeySet.size > 0
      ? enrichedStats.filter((c) => currentCubeKeySet.has(cardNameKey(c.cardName)))
      : enrichedStats;

  // 11. Find new cards in current cube that have no historical data
  const cardsWithStatsKeys = new Set(stats.map((s) => cardNameKey(s.cardName)));
  const newCards = Array.from(currentCubeSet).filter(
    (name) => !cardsWithStatsKeys.has(cardNameKey(name))
  );

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

  // Convert draftMetadata Map to plain object
  const draftMetadataObj: Record<string, { name: string; date: string; numDrafters: number }> = {};
  for (const [id, meta] of draftMetadataMap) {
    draftMetadataObj[id] = { name: meta.name, date: meta.date, numDrafters: meta.numDrafters ?? 10 };
  }

  // Query taken cards with seat info for active draft filtering
  let takenCards: Array<{ name: string; seat: number }> | undefined;
  if (params.activeDraft) {
    const takenResult = await client.execute({
      sql: `SELECT c.name, pe.seat FROM pick_events pe JOIN cards c ON pe.card_id = c.card_id WHERE pe.draft_id = ?`,
      args: [params.activeDraft],
    });
    takenCards = takenResult.rows.map((row) => ({
      name: row.name as string,
      seat: row.seat as number,
    }));
  }

  // Get banned card names for active draft filtering (original casing for client matching)
  let bannedCardNames: string[] | undefined;
  if (params.activeDraft) {
    const rawNames = bannedCardNamesByDraft.get(params.activeDraft);
    if (rawNames && rawNames.length > 0) {
      bannedCardNames = rawNames;
    }
  }

  console.log(
    `[getCards] Loaded ${filteredCards.length} cards from ${selectedDraftIds.length}/${draftIds.length} drafts (${newCards.length} new to cube)`
  );

  return {
    cards: allCards,
    draftCount: selectedDraftIds.length,
    cubeCopies,
    draftMetadata: draftMetadataObj,
    draftIds,
    completedDraftIds,
    ingestionHash,
    takenCards,
    bannedCardNames,
  };
}
