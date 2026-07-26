// src/core/db/sync/index.ts
//
// Full-domain sync orchestrator for the CLI entry point (scripts/sync.ts).
//
// Entry points:
//   syncAll / syncDraft  — Full-domain replacement (pool + picks + matches +
//                          cube snapshots + opt-outs + Scryfall backfill).
//                          Used by: pnpm sync (CLI), pnpm draft:reset.
//                          Must be used when the pool changes or a full reimport
//                          is needed (e.g. after a divergence warning).
//
//   syncActiveDraft      — Incremental cron path (insert missing picks + hash-compare
//   (syncActiveDraft.ts)   matches only, no pool/cube/opt-out rebuild).
//                          Used by: GET /api/sync (Vercel cron, every 10 min).
//
// Both paths share buildMatchInserts (batch.ts) for the 0-indexed → 1-indexed
// seat conversion, ensuring a single copy of that mapping in the codebase.

import type { Client } from "@libsql/client";
import type { DraftSheetRawData } from "../../sheets";
import type { ScryCard } from "../../types";
import {
  parsePoolRows,
  parsePickRows,
  parseMatchRows,
  normalizeCardName,
} from "../../parseSheetRows";
import {
  hashPool,
  hashPicks,
  hashMatches,
  compareDomainHash,
  getDomainHashes,
  updateDomainHashes,
} from "./domains";
import {
  batchInsertPicks,
  batchInsertMatches,
  buildMatchInserts,
  deleteDomainData,
} from "./batch";
import type { PickInsert } from "./batch";
import { CardCache } from "./card-cache";
import {
  computeCubeHash,
  loadEnv,
  log,
  logIndent,
} from "../ingest/utils";
import { ensureCubeSnapshot, insertOptOuts } from "../ingest/db-helpers";
import {
  loadScryfallCache,
  backfillScryfallData,
} from "../ingest/scryfall";
import { resolveCardNamesToCache } from "../ingest/serializeScryfall";
import { fetchDraftTabsRaw } from "../../sheets";
import { loadOptOutNames } from "../../optOuts";
import { isSyncPhaseTransitionLegal } from "../../draftPhases";

// ============================================================================
// Types
// ============================================================================

export interface SyncOptions {
  dryRun?: boolean;
  verbose?: boolean;
}

export interface SyncDraftResult {
  draftId: string;
  poolAction: "skip" | "replace";
  picksAction: "skip" | "replace";
  matchesAction: "skip" | "replace";
  picksCount: number;
  matchesCount: number;
  markedComplete: boolean;
  error?: string;
}

export interface SyncRunResult {
  results: SyncDraftResult[];
  errors: string[];
}

// ============================================================================
// Per-Draft Sync
// ============================================================================

/**
 * Sync a single draft from parsed Sheets data.
 *
 * 1. Parse raw Sheets data into picks, pool, matches
 * 2. Compute per-domain hashes
 * 3. Read stored hashes from DB
 * 4. For each domain: compare -> skip or (delete + batch insert)
 * 5. Update stored hashes
 * 6. Handle opt-outs
 * 7. Detect completion
 */
export async function syncDraft(
  client: Client,
  draftId: string,
  rawData: DraftSheetRawData,
  cardCache: CardCache,
  scryfallCache: Map<string, ScryCard>,
  optOutNames: Set<string>,
  options: SyncOptions = {},
): Promise<SyncDraftResult> {
  const result: SyncDraftResult = {
    draftId,
    poolAction: "skip",
    picksAction: "skip",
    matchesAction: "skip",
    picksCount: 0,
    matchesCount: 0,
    markedComplete: false,
  };

  try {
    // Parse raw sheet data
    const poolNames = rawData.pool ? parsePoolRows(rawData.pool) : [];
    const parsedPicks = rawData.picks
      ? parsePickRows(rawData.picks, draftId)
      : { picks: [], numDrafters: 0, drafterNames: [], isComplete: true, doublePickStartsAfterRound: null, picksPerPlayer: 0 };
    const matches = parseMatchRows(
      rawData.matches,
      parsedPicks.drafterNames,
    );

    // Compute hashes for current data
    const newPoolHash = poolNames.length > 0 ? hashPool(poolNames) : null;
    const pickedCards = parsedPicks.picks.filter((p) => p.wasPicked);
    const newPicksHash = pickedCards.length > 0 ? hashPicks(pickedCards) : null;
    const newMatchesHash = matches.length > 0 ? hashMatches(matches) : null;

    // Get stored hashes and current phase
    const stored = await getDomainHashes(client, draftId);
    const storedPoolHash = stored?.poolHash ?? null;
    const storedPicksHash = stored?.picksHash ?? null;
    const storedMatchesHash = stored?.matchesHash ?? null;
    const currentPhase = stored?.currentPhase ?? null;

    // Compare each domain
    result.poolAction = newPoolHash
      ? compareDomainHash(newPoolHash, storedPoolHash)
      : "skip";
    result.picksAction = newPicksHash
      ? compareDomainHash(newPicksHash, storedPicksHash)
      : "skip";
    result.matchesAction = newMatchesHash
      ? compareDomainHash(newMatchesHash, storedMatchesHash)
      : "skip";

    if (options.dryRun) {
      result.picksCount = pickedCards.length;
      result.matchesCount = matches.length;
      result.markedComplete = parsedPicks.isComplete;
      return result;
    }

    // --- Pool domain ---
    if (result.poolAction === "replace") {
      await syncPool(client, draftId, poolNames, rawData.pool!, cardCache, scryfallCache);
      if (options.verbose) logIndent(`Pool: replaced (${poolNames.length} cards)`);
    }

    // --- Picks domain ---
    if (result.picksAction === "replace") {
      await deleteDomainData(client, draftId, "picks");

      const pickInserts: PickInsert[] = [];
      for (const pick of pickedCards) {
        const cardId = cardCache.get(pick.cardName);
        if (cardId !== undefined) {
          pickInserts.push({
            draftId,
            pickN: pick.pickPosition,
            seat: pick.seat + 1, // 0-indexed -> 1-indexed
            cardId,
          });
        }
      }

      await batchInsertPicks(client, pickInserts);
      result.picksCount = pickInserts.length;

      if (options.verbose) logIndent(`Picks: replaced (${pickInserts.length} picks)`);
    }

    // Update draft-shape metadata derived from the parsed Draft tab. Written
    // outside the picks-hash gate so a re-sync corrects stale values even when
    // the picks themselves are unchanged.
    if (parsedPicks.numDrafters > 0) {
      await client.execute({
        sql: "UPDATE drafts SET num_seats = ? WHERE draft_id = ?",
        args: [parsedPicks.numDrafters, draftId],
      });
    }
    if (parsedPicks.picksPerPlayer > 0) {
      await client.execute({
        sql: "UPDATE drafts SET picks_per_player = ? WHERE draft_id = ? AND in_app = 0",
        args: [parsedPicks.picksPerPlayer, draftId],
      });
    }

    // --- Matches domain ---
    if (result.matchesAction === "replace") {
      await deleteDomainData(client, draftId, "matches");

      const matchInserts = buildMatchInserts(draftId, matches);
      await batchInsertMatches(client, matchInserts);
      result.matchesCount = matchInserts.length;

      if (options.verbose) logIndent(`Matches: replaced (${matchInserts.length} matches)`);
    }

    // Update stored hashes for changed domains
    const hashUpdates: Record<string, string | null> = {};
    if (result.poolAction === "replace" && newPoolHash) {
      hashUpdates.poolHash = newPoolHash;
    }
    if (result.picksAction === "replace" && newPicksHash) {
      hashUpdates.picksHash = newPicksHash;
    }
    if (result.matchesAction === "replace" && newMatchesHash) {
      hashUpdates.matchesHash = newMatchesHash;
    }
    if (Object.keys(hashUpdates).length > 0) {
      await updateDomainHashes(client, draftId, hashUpdates);
    }

    // Handle opt-outs
    if (parsedPicks.drafterNames.length > 0) {
      await insertOptOuts(client, draftId, parsedPicks.drafterNames, optOutNames);
    }

    // Record the sheet's declared double-pick boundary. Written outside the
    // picks-hash gate so a re-sync backfills drafts whose picks are unchanged.
    // Only when the Draft tab was actually parsed — never clobber a stored
    // value with the empty-parse default.
    if (rawData.picks) {
      await client.execute({
        sql: "UPDATE drafts SET double_pick_after_round = ? WHERE draft_id = ?",
        args: [parsedPicks.doublePickStartsAfterRound, draftId],
      });
    }

    // Detect and update completion.
    // Only write phase when the transition is legal — never demote a draft that an
    // admin has manually set to 'playing' or 'complete' back to 'drafting'.
    result.markedComplete = parsedPicks.isComplete;
    const targetPhase = parsedPicks.isComplete ? 'complete' : 'drafting';
    if (isSyncPhaseTransitionLegal(currentPhase ?? 'drafting', targetPhase)) {
      await client.execute({
        sql: "UPDATE drafts SET phase = ? WHERE draft_id = ?",
        args: [targetPhase, draftId],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
  }

  return result;
}

// ============================================================================
// Pool Sync (card resolution + cube snapshot)
// ============================================================================

/**
 * Resolve pool cards and update the draft's cube snapshot.
 *
 * 1. Count card name occurrences for qty tracking
 * 2. For each unique card, resolve via cardCache / scryfallCache / generate
 * 3. Flush missing cards to DB
 * 4. Build cardId map and compute cube hash
 * 5. ensureCubeSnapshot (handles dedup)
 * 6. Update drafts.cube_snapshot_id
 */
async function syncPool(
  client: Client,
  draftId: string,
  poolNames: string[],
  poolRows: string[][],
  cardCache: CardCache,
  scryfallCache: Map<string, ScryCard>,
): Promise<void> {
  // Count occurrences for qty
  const nameCounts = new Map<string, number>();
  for (const name of poolNames) {
    const normalized = normalizeCardName(name);
    nameCounts.set(normalized, (nameCounts.get(normalized) || 0) + 1);
  }

  const uniqueNames = Array.from(nameCounts.keys());

  // Resolve each unique card name against the Scryfall cache
  resolveCardNamesToCache(uniqueNames, cardCache, scryfallCache);

  // Flush newly discovered cards to DB
  await cardCache.flushMissing(client);

  // Build cardId map for cube snapshot
  const cardIdMap = new Map<string, { cardId: number; qty: number }>();
  for (const name of uniqueNames) {
    const cardId = cardCache.get(name);
    if (cardId !== undefined) {
      cardIdMap.set(name, { cardId, qty: nameCounts.get(name) || 1 });
    }
  }

  // Compute cube hash and ensure snapshot
  const cubeHash = computeCubeHash(uniqueNames);
  const cubeSnapshotId = await ensureCubeSnapshot(client, cubeHash, cardIdMap);

  // Update the draft's cube_snapshot_id
  await client.execute({
    sql: "UPDATE drafts SET cube_snapshot_id = ? WHERE draft_id = ?",
    args: [cubeSnapshotId, draftId],
  });
}

// ============================================================================
// Top-Level Orchestrator
// ============================================================================

export interface SyncAllOptions extends SyncOptions {
  /** Sync only this specific draft (by draft_id). Syncs regardless of completion. */
  filterDraftId?: string;
}

/**
 * Top-level sync: fetch Sheets data for all active drafts, sync each one.
 *
 * 1. Load environment (GOOGLE_SHEETS_API_KEY)
 * 2. Load card cache (bulk from Turso)
 * 3. Load Scryfall cache
 * 4. Load opt-out names
 * 5. Query drafts to sync
 * 6. For each draft: fetch Sheets data, then syncDraft
 * 7. Backfill Scryfall data
 * 8. Return results
 */
export async function syncAll(
  client: Client,
  options: SyncAllOptions = {},
): Promise<SyncRunResult> {
  const runResult: SyncRunResult = { results: [], errors: [] };

  // Load environment
  loadEnv();
  const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
  if (!apiKey) {
    runResult.errors.push("GOOGLE_SHEETS_API_KEY not set");
    return runResult;
  }

  // Load card cache
  const cardCache = new CardCache();
  await cardCache.loadAll(client);
  log(`Card cache loaded: ${cardCache.size} cards`);

  // Load Scryfall cache
  const scryfallCache = loadScryfallCache();
  log(`Scryfall cache loaded: ${scryfallCache.size} entries`);

  // Load opt-out names
  const optOutNames = loadOptOutNames();

  // Query drafts to sync
  let drafts: Array<{ draftId: string; sheetId: string }>;
  if (options.filterDraftId) {
    // Sync a specific draft regardless of completion status
    const result = await client.execute({
      sql: "SELECT draft_id, sheet_id FROM drafts WHERE draft_id = ? AND sheet_id IS NOT NULL",
      args: [options.filterDraftId],
    });
    drafts = result.rows.map((r) => ({
      draftId: r.draft_id as string,
      sheetId: r.sheet_id as string,
    }));
    if (drafts.length === 0) {
      runResult.errors.push(
        `Draft "${options.filterDraftId}" not found or has no sheet_id`,
      );
      return runResult;
    }
  } else {
    // Sync all incomplete drafts with a sheet_id
    const result = await client.execute({
      sql: "SELECT draft_id, sheet_id FROM drafts WHERE sheet_id IS NOT NULL AND phase IN ('setup', 'drafting', 'playing')",
      args: [],
    });
    drafts = result.rows.map((r) => ({
      draftId: r.draft_id as string,
      sheetId: r.sheet_id as string,
    }));
  }

  if (drafts.length === 0) {
    log("No drafts to sync");
    return runResult;
  }

  log(`Syncing ${drafts.length} draft(s)...`);

  // Sync each draft
  for (const draft of drafts) {
    log(`Syncing ${draft.draftId}...`);

    try {
      // Fetch Sheets data
      const rawData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

      // Sync the draft
      const draftResult = await syncDraft(
        client,
        draft.draftId,
        rawData,
        cardCache,
        scryfallCache,
        optOutNames,
        options,
      );

      runResult.results.push(draftResult);

      if (draftResult.error) {
        runResult.errors.push(`${draft.draftId}: ${draftResult.error}`);
      } else {
        const actions = [
          `pool:${draftResult.poolAction}`,
          `picks:${draftResult.picksAction}`,
          `matches:${draftResult.matchesAction}`,
        ].join(", ");
        logIndent(`${actions}${draftResult.markedComplete ? " (complete)" : ""}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runResult.errors.push(`${draft.draftId}: ${message}`);
      runResult.results.push({
        draftId: draft.draftId,
        poolAction: "skip",
        picksAction: "skip",
        matchesAction: "skip",
        picksCount: 0,
        matchesCount: 0,
        markedComplete: false,
        error: message,
      });
    }
  }

  // Backfill Scryfall data for cards missing scryfall_json
  if (!options.dryRun) {
    const backfilled = await backfillScryfallData(client, scryfallCache);
    if (backfilled > 0) {
      log(`Backfilled Scryfall data for ${backfilled} cards`);
    }
  }

  log("Sync complete");
  return runResult;
}
