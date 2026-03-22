import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { Client } from "@libsql/client";
import {
  parseDraftPicks,
  parsePool,
  normalizeCardName,
  isDraftComplete,
} from "../../parseCsv";
import { parseMatches } from "../../parseMatches";
import type { ScryCard } from "../../types";
import type { IngestDraftMetadata } from "./utils";
import { log, logIndent, generateOracleId, computeCubeHash } from "./utils";
import {
  createDraft,
  ensureCard,
  ensureCubeSnapshot,
  insertPickEvent,
  insertMatchEvent,
  insertOptOuts,
} from "./db-helpers";
import type { DraftFolder } from "./discover";

/**
 * Ingest decklists from pre-generated JSON files.
 * Reads data/<draft>/decks/<seat>.json files referenced by decklists.csv.
 */
export async function ingestDecklists(
  client: Client,
  draftId: string,
  draftPath: string,
  cardNameToId: Map<string, number>,
): Promise<number> {
  const decksDir = join(draftPath, "decks");

  if (!existsSync(decksDir)) {
    log(`Warning: decklists.csv exists but no decks/ directory for ${draftId}`);
    return 0;
  }

  const decklistsCsv = readFileSync(join(draftPath, "decklists.csv"), "utf-8");
  const lines = decklistsCsv.trim().split("\n").slice(1); // skip header

  let deckCount = 0;

  for (const line of lines) {
    const [seatStr] = line.split(",");
    const seat = parseInt(seatStr, 10);
    if (isNaN(seat)) continue;

    const deckFile = join(decksDir, `${seat}.json`);
    if (!existsSync(deckFile)) {
      log(`Warning: Missing deck file for seat ${seat}: ${deckFile}`);
      continue;
    }

    const deckData = JSON.parse(readFileSync(deckFile, "utf-8")) as {
      sealeddeck_id: string;
      deck: string[];
      sideboard: string[];
    };

    // Insert deck cards
    for (const cardName of deckData.deck) {
      const cardId = cardNameToId.get(normalizeCardName(cardName).toLowerCase());
      if (!cardId) {
        log(`Warning: Deck card not found in cube: "${cardName}" (seat ${seat})`);
        continue;
      }
      await client.execute({
        sql: "INSERT OR IGNORE INTO deck_cards (draft_id, seat, card_id, zone, qty) VALUES (?, ?, ?, 'deck', 1)",
        args: [draftId, seat, cardId],
      });
    }

    // Insert sideboard cards
    for (const cardName of deckData.sideboard) {
      const cardId = cardNameToId.get(normalizeCardName(cardName).toLowerCase());
      if (!cardId) {
        // Sideboard may include cards not in cube (e.g. basic lands) — skip silently
        continue;
      }
      await client.execute({
        sql: "INSERT OR IGNORE INTO deck_cards (draft_id, seat, card_id, zone, qty) VALUES (?, ?, ?, 'sideboard', 1)",
        args: [draftId, seat, cardId],
      });
    }

    deckCount++;
  }

  return deckCount;
}

/**
 * Inner function that processes draft data.
 * Called by processDraft after checking for existing data.
 */
export async function processDraftInner(
  client: Client,
  draft: DraftFolder,
  scryfallCache: Map<string, ScryCard>,
  importHash: string,
  optOutNames: Set<string>
): Promise<{ imported: boolean; skipped: boolean; error?: string }> {
  const { draftId, path: draftPath } = draft;
  const startTime = Date.now();

  // Load metadata
  let metadata: IngestDraftMetadata = {
    name: draftId,
    date: new Date().toISOString().split("T")[0],
  };

  if (draft.hasMetadata) {
    try {
      const metadataContent = readFileSync(
        join(draftPath, "metadata.json"),
        "utf-8"
      );
      metadata = JSON.parse(metadataContent) as IngestDraftMetadata;
    } catch (error) {
      log(`Warning: Failed to parse metadata.json: ${error}`);
    }
  }

  // Load pool.csv
  const poolCsv = readFileSync(join(draftPath, "pool.csv"), "utf-8");
  const poolCardNames = parsePool(poolCsv);

  if (poolCardNames.length === 0) {
    return { imported: false, skipped: false, error: "Empty pool" };
  }

  // Resolve cards from pool
  const cardNameCounts = new Map<string, number>();
  for (const cardName of poolCardNames) {
    const normalized = normalizeCardName(cardName);
    cardNameCounts.set(normalized, (cardNameCounts.get(normalized) || 0) + 1);
  }

  // Collect banned card names (bans are removed from the pool before drafting,
  // so they are expected to be absent from pool.csv)
  const bannedCardNames: string[] = [];
  if (metadata.bans && metadata.bans.length > 0) {
    for (const ban of metadata.bans) {
      bannedCardNames.push(normalizeCardName(ban));
    }
    logIndent(`${bannedCardNames.length} banned card(s)`);
  }

  // Map card names to card IDs
  const cardNameToId = new Map<string, number>();

  for (const [cardName] of cardNameCounts) {
    const scryfallData = scryfallCache.get(cardName.toLowerCase());

    let oracleId: string;
    let scryfallJson: string | null = null;
    let displayName = cardName;

    if (scryfallData) {
      // Generate oracle_id from card name (Scryfall cache doesn't have oracle_id)
      oracleId = generateOracleId(scryfallData.name);
      displayName = scryfallData.name;
      // Store full Scryfall data as JSON
      scryfallJson = JSON.stringify({
        name: scryfallData.name,
        color_identity: scryfallData.colorIdentity,
        colors: scryfallData.colors,
        type_line: scryfallData.typeLine,
        oracle_text: scryfallData.oracleText,
        mana_cost: scryfallData.manaCost,
        cmc: scryfallData.manaValue,
        image_uris: scryfallData.imageUri ? { normal: scryfallData.imageUri } : undefined,
      });
    } else {
      oracleId = generateOracleId(cardName);
      log(`Warning: Card not in Scryfall cache: "${cardName}"`);
    }

    const cardId = await ensureCard(client, oracleId, displayName, scryfallJson);
    cardNameToId.set(cardName.toLowerCase(), cardId);
  }

  // Build cube snapshot
  const cubeHash = computeCubeHash(poolCardNames);
  const cardIdsForSnapshot = new Map<
    string,
    { cardId: number; qty: number }
  >();

  for (const [cardName, qty] of cardNameCounts) {
    const cardId = cardNameToId.get(cardName.toLowerCase())!;
    cardIdsForSnapshot.set(cardName, { cardId, qty });
  }

  const cubeSnapshotId = await ensureCubeSnapshot(
    client,
    cubeHash,
    cardIdsForSnapshot
  );

  // Load picks.csv
  const picksCsv = readFileSync(join(draftPath, "picks.csv"), "utf-8");
  const { picks, drafterNames } = parseDraftPicks(picksCsv, draftId);

  if (picks.length === 0) {
    return { imported: false, skipped: false, error: "No picks found" };
  }

  // Number of seats = number of unique drafter columns
  const numSeats = drafterNames.length;
  const isComplete = isDraftComplete(picksCsv);

  // Create draft with num_seats and completion status
  await createDraft(
    client,
    draftId,
    metadata.name,
    metadata.date,
    cubeSnapshotId,
    importHash,
    numSeats,
    isComplete,
    metadata.sheetId ?? null,
    bannedCardNames.length > 0 ? JSON.stringify(bannedCardNames) : null
  );

  // Validate and insert picks
  // Sort by pick position for contiguity check
  const sortedPicks = [...picks].sort(
    (a, b) => a.pickPosition - b.pickPosition
  );

  // Build map of pick positions for gap detection
  const pickPositions = new Set<number>();
  for (const pick of sortedPicks) {
    pickPositions.add(pick.pickPosition);
  }

  // Check for gaps in picks (warn but continue)
  const maxPick = Math.max(...pickPositions);
  const missingPicks: number[] = [];
  for (let i = 1; i <= maxPick; i++) {
    if (!pickPositions.has(i)) {
      missingPicks.push(i);
    }
  }
  if (missingPicks.length > 0) {
    logIndent(
      `Warning: ${missingPicks.length} missing pick(s): ${missingPicks.slice(0, 5).join(", ")}${missingPicks.length > 5 ? "..." : ""}`
    );
  }

  // Insert pick events with seat (1-indexed)
  for (const pick of sortedPicks) {
    const normalizedName = normalizeCardName(pick.cardName);
    const cardId = cardNameToId.get(normalizedName.toLowerCase());

    if (!cardId) {
      return {
        imported: false,
        skipped: false,
        error: `Pick ${pick.pickPosition} references "${pick.cardName}" - no matching card in cube`,
      };
    }

    // pick.seat is 0-indexed from parseDraftPicks, convert to 1-indexed
    const seat = pick.seat + 1;
    await insertPickEvent(client, draftId, pick.pickPosition, seat, cardId);
  }

  // Process matches if available
  let matchCount = 0;

  if (draft.hasMatchesCsv) {
    const matchesCsv = readFileSync(join(draftPath, "matches.csv"), "utf-8");

    // Build a map from player names to seat numbers (0-indexed for parseMatches)
    const playerNameToSeat = new Map<string, number>();
    for (let seat = 0; seat < drafterNames.length; seat++) {
      const name = drafterNames[seat];
      playerNameToSeat.set(name, seat);
      playerNameToSeat.set(name.toLowerCase(), seat);
    }

    // Parse matches - returns seat-based match results (0-indexed)
    const matches = parseMatches(matchesCsv, playerNameToSeat);

    // Insert matches with seats (convert to 1-indexed)
    for (const match of matches) {
      // Convert from 0-indexed to 1-indexed seats
      const seat1 = match.seat1 + 1;
      const seat2 = match.seat2 + 1;

      if (seat1 < 1 || seat1 > numSeats) {
        return {
          imported: false,
          skipped: false,
          error: `Match references invalid seat ${seat1}`,
        };
      }

      if (seat2 < 1 || seat2 > numSeats) {
        return {
          imported: false,
          skipped: false,
          error: `Match references invalid seat ${seat2}`,
        };
      }

      await insertMatchEvent(
        client,
        draftId,
        seat1,
        seat2,
        match.seat1GamesWon,
        match.seat2GamesWon
      );
      matchCount++;
    }
  }

  // Process opt-outs
  let optOutCount = 0;
  if (optOutNames.size > 0) {
    optOutCount = await insertOptOuts(client, draftId, drafterNames, optOutNames);
  }

  // Process decklists if available
  let deckCount = 0;

  if (draft.hasDecklistsCsv) {
    deckCount = await ingestDecklists(client, draftId, draftPath, cardNameToId);

    // Store deck hashes for future incremental runs
    const decksDir = join(draftPath, "decks");
    if (existsSync(decksDir)) {
      const decklistsCsv = readFileSync(
        join(draftPath, "decklists.csv"),
        "utf-8",
      );
      const deckLines = decklistsCsv.trim().split("\n").slice(1);
      for (const line of deckLines) {
        const [seatStr] = line.split(",");
        const seat = parseInt(seatStr, 10);
        if (isNaN(seat)) continue;
        const deckFile = join(decksDir, `${seat}.json`);
        if (!existsSync(deckFile)) continue;
        const deckContent = readFileSync(deckFile, "utf-8");
        const deckHash = createHash("sha256")
          .update(deckContent)
          .digest("hex")
          .slice(0, 16);
        await client.execute({
          sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash) VALUES (?, ?, ?)",
          args: [draftId, seat, deckHash],
        });
      }
    }
  }

  // Log summary
  logIndent(`${cardNameCounts.size} cards in pool`);
  logIndent(`${numSeats} seats`);
  logIndent(`${picks.length} picks`);
  if (matchCount > 0) {
    logIndent(`${matchCount} matches`);
  }
  if (deckCount > 0) {
    logIndent(`${deckCount} decklists`);
  }
  if (optOutCount > 0) {
    logIndent(`${optOutCount} opt-out(s)`);
  }
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logIndent(`Done (full import, ${elapsed}s, import_hash: ${importHash})`);

  return { imported: true, skipped: false };
}
