import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import type { Client } from "@libsql/client";
import {
  parseDraftPicks,
  isDraftComplete,
  normalizeCardName,
} from "../../parseCsv";
import { parseMatches } from "../../parseMatches";
import {
  detectNewPicks,
  detectDivergence,
  getDbMaxPickN,
  resolveCardNameToId,
  insertNewPicks,
  markDraftComplete,
} from "../../sync";
import { log, logIndent } from "./utils";
import { insertOptOuts } from "./db-helpers";
import type { DraftFolder } from "./discover";

/**
 * Incremental pick ingestion. Appends only new picks above the DB's current max.
 * Reuses sync.ts functions shared with the serverless path.
 */
export async function incrementalPicks(
  client: Client,
  draftId: string,
  picksCsv: string,
): Promise<{
  status: "no_change" | "updated" | "completed" | "diverged";
  picksInserted: number;
  drafterNames: string[];
}> {
  const { picks, drafterNames } = parseDraftPicks(picksCsv, draftId);
  if (picks.length === 0) {
    logIndent(`Picks: 0 in CSV, skipping`);
    return { status: "no_change", picksInserted: 0, drafterNames: [] };
  }

  const csvMaxPick = Math.max(...picks.map((p) => p.pickPosition));
  const dbMaxPick = await getDbMaxPickN(client, draftId);

  if (detectDivergence(csvMaxPick, dbMaxPick)) {
    logIndent(`Picks: divergence detected (CSV max ${csvMaxPick} < DB max ${dbMaxPick}) — run --force`);
    return { status: "diverged", picksInserted: 0, drafterNames };
  }

  const newPicks = detectNewPicks(picks, dbMaxPick);
  if (newPicks.length === 0) {
    logIndent(`Picks: ${picks.length} total, 0 new (DB has picks 1-${dbMaxPick})`);
    return { status: "no_change", picksInserted: 0, drafterNames };
  }

  logIndent(`Picks: ${picks.length} total, ${newPicks.length} new (DB had picks 1-${dbMaxPick})`);
  const insertedCount = await insertNewPicks(client, draftId, newPicks);

  // Check if draft just completed
  if (isDraftComplete(picksCsv)) {
    await markDraftComplete(client, draftId);
    logIndent(`Picks: draft marked as complete`);
    return { status: "completed", picksInserted: insertedCount, drafterNames };
  }

  return { status: "updated", picksInserted: insertedCount, drafterNames };
}

/**
 * Incremental match ingestion. INSERT OR IGNORE all matches from CSV.
 * The (draft_id, seat1, seat2) primary key prevents duplicates.
 */
export async function incrementalMatches(
  client: Client,
  draftId: string,
  matchesCsv: string,
  drafterNames: string[],
): Promise<number> {
  // Build player name → seat map (0-indexed for parseMatches)
  const playerNameToSeat = new Map<string, number>();
  for (let seat = 0; seat < drafterNames.length; seat++) {
    const name = drafterNames[seat];
    playerNameToSeat.set(name, seat);
    playerNameToSeat.set(name.toLowerCase(), seat);
  }

  const matches = parseMatches(matchesCsv, playerNameToSeat);

  // Check how many already exist in DB
  const dbCountResult = await client.execute({
    sql: "SELECT COUNT(*) as count FROM match_events WHERE draft_id = ?",
    args: [draftId],
  });
  const dbMatchCount = (dbCountResult.rows[0]?.count as number) ?? 0;

  if (matches.length === 0) {
    logIndent(`Matches: 0 in CSV`);
    return 0;
  }

  if (matches.length < dbMatchCount) {
    logIndent(`Matches: ${matches.length} in CSV, ${dbMatchCount} in DB — CSV has fewer, run --force to reconcile`);
  }

  const newMatches = matches.length - dbMatchCount;

  for (const match of matches) {
    const seat1 = match.seat1 + 1;
    const seat2 = match.seat2 + 1;
    await client.execute({
      sql: `INSERT OR IGNORE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins)
            VALUES (?, ?, ?, ?, ?)`,
      args: [draftId, seat1, seat2, match.seat1GamesWon, match.seat2GamesWon],
    });
  }

  if (newMatches > 0) {
    logIndent(`Matches: ${matches.length} total, ~${newMatches} new`);
  } else {
    logIndent(`Matches: ${matches.length} total, 0 new`);
  }

  return matches.length;
}

/**
 * Incremental decklist ingestion with per-seat hash diffing.
 * Computes SHA-256 of each seat's deck JSON. Compares against stored hashes
 * in deck_hashes table. Only reprocesses seats whose hashes have changed.
 */
export async function incrementalDecklists(
  client: Client,
  draftId: string,
  draftPath: string,
): Promise<number> {
  const decksDir = join(draftPath, "decks");
  const decklistsCsvPath = join(draftPath, "decklists.csv");

  if (!existsSync(decksDir) || !existsSync(decklistsCsvPath)) {
    return 0;
  }

  const decklistsCsv = readFileSync(decklistsCsvPath, "utf-8");
  const lines = decklistsCsv.trim().split("\n").slice(1); // skip header

  // Parse seats from CSV
  const csvSeats: number[] = [];
  for (const line of lines) {
    const [seatStr] = line.split(",");
    const seat = parseInt(seatStr, 10);
    if (!isNaN(seat)) csvSeats.push(seat);
  }

  if (csvSeats.length === 0) {
    logIndent(`Decklists: 0 seats in CSV`);
    return 0;
  }

  // Get stored hashes from DB
  const hashResult = await client.execute({
    sql: "SELECT seat, hash FROM deck_hashes WHERE draft_id = ?",
    args: [draftId],
  });
  const storedHashes = new Map<number, string>();
  for (const row of hashResult.rows) {
    storedHashes.set(row.seat as number, row.hash as string);
  }

  let newCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;

  for (const seat of csvSeats) {
    const deckFile = join(decksDir, `${seat}.json`);
    if (!existsSync(deckFile)) {
      log(`Warning: Missing deck file for seat ${seat}: ${deckFile}`);
      continue;
    }

    const deckContent = readFileSync(deckFile, "utf-8");
    const currentHash = createHash("sha256")
      .update(deckContent)
      .digest("hex")
      .slice(0, 16);

    const storedHash = storedHashes.get(seat);

    // Skip if hash matches
    if (storedHash === currentHash) {
      unchangedCount++;
      continue;
    }

    // If hash differs (resubmission), delete existing deck_cards for this seat
    if (storedHash !== undefined) {
      await client.execute({
        sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
      changedCount++;
    } else {
      newCount++;
    }

    // Parse and insert deck cards
    const deckData = JSON.parse(deckContent) as {
      sealeddeck_id: string;
      deck: string[];
      sideboard: string[];
    };

    for (const cardName of deckData.deck) {
      const cardId = await resolveCardNameToId(
        client,
        normalizeCardName(cardName),
      );
      if (!cardId) {
        log(
          `Warning: Deck card not found in cards table: "${cardName}" (seat ${seat})`,
        );
        continue;
      }
      await client.execute({
        sql: "INSERT OR IGNORE INTO deck_cards (draft_id, seat, card_id, zone, qty) VALUES (?, ?, ?, 'deck', 1)",
        args: [draftId, seat, cardId],
      });
    }

    for (const cardName of deckData.sideboard) {
      const cardId = await resolveCardNameToId(
        client,
        normalizeCardName(cardName),
      );
      if (!cardId) continue; // Sideboard may include basic lands
      await client.execute({
        sql: "INSERT OR IGNORE INTO deck_cards (draft_id, seat, card_id, zone, qty) VALUES (?, ?, ?, 'sideboard', 1)",
        args: [draftId, seat, cardId],
      });
    }

    // Store/update hash
    await client.execute({
      sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash) VALUES (?, ?, ?)",
      args: [draftId, seat, currentHash],
    });
  }

  const parts = [`${csvSeats.length} seats`];
  if (newCount > 0) parts.push(`${newCount} new`);
  if (changedCount > 0) parts.push(`${changedCount} changed`);
  if (unchangedCount > 0) parts.push(`${unchangedCount} unchanged`);
  logIndent(`Decklists: ${parts.join(", ")}`);

  return newCount + changedCount;
}

/**
 * Run the incremental ingestion path for a draft whose hash has changed.
 * Handles picks, matches, decklists, opt-outs, and hash update.
 */
export async function incrementalIngestDraft(
  client: Client,
  draft: DraftFolder,
  importHash: string,
  optOutNames: Set<string>,
): Promise<{ imported: boolean; skipped: boolean; error?: string }> {
  const { draftId, path: draftPath } = draft;
  const startTime = Date.now();

  // Incremental picks
  const picksCsv = readFileSync(join(draftPath, "picks.csv"), "utf-8");
  const pickResult = await incrementalPicks(client, draftId, picksCsv);

  if (pickResult.status === "diverged") {
    return { imported: false, skipped: true };
  }

  // Incremental matches
  if (draft.hasMatchesCsv) {
    const matchesCsv = readFileSync(join(draftPath, "matches.csv"), "utf-8");
    await incrementalMatches(
      client,
      draftId,
      matchesCsv,
      pickResult.drafterNames,
    );
  }

  // Incremental decklists
  if (draft.hasDecklistsCsv) {
    await incrementalDecklists(client, draftId, draftPath);
  }

  // Opt-outs (idempotent, cheap)
  if (optOutNames.size > 0 && pickResult.drafterNames.length > 0) {
    await insertOptOuts(client, draftId, pickResult.drafterNames, optOutNames);
  }

  // Update import hash so next run sees draft as unchanged
  await client.execute({
    sql: "UPDATE drafts SET import_hash = ? WHERE draft_id = ?",
    args: [importHash, draftId],
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logIndent(`Done (incremental, ${elapsed}s, import_hash: ${importHash})`);
  return { imported: true, skipped: false };
}
