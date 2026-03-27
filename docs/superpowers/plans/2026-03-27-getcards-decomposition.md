# getCards Decomposition Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the 469-line getCards function into named subfunctions for readability and testability.

**Architecture:** Extract functions bottom-up (helpers first, then the functions that call them). Keep all functions in the same file since they share types. The main getCards becomes an ~80-line orchestrator.

**Tech Stack:** TypeScript, Turso/libsql, Vitest

---

## Overview

The current `getCards` function in `src/core/getCards.ts` has 11 numbered steps that run 5+ database queries, build pick arrays, compute unpicked entries, calculate stats, load decklist win rates, resolve cube snapshots, and construct the full response. This plan extracts each logical block into a named function.

**Extraction order:** Each task extracts one function, updates `getCards` to call it, and verifies the codebase still typechecks. Tasks are ordered so that each produces a working codebase (no forward references to functions that don't exist yet).

**Shared types:** Several extracted functions need to pass intermediate data between them. We define a few internal types at the top of the file to make signatures readable.

**File:** All changes are in `src/core/getCards.ts` unless otherwise noted.

---

## Task 1: Add internal types for intermediate data

Before extracting functions, define the types that their signatures will reference. This avoids having to inline complex types in every function signature.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add internal types after the existing imports and before `getColorFromIdentity`**

Insert the following block after line 22 (the `round3` import) and before the `GetCardsParams` type on line 24:

```ts
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
```

- [ ] **Step 2: Add `Client` import**

Add the `Client` type import so extracted functions can accept the DB client as a parameter:

```ts
// Change:
import { getClient } from "./db/client";

// To:
import { getClient, type Client } from "./db/client";
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck
```

---

## Task 2: Extract `loadDraftMetadata`

Extract Step 1 of `getCards` (lines 64-134) into a standalone function that queries all drafts, builds metadata maps, computes the ingestion hash, and tracks banned cards.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `loadDraftMetadata` function**

Insert this function after `getColorFromIdentity` and before `getCards`:

```ts
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
```

- [ ] **Step 2: Replace Step 1 in `getCards` with a call to `loadDraftMetadata`**

Replace lines 64-134 in `getCards` (from the `// 1.` comment through the `selectedDraftSet` line) with:

```ts
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
```

Note: The empty-drafts early return now calls `computeIngestionHash([])` instead of using the local `ingestionHash` variable (which no longer exists in that scope). This is functionally equivalent since the original code computed `ingestionHash` from an empty rows array.

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 3: Extract `getCubePoolSizes`

Extract Step 2 of `getCards` (lines 139-153) into a function that queries pool sizes per cube snapshot.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `getCubePoolSizes` function**

Insert after `loadDraftMetadata`:

```ts
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
```

- [ ] **Step 2: Replace Step 2 in `getCards`**

Replace lines 139-153 (from `// 2.` through the `poolSizes` loop) with:

```ts
  // 2. Get pool sizes for each cube snapshot
  const uniqueCubeSnapshots = [...new Set(draftCubeSnapshots.values())];
  const poolSizes = await getCubePoolSizes(client, uniqueCubeSnapshots);
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 4: Extract `loadPickEvents`

Extract Step 3 of `getCards` (lines 156-210) into a function that loads all pick events with Scryfall data and builds the `scryfallDataMap` and `picksByDraftAndCard` structures.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `loadPickEvents` function**

Insert after `getCubePoolSizes`:

```ts
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
```

- [ ] **Step 2: Replace Step 3 in `getCards`**

Replace lines 156-210 (from `// 3.` through the end of the picks loop) with:

```ts
  // 3. Load all picks with card names and Scryfall data
  const { scryfallDataMap, picksByDraftAndCard } = await loadPickEvents(client);
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 5: Extract `loadCubeCards`

Extract Step 4 of `getCards` (lines 213-236) into a function that loads all cards in each cube snapshot.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `loadCubeCards` function**

Insert after `loadPickEvents`:

```ts
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
```

- [ ] **Step 2: Replace Step 4 in `getCards`**

Replace lines 213-236 (from `// 4.` through the end of the cube cards loop) with:

```ts
  // 4. Load cube snapshot cards to find unpicked cards
  const cubeCardsBySnapshot = await loadCubeCards(client, uniqueCubeSnapshots);
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 6: Extract `buildAllPicks`

Extract Step 5 of `getCards` (lines 239-294) into a pure computation function. This is the most complex extraction because it combines picked and unpicked cards, references `bannedCardsByDraft`, and mutates `scryfallDataMap`.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `buildAllPicks` function**

Insert after `loadCubeCards`:

```ts
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
```

- [ ] **Step 2: Replace Step 5 in `getCards`**

Replace lines 239-294 (from `// 5.` through the end of the unpicked cards loop) with:

```ts
  // 5. Build picks array from selected drafts, including unpicked entries
  const allPicks = buildAllPicks(
    selectedDraftIds, selectedDraftSet, picksByDraftAndCard,
    cubeCardsBySnapshot, draftCubeSnapshots, poolSizes,
    bannedCardsByDraft, scryfallDataMap,
  );
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 7: Extract `loadDecklistWinRates`

Extract Step 6 of `getCards` (lines 297-339) into a function that conditionally fetches win rate data.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `loadDecklistWinRates` function**

Insert after `buildAllPicks`:

```ts
/**
 * Step 6: Conditionally fetch win rate data from deck_cards + match_events.
 * Returns an empty map when includeMatchData is false.
 */
async function loadDecklistWinRates(
  client: Client,
  includeMatchData: boolean,
): Promise<Map<string, DecklistWinRateData>> {
  const decklistWinRates = new Map<string, DecklistWinRateData>();

  if (!includeMatchData) return decklistWinRates;

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

  return decklistWinRates;
}
```

- [ ] **Step 2: Replace Step 6 in `getCards`**

Replace lines 297-339 (from `// 6.` through the end of the decklist loop) with:

```ts
  // 6. Conditionally load decklist win rate data
  const decklistWinRates = await loadDecklistWinRates(client, params.includeMatchData);
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 8: Extract `buildCubeDisplayData`

Extract Step 7 of `getCards` (lines 342-368) into a pure computation function that builds `cubeCopies` and `currentCubeSet` from the display snapshot.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `buildCubeDisplayData` function**

Insert after `loadDecklistWinRates`:

```ts
/**
 * Step 7: Build cubeCopies and currentCubeSet from the display cube snapshot.
 * Mutates scryfallDataMap to add Scryfall data for current cube cards not seen elsewhere.
 */
function buildCubeDisplayData(
  displayCubeSnapshotId: number | null,
  cubeCardsBySnapshot: Map<number, Map<number, CubeCardInfo>>,
  scryfallDataMap: Map<string, ScryCard>,
): CubeDisplayData {
  const cubeCopies: Record<string, number> = {};

  if (displayCubeSnapshotId !== null) {
    const currentCube = cubeCardsBySnapshot.get(displayCubeSnapshotId);
    if (currentCube) {
      for (const cardInfo of currentCube.values()) {
        cubeCopies[cardInfo.cardName] = cardInfo.qty;

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

  return { cubeCopies, currentCubeSet, currentCubeKeySet };
}
```

- [ ] **Step 2: Replace Step 7 in `getCards`**

Replace lines 342-368 (from `// 7.` through the `currentCubeKeySet` line) with:

```ts
  // 7. Load cube cards for the selected pool snapshot
  const displayCubeSnapshotId = params.poolAsOfDraft
    ? draftCubeSnapshots.get(params.poolAsOfDraft) ?? mostRecentCubeSnapshotId
    : mostRecentCubeSnapshotId;

  const { cubeCopies, currentCubeSet, currentCubeKeySet } = buildCubeDisplayData(
    displayCubeSnapshotId, cubeCardsBySnapshot, scryfallDataMap,
  );
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 9: Extract `assembleCardStats`

Extract Steps 8-11 of `getCards` (lines 371-418) into a function that calculates stats, enriches with Scryfall data, filters to cube, and creates new card stubs.

**File:** `src/core/getCards.ts`

- [ ] **Step 1: Add the `assembleCardStats` function**

Insert after `buildCubeDisplayData`:

```ts
/**
 * Steps 8-11: Calculate stats, enrich with Scryfall data, filter to cube, create new card stubs.
 */
function assembleCardStats(
  allPicks: CardPick[],
  draftMetadataMap: Map<string, DraftMetadata>,
  scryfallDataMap: Map<string, ScryCard>,
  currentCubeSet: Set<string>,
  currentCubeKeySet: Set<string>,
  decklistWinRates: Map<string, DecklistWinRateData>,
  includeMatchData: boolean,
): EnrichedCardStats[] {
  // 8. Calculate card stats
  const stats = calculateCardStats(allPicks, draftMetadataMap);

  // Attach decklist win rates
  if (includeMatchData) {
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

  return [...filteredCards, ...newCardEntries];
}
```

- [ ] **Step 2: Replace Steps 8-11 in `getCards`**

Replace lines 371-418 (from `// 8.` through the `allCards` line) with:

```ts
  // 8-11. Calculate stats, enrich, filter, add new card stubs
  const allCards = assembleCardStats(
    allPicks, draftMetadataMap, scryfallDataMap,
    currentCubeSet, currentCubeKeySet, decklistWinRates, params.includeMatchData,
  );
```

- [ ] **Step 3: Verify typecheck and run tests**

```bash
pnpm typecheck && pnpm test
```

---

## Task 10: Final review of the orchestrator

After all extractions, the `getCards` function should be approximately 80 lines. This task verifies the final shape and runs the full quality gate.

- [ ] **Step 1: Verify the final `getCards` function reads as a clear orchestrator**

The function body should now look approximately like this:

```ts
export async function getCards(params: GetCardsParams): Promise<CardStatsResponse> {
  const client = await getClient();

  // 1. Load all drafts with metadata
  const draftMeta = await loadDraftMetadata(client);

  if (!draftMeta) {
    return {
      cards: [], draftCount: 0, cubeCopies: {}, draftMetadata: {},
      draftIds: [], completedDraftIds: [], ingestionHash: computeIngestionHash([]),
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
  const decklistWinRates = await loadDecklistWinRates(client, params.includeMatchData);

  // 7. Load cube cards for the selected pool snapshot
  const displayCubeSnapshotId = params.poolAsOfDraft
    ? draftCubeSnapshots.get(params.poolAsOfDraft) ?? mostRecentCubeSnapshotId
    : mostRecentCubeSnapshotId;

  const { cubeCopies, currentCubeSet, currentCubeKeySet } = buildCubeDisplayData(
    displayCubeSnapshotId, cubeCardsBySnapshot, scryfallDataMap,
  );

  // 8-11. Calculate stats, enrich, filter, add new card stubs
  const allCards = assembleCardStats(
    allPicks, draftMetadataMap, scryfallDataMap,
    currentCubeSet, currentCubeKeySet, decklistWinRates, params.includeMatchData,
  );

  // Convert draftMetadata Map to plain object
  const draftMetadataObj: Record<string, { name: string; date: string; numDrafters: number }> = {};
  for (const [id, meta] of draftMetadataMap) {
    draftMetadataObj[id] = { name: meta.name, date: meta.date, numDrafters: meta.numDrafters ?? 10 };
  }

  // Query taken cards for active draft
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

  // Get banned card names for active draft
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
```

- [ ] **Step 2: Run the full quality gate**

```bash
pnpm typecheck && pnpm lint && pnpm knip && pnpm test
```

- [ ] **Step 3: Commit**

```bash
git add src/core/getCards.ts
git commit -m "refactor: decompose getCards into named subfunctions for readability

Extract 8 functions from the 469-line monolith: loadDraftMetadata, getCubePoolSizes,
loadPickEvents, loadCubeCards, buildAllPicks, loadDecklistWinRates, buildCubeDisplayData,
assembleCardStats. The main getCards is now an ~80-line orchestrator.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>"
```
