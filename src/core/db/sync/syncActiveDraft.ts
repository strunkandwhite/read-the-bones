/**
 * Per-draft sync function for the serverless cron path (GET /api/sync).
 *
 * syncActiveDraft handles ONE active draft per invocation:
 *   1. Fetch sheet tabs from Google Sheets
 *   2. Parse picks and run incremental ingestion (inserts missing picks, no pool rebuild)
 *   3. Sync matches via hash-compare → delete + replace if changed
 *   4. Advance the phase (drafting → playing → complete) when the sheet calls for it
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
import { incrementalIngest, setDraftPhase } from "./incremental";
import { filterRedactedPicks, reconcileRedactedRows } from "../ingest/redaction";
import { hashMatches, getDomainHashes, compareDomainHash, updateDomainHashes } from "./domains";
import { batchInsertMatches, buildMatchInserts, deleteDomainData } from "./batch";
import {
  computeSyncTargetPhase,
  isMatchesComplete,
  isSyncPhaseTransitionLegal,
} from "../../draftPhases";

export interface SyncActiveDraftResult {
  draftId: string;
  picksInserted: number;
  picksUpdated: number;
  matchesReplaced: number;
  status: "no_change" | "updated" | "completed" | "diverged" | "awaiting_cli_sync";
  diverged: boolean;
  /** Phase written this run, or null when no transition happened. */
  phaseSet: "drafting" | "playing" | "complete" | null;
}

/**
 * Sync a single active draft for the cron path.
 *
 * 1. Fetch sheet tabs from Google Sheets
 * 2. Reconcile picks (insert missing positions, update post-hoc edits)
 * 3. Sync matches via hash-compare → delete + replace if changed
 * 4. Advance the phase: drafting → playing when all picks are in,
 *    playing → complete when the full round robin is recorded.
 *
 * This is the INCREMENTAL path. It intentionally omits pool sync, cube
 * snapshot rebuild, opt-out sync, and Scryfall backfill — those are
 * full-domain operations only the CLI sync performs.
 *
 * Throws on unrecoverable errors (e.g. Sheets API failure); the caller is
 * responsible for per-draft try/catch to continue syncing other drafts.
 */
export async function syncActiveDraft(
  client: Client,
  draft: { draftId: string; sheetId: string },
  apiKey: string
): Promise<SyncActiveDraftResult> {
  const result: SyncActiveDraftResult = {
    draftId: draft.draftId,
    picksInserted: 0,
    picksUpdated: 0,
    matchesReplaced: 0,
    status: "no_change",
    diverged: false,
    phaseSet: null,
  };

  const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

  if (!sheetData.picks) {
    console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
    return result;
  }

  // Reconcile picks (inserts + post-hoc edit updates)
  const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
  const stored = await getDomainHashes(client, draft.draftId);

  // A draft leaves 'setup' only when a sync actually ingests its picks, and
  // the CLI is the only path that can do that for the first time: it is
  // what records opt-outs (from the gitignored .opt-outs.json, never
  // deployed here) before anything is written. A draft still in 'setup' has
  // not had that first CLI sync yet, so ingesting here would write an
  // opted-out seat's picks unredacted. The pool and cube snapshot also only
  // ever land via the CLI, so there is no useful work to do here either.
  if (!stored || stored.currentPhase === "setup") {
    console.log(`[sync] Draft ${draft.draftId} is awaiting its first CLI sync — skipping`);
    result.status = "awaiting_cli_sync";
    return result;
  }

  // Delete any stored rows for opted-out seats BEFORE ingesting. Order is
  // load-bearing: incrementalIngest flags divergence when the DB holds a
  // position the parsed picks do not, so filtering while the rows are still
  // present would read as sheet deletions and halt the sync.
  const { optedOutSeats } = await reconcileRedactedRows(client, draft.draftId);
  const redactedPicks = {
    ...parsedPicks,
    picks: filterRedactedPicks(parsedPicks.picks, optedOutSeats),
  };

  const ingestResult = await incrementalIngest(
    client,
    draft.draftId,
    redactedPicks,
    stored?.picksHash ?? null
  );

  result.picksInserted = ingestResult.picksInserted;
  result.picksUpdated = ingestResult.picksUpdated;
  result.status = ingestResult.status;

  if (ingestResult.status === "diverged") {
    console.warn(`[sync] Draft ${draft.draftId} has diverged data — run pnpm sync to fix`);
    result.diverged = true;
  }

  // Sync matches via hash-compare + replace
  // Uses buildMatchInserts (shared with CLI syncDraft) for the 0→1 seat mapping.
  const matches = parseMatchRows(sheetData.matches, parsedPicks.drafterNames);
  if (matches.length > 0) {
    const newMatchesHash = hashMatches(matches);
    const storedMatchesHash = stored?.matchesHash ?? null;

    if (compareDomainHash(newMatchesHash, storedMatchesHash) === "replace") {
      await deleteDomainData(client, draft.draftId, "matches");

      const matchInserts = buildMatchInserts(draft.draftId, matches);
      await batchInsertMatches(client, matchInserts);
      await updateDomainHashes(client, draft.draftId, {
        matchesHash: newMatchesHash,
      });

      result.matchesReplaced = matchInserts.length;
      console.log(`[sync] Replaced ${matchInserts.length} matches for draft ${draft.draftId}`);

      if (result.status === "no_change") {
        result.status = "updated";
      }
    }
  }

  // Advance the phase when the sheet state calls for it. Divergence skips
  // this — a draft whose picks can't be trusted shouldn't change phase.
  if (!result.diverged) {
    const currentPhase = stored?.currentPhase ?? "drafting";
    const targetPhase = computeSyncTargetPhase(
      parsedPicks.isComplete,
      isMatchesComplete(matches.length, parsedPicks.numDrafters)
    );
    if (targetPhase !== currentPhase && isSyncPhaseTransitionLegal(currentPhase, targetPhase)) {
      await setDraftPhase(client, draft.draftId, targetPhase);
      result.phaseSet = targetPhase;
      console.log(`[sync] Draft ${draft.draftId} phase → ${targetPhase}`);
      if (targetPhase === "complete") {
        result.status = "completed";
      }
    }
  }

  return result;
}
