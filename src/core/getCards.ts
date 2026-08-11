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
  type EnrichedCardStats,
  type ScryCard,
} from "./types";
import { calculateCardStats } from "./calculateStats";
import { sessionsAgoByDraft } from "./draftSessions";
import { getClient, type Client } from "./db/client";
import { computeIngestionHash } from "./db/sync/domains";
import { transformScryfallJson, parseBannedCardNames, placeholders } from "./db/queries/helpers";
import { cardNameKey } from "./cardNames";
import { DEFAULT_NUM_SEATS } from "./constants";
import { normalizeColorIdentity } from "./manaColors";

// --- Internal types for extracted subfunctions ---

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
};

type PickEventsResult = {
  cardIds: Set<number>;
  picksByDraftAndCard: Map<string, Map<string, CardPick[]>>;
};

type CubeDisplayData = {
  cubeCopies: Record<string, number>;
  currentCubeSet: Set<string>;
  currentCubeKeySet: Set<string>;
};

export type GetCardsParams = {
  draftIds?: string[];
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
 * Get color string from Scryfall color_identity in WUBRG order.
 * Returns single-letter codes joined (e.g., "UB" for blue-black).
 * Delegates to normalizeColorIdentity so ordering is consistent codebase-wide.
 */
function getColorFromIdentity(colorIdentity: string[]): string {
  return normalizeColorIdentity(colorIdentity);
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
    draftsResult.rows as unknown as Array<{
      pool_hash: unknown;
      picks_hash: unknown;
      matches_hash: unknown;
    }>
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
      numDrafters: (row.num_seats as number) || DEFAULT_NUM_SEATS,
    });
    draftCubeSnapshots.set(draftId, cubeSnapshotId);

    const bannedCardsJson = row.banned_cards as string | null;
    const bannedNames = parseBannedCardNames(bannedCardsJson);
    if (bannedNames.length > 0) {
      const banKeys = new Set(bannedNames.map((n) => cardNameKey(n)));
      bannedCardsByDraft.set(draftId, banKeys);
      bannedCardNamesByDraft.set(draftId, bannedNames);
    }

    if (row.phase === "complete" || row.phase === "playing") {
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
  uniqueCubeSnapshots: number[]
): Promise<Map<number, number>> {
  if (uniqueCubeSnapshots.length === 0) return new Map();

  const cubeSizesResult = await client.execute({
    sql: `SELECT cube_snapshot_id, SUM(qty) as pool_size
          FROM cube_snapshot_cards
          WHERE cube_snapshot_id IN (${placeholders(uniqueCubeSnapshots.length)})
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
 * Step 3: Load all pick events (ids, names, pick metadata — no scryfall_json).
 * Returns the set of distinct card_ids seen (for the later Scryfall batch load),
 * a card_id→name lookup, and picksByDraftAndCard (draftId → cardKey → CardPick[]).
 * Scryfall data is loaded separately in loadScryfallDataForCards to avoid
 * transferring 2-8 KB blobs once per pick row (~450 rows × N drafts).
 */
async function loadPickEvents(client: Client, draftIds: string[]): Promise<PickEventsResult> {
  if (draftIds.length === 0) {
    return { cardIds: new Set(), picksByDraftAndCard: new Map() };
  }

  const picksResult = await client.execute({
    sql: `SELECT pe.draft_id, pe.pick_n, pe.seat, pe.card_id,
                 c.name as card_name
          FROM pick_events pe
          JOIN cards c ON pe.card_id = c.card_id
          WHERE pe.draft_id IN (${placeholders(draftIds.length)})
          ORDER BY pe.draft_id, pe.pick_n`,
    args: [...draftIds],
  });

  const cardIds = new Set<number>();
  const picksByDraftAndCard = new Map<string, Map<string, CardPick[]>>();

  for (const row of picksResult.rows) {
    const draftId = row.draft_id as string;
    const cardName = row.card_name as string;
    const cardId = row.card_id as number;
    const seat = row.seat as number;
    const key = cardNameKey(cardName);

    cardIds.add(cardId);

    if (!picksByDraftAndCard.has(draftId)) {
      picksByDraftAndCard.set(draftId, new Map());
    }
    const draftPicks = picksByDraftAndCard.get(draftId)!;
    if (!draftPicks.has(key)) {
      draftPicks.set(key, []);
    }

    const copyNumber = draftPicks.get(key)!.length + 1;

    // Color is filled in after Scryfall data loads (see buildAllPicks).
    const pick: CardPick = {
      cardName,
      pickPosition: row.pick_n as number,
      copyNumber,
      wasPicked: true,
      draftId,
      seat,
      color: "",
    };

    draftPicks.get(key)!.push(pick);
  }

  return { cardIds, picksByDraftAndCard };
}

/**
 * Step 4: Load all cards in each cube snapshot (ids, names, qty — no scryfall_json).
 * Grouped by snapshot ID. Scryfall data is loaded separately in loadScryfallDataForCards.
 */
async function loadCubeCards(
  client: Client,
  uniqueCubeSnapshots: number[]
): Promise<{
  cubeCardsBySnapshot: Map<number, Map<number, CubeCardInfo>>;
  cubeCardIds: Set<number>;
}> {
  if (uniqueCubeSnapshots.length === 0) {
    return { cubeCardsBySnapshot: new Map(), cubeCardIds: new Set() };
  }

  const cubeCardsResult = await client.execute({
    sql: `SELECT csc.cube_snapshot_id, csc.card_id, csc.qty,
                 c.name as card_name
          FROM cube_snapshot_cards csc
          JOIN cards c ON csc.card_id = c.card_id
          WHERE csc.cube_snapshot_id IN (${placeholders(uniqueCubeSnapshots.length)})`,
    args: [...uniqueCubeSnapshots],
  });

  const cubeCardsBySnapshot = new Map<number, Map<number, CubeCardInfo>>();
  const cubeCardIds = new Set<number>();

  for (const row of cubeCardsResult.rows) {
    const snapshotId = row.cube_snapshot_id as number;
    const cardId = row.card_id as number;

    cubeCardIds.add(cardId);

    if (!cubeCardsBySnapshot.has(snapshotId)) {
      cubeCardsBySnapshot.set(snapshotId, new Map());
    }
    cubeCardsBySnapshot.get(snapshotId)!.set(cardId, {
      cardName: row.card_name as string,
      qty: row.qty as number,
    });
  }

  return { cubeCardsBySnapshot, cubeCardIds };
}

/**
 * Step 4b: Load Scryfall data ONCE per distinct card_id.
 * Combines pick card_ids and cube card_ids, then fetches scryfall_json in a single
 * batched query. Returns a Map<cardNameKey, ScryCard> for downstream consumers.
 * Transferring 2-8 KB blobs once per unique card (vs. once per pick/cube row) cuts
 * data transfer by ~100× on a 450-pick draft with 10 clients.
 */
async function loadScryfallDataForCards(
  client: Client,
  allCardIds: Set<number>
): Promise<Map<string, ScryCard>> {
  if (allCardIds.size === 0) return new Map();

  const ids = [...allCardIds];
  const result = await client.execute({
    sql: `SELECT card_id, name, scryfall_json
          FROM cards
          WHERE card_id IN (${placeholders(ids.length)})`,
    args: [...ids],
  });

  const scryfallDataMap = new Map<string, ScryCard>();
  for (const row of result.rows) {
    const cardName = row.name as string;
    const key = cardNameKey(cardName);
    if (!scryfallDataMap.has(key)) {
      const scryData = transformScryfallJson(row.scryfall_json as string | null, cardName);
      if (scryData) {
        scryfallDataMap.set(key, scryData);
      }
    }
  }
  return scryfallDataMap;
}

/**
 * Step 5: Combine picked + unpicked cards from selected drafts.
 * Pure computation (no DB queries). Uses the pre-loaded scryfallDataMap to
 * fill in color for both picked and unpicked entries.
 */
function buildAllPicks(
  selectedDraftIds: string[],
  selectedDraftSet: Set<string>,
  picksByDraftAndCard: Map<string, Map<string, CardPick[]>>,
  cubeCardsBySnapshot: Map<number, Map<number, CubeCardInfo>>,
  draftCubeSnapshots: Map<string, number>,
  poolSizes: Map<number, number>,
  bannedCardsByDraft: Map<string, Set<string>>,
  scryfallDataMap: Map<string, ScryCard>
): CardPick[] {
  const allPicks: CardPick[] = [];

  // Add all picked cards from selected drafts, filling in color from scryfallDataMap
  for (const [draftId, cardPicks] of picksByDraftAndCard) {
    if (!selectedDraftSet.has(draftId)) continue;
    for (const picks of cardPicks.values()) {
      for (const pick of picks) {
        const key = cardNameKey(pick.cardName);
        const scryData = scryfallDataMap.get(key);
        allPicks.push(
          scryData ? { ...pick, color: getColorFromIdentity(scryData.colorIdentity) } : pick
        );
      }
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
 * Step 7: Build cubeCopies and currentCubeSet from the display cube snapshot.
 * Scryfall data is already loaded into scryfallDataMap by loadScryfallDataForCards.
 */
function buildCubeDisplayData(
  displayCubeSnapshotId: number | null,
  cubeCardsBySnapshot: Map<number, Map<number, CubeCardInfo>>
): CubeDisplayData {
  const cubeCopies: Record<string, number> = {};

  if (displayCubeSnapshotId !== null) {
    const currentCube = cubeCardsBySnapshot.get(displayCubeSnapshotId);
    if (currentCube) {
      for (const cardInfo of currentCube.values()) {
        cubeCopies[cardInfo.cardName] = cardInfo.qty;
        // Scryfall data already loaded into scryfallDataMap by loadScryfallDataForCards.
      }
    }
  }

  const currentCubeSet = new Set(Object.keys(cubeCopies));
  const currentCubeKeySet = new Set(Object.keys(cubeCopies).map((n) => cardNameKey(n)));

  return { cubeCopies, currentCubeSet, currentCubeKeySet };
}

/**
 * Steps 8-11: Calculate stats, enrich with Scryfall data, filter to cube, create new card stubs.
 */
function assembleCardStats(
  allPicks: CardPick[],
  scryfallDataMap: Map<string, ScryCard>,
  currentCubeSet: Set<string>,
  currentCubeKeySet: Set<string>,
  sessionsAgoByDraftId: Map<string, number>
): EnrichedCardStats[] {
  // 8. Calculate card stats
  const stats = calculateCardStats(allPicks, sessionsAgoByDraftId);

  // 9. Enrich stats with Scryfall data
  const enrichedStats: EnrichedCardStats[] = stats.map((stat) => {
    const key = cardNameKey(stat.cardName);
    return {
      ...stat,
      scryfall: scryfallDataMap.get(key),
    };
  });

  // 10. Filter to only cards in current cube
  const filteredCards =
    currentCubeKeySet.size > 0
      ? enrichedStats.filter((c) => currentCubeKeySet.has(cardNameKey(c.cardName)))
      : enrichedStats;

  // 11. Find new cards in current cube that have no historical data
  const cardsWithStatsKeys = new Set(stats.map((s) => cardNameKey(s.cardName)));
  const newCards = Array.from(currentCubeSet).filter(
    (name) => !cardsWithStatsKeys.has(cardNameKey(name))
  );

  const newCardEntries: EnrichedCardStats[] = newCards.map((cardName) => ({
    cardName,
    weightedGeomean: Infinity,
    timesAvailable: 0,
    draftsPickedIn: 0,
    maxCopiesInDraft: 0,
    colors: [] as string[],
    scryfall: scryfallDataMap.get(cardNameKey(cardName)),
  }));

  return [...filteredCards, ...newCardEntries];
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
    draftIds,
    completedDraftIds,
    draftMetadataMap,
    draftCubeSnapshots,
    mostRecentCubeSnapshotId,
    bannedCardsByDraft,
    bannedCardNamesByDraft,
    ingestionHash,
  } = draftMeta;

  const completedDraftIdSet = new Set(completedDraftIds);
  const selectedDraftIds: string[] = params.draftIds
    ? params.draftIds.filter((id) => completedDraftIdSet.has(id))
    : completedDraftIds;

  const selectedDraftSet = new Set(selectedDraftIds);

  // Session ordinals span every completed draft, not the selection: how much
  // drafting has happened since a pick is a fact about the history, so
  // deselecting an interior session must not re-weight the ones around it.
  // This also keeps the main table's P# equal to the stats modal's.
  const sessionsAgo = sessionsAgoByDraft(
    completedDraftIds.map((draftId) => ({
      draftId,
      draftDate: draftMetadataMap.get(draftId)!.date,
    }))
  );

  // 2. Collect cube snapshots needed for selected drafts + display snapshot
  const selectedSnapshotIds = new Set<number>();
  for (const id of selectedDraftIds) {
    const snap = draftCubeSnapshots.get(id);
    if (snap !== undefined) selectedSnapshotIds.add(snap);
  }
  // Ensure display snapshot is included (for pool filtering / cube display)
  const displayCubeSnapshotId = params.poolAsOfDraft
    ? (draftCubeSnapshots.get(params.poolAsOfDraft) ?? mostRecentCubeSnapshotId)
    : mostRecentCubeSnapshotId;
  if (displayCubeSnapshotId !== null) selectedSnapshotIds.add(displayCubeSnapshotId);

  const uniqueCubeSnapshots = [...selectedSnapshotIds];
  const poolSizes = await getCubePoolSizes(client, uniqueCubeSnapshots);

  // 3. Load picks scoped to selected drafts (no scryfall_json — lean rows)
  const { cardIds: pickCardIds, picksByDraftAndCard } = await loadPickEvents(
    client,
    selectedDraftIds
  );

  // 4. Load cube snapshot cards to find unpicked cards (no scryfall_json)
  const { cubeCardsBySnapshot, cubeCardIds } = await loadCubeCards(client, uniqueCubeSnapshots);

  // 4b. Load Scryfall data once per distinct card — one batch query for all
  //     pick + cube card_ids combined. This replaces the old pattern of joining
  //     scryfall_json onto every pick/cube row (450 picks × N drafts = tens of MB).
  const allCardIds = new Set([...pickCardIds, ...cubeCardIds]);
  const scryfallDataMap = await loadScryfallDataForCards(client, allCardIds);

  // 5. Build picks array from selected drafts, including unpicked entries
  const allPicks = buildAllPicks(
    selectedDraftIds,
    selectedDraftSet,
    picksByDraftAndCard,
    cubeCardsBySnapshot,
    draftCubeSnapshots,
    poolSizes,
    bannedCardsByDraft,
    scryfallDataMap
  );

  // 6. Build cube display data from the selected pool snapshot
  const { cubeCopies, currentCubeSet, currentCubeKeySet } = buildCubeDisplayData(
    displayCubeSnapshotId,
    cubeCardsBySnapshot
  );

  // 8-11. Calculate stats, enrich, filter, add new card stubs
  const allCards = assembleCardStats(
    allPicks,
    scryfallDataMap,
    currentCubeSet,
    currentCubeKeySet,
    sessionsAgo
  );

  // Convert draftMetadata Map to plain object
  const draftMetadataObj: Record<string, { name: string; date: string; numDrafters: number }> = {};
  for (const [id, meta] of draftMetadataMap) {
    draftMetadataObj[id] = {
      name: meta.name,
      date: meta.date,
      numDrafters: meta.numDrafters ?? DEFAULT_NUM_SEATS,
    };
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
    `[getCards] Loaded ${allCards.length} cards from ${selectedDraftIds.length}/${draftIds.length} drafts`
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
