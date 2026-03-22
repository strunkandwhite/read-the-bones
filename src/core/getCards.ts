/**
 * Server-side card stats computation.
 *
 * Queries the Turso database and returns enriched card statistics.
 * This is the primary data-fetching function for the API layer,
 * replacing the build-time loadCardDataFromTurso().
 */

import { createHash } from "node:crypto";

import { getFrontFace } from "./cardNames";
import {
  DEFAULT_POOL_SIZE,
  type CardPick,
  type DraftMetadata,
  type DraftScore,
  type EnrichedCardStats,
  type ScryCard,
} from "./types";
import { calculateCardStats, DISTRIBUTION_BUCKET_COUNT } from "./calculateStats";
import { getClient } from "./db/client";
import { cardNameKey } from "./parseSheetRows";
import { round3 } from "./utils";

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
  draftMetadata: Record<string, { name: string; date: string }>;
  draftIds: string[];
  completedDraftIds: string[];
  ingestionHash: string;
  takenCards?: Array<{ name: string; seat: number }>;
  bannedCardNames?: string[];
};

/**
 * Transform Scryfall JSON from database to the full ScryCard type (camelCase)
 * with image URI and DFC handling.
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

/**
 * Compute card statistics from the Turso database.
 *
 * When no draftIds are specified, stats are computed across all completed drafts.
 * When draftIds are provided, only those drafts contribute to the stats.
 * The full list of draftIds/completedDraftIds is always returned (for the Settings panel).
 */
export async function getCards(params: GetCardsParams): Promise<CardStatsResponse> {
  const client = await getClient();

  // 1. Load all drafts with metadata (including domain hashes for cache fingerprint)
  const draftsResult = await client.execute({
    sql: `SELECT d.draft_id, d.draft_name, d.draft_date, d.cube_snapshot_id, d.num_seats, d.is_complete, d.banned_cards,
                 d.pool_hash, d.picks_hash, d.matches_hash
          FROM drafts d
          ORDER BY d.draft_date DESC`,
    args: [],
  });

  // Compute cache fingerprint from per-domain hashes
  const combined = draftsResult.rows
    .map((r) => `${r.pool_hash ?? ""}:${r.picks_hash ?? ""}:${r.matches_hash ?? ""}`)
    .join("|");
  const ingestionHash = createHash("sha256").update(combined).digest("hex").slice(0, 16);

  if (draftsResult.rows.length === 0) {
    return {
      cards: [],
      draftCount: 0,
      cubeCopies: {},
      draftMetadata: {},
      draftIds: [],
      completedDraftIds: [],
      ingestionHash,
    };
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
    if (bannedCardsJson) {
      try {
        const names = JSON.parse(bannedCardsJson) as string[];
        const banKeys = new Set(names.map(n => cardNameKey(n)));
        bannedCardsByDraft.set(draftId, banKeys);
        bannedCardNamesByDraft.set(draftId, names);
      } catch {
        // Ignore malformed JSON
      }
    }

    if (Number(row.is_complete) === 1) {
      completedDraftSet.add(draftId);
    }

    // First row is most recent (ordered by date DESC)
    if (mostRecentCubeSnapshotId === null) {
      mostRecentCubeSnapshotId = cubeSnapshotId;
    }
  }

  const completedDraftIds = draftIds.filter((id) => completedDraftSet.has(id));

  // Determine the selected set of drafts for stats computation
  const selectedDraftIds: string[] = params.draftIds
    ? params.draftIds.filter((id) => completedDraftSet.has(id))
    : completedDraftIds;

  const selectedDraftSet = new Set(selectedDraftIds);

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

  // 5. Build picks array from selected drafts, including unpicked entries
  const allPicks: CardPick[] = [];

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

      // Skip banned cards — they get no entry (picked or unpicked) for this draft
      // For DFCs, also check front face (e.g. ban "Fable of the Mirror-Breaker"
      // matches card "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki")
      const draftBans = bannedCardsByDraft.get(draftId);
      if (draftBans) {
        const frontFace = getFrontFace(key);
        if (draftBans.has(key) || (frontFace && draftBans.has(frontFace))) continue;
      }

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

  // 10. Filter to only cards in current cube
  const filteredCards =
    currentCubeSet.size > 0
      ? enrichedStats.filter((c) => currentCubeSet.has(c.cardName))
      : enrichedStats;

  // 11. Find new cards in current cube that have no historical data
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

  // Convert draftMetadata Map to plain object
  const draftMetadataObj: Record<string, { name: string; date: string }> = {};
  for (const [id, meta] of draftMetadataMap) {
    draftMetadataObj[id] = { name: meta.name, date: meta.date };
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
