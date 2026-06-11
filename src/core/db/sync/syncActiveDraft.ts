/**
 * Per-draft sync function for the serverless cron path (GET /api/sync).
 *
 * syncActiveDraft handles ONE active draft per invocation:
 *   1. Fetch sheet tabs from Google Sheets
 *   2. Parse picks and run incremental ingestion (append-only, no pool rebuild)
 *   3. Sync matches via hash-compare → delete + replace if changed
 *
 * This is the INCREMENTAL path. It intentionally omits pool sync, cube snapshot
 * rebuild, opt-out sync, and Scryfall backfill — those are full-domain operations
 * only the CLI sync (scripts/sync.ts → syncAll → syncDraft) performs.
 *
 * The matches block shares buildMatchInserts from batch.ts with syncDraft in
 * index.ts, ensuring a single copy of the 0-indexed → 1-indexed seat mapping.
 */

import type { Client } from "@libsql/client";
import { fetchDraftTabsRaw } from "../../sheets";
import { parsePickRows, parseMatchRows } from "../../parseSheetRows";
import { incrementalIngest } from "./incremental";
import {
  hashMatches,
  getDomainHashes,
  compareDomainHash,
  updateDomainHashes,
} from "./domains";
import {
  batchInsertMatches,
  buildMatchInserts,
  deleteDomainData,
} from "./batch";

export interface SyncActiveDraftResult {
  draftId: string;
  picksInserted: number;
  matchesReplaced: number;
  status: "no_change" | "updated" | "completed" | "diverged";
  diverged: boolean;
}

/**
 * Sync a single active draft for the cron path.
 *
 * Fetches sheet tabs, runs incremental pick ingestion, and hash-compares matches.
 * Does NOT rebuild pool, cube snapshots, opt-outs, or Scryfall data — use the
 * CLI sync (pnpm sync) for full-domain replacement.
 *
 * Throws on unrecoverable errors (e.g. Sheets API failure); the caller is
 * responsible for per-draft try/catch to continue syncing other drafts.
 */
export async function syncActiveDraft(
  client: Client,
  draft: { draftId: string; sheetId: string },
  apiKey: string,
): Promise<SyncActiveDraftResult> {
  const result: SyncActiveDraftResult = {
    draftId: draft.draftId,
    picksInserted: 0,
    matchesReplaced: 0,
    status: "no_change",
    diverged: false,
  };

  // Fetch row data from Google Sheets
  const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

  if (!sheetData.picks) {
    console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
    return result;
  }

  // Parse rows and run incremental pick ingestion
  const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
  const ingestResult = await incrementalIngest(client, draft.draftId, parsedPicks);

  result.picksInserted = ingestResult.picksInserted;
  result.status = ingestResult.status;

  if (ingestResult.status === "diverged") {
    console.warn(
      `[sync] Draft ${draft.draftId} has diverged data — run pnpm sync to fix`,
    );
    result.diverged = true;
  }

  // Sync matches via hash-compare + replace
  // Uses buildMatchInserts (shared with CLI syncDraft) for the 0→1 seat mapping.
  const matches = parseMatchRows(sheetData.matches, parsedPicks.drafterNames);
  if (matches.length > 0) {
    const newMatchesHash = hashMatches(matches);
    const stored = await getDomainHashes(client, draft.draftId);
    const storedMatchesHash = stored?.matchesHash ?? null;

    if (compareDomainHash(newMatchesHash, storedMatchesHash) === "replace") {
      await deleteDomainData(client, draft.draftId, "matches");

      const matchInserts = buildMatchInserts(draft.draftId, matches);
      await batchInsertMatches(client, matchInserts);
      await updateDomainHashes(client, draft.draftId, {
        matchesHash: newMatchesHash,
      });

      result.matchesReplaced = matchInserts.length;
      console.log(
        `[sync] Replaced ${matchInserts.length} matches for draft ${draft.draftId}`,
      );

      // Upgrade status to reflect matches were also updated
      if (result.status === "no_change") {
        result.status = "updated";
      }
    }
  }

  return result;
}
