import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import type { Client } from "@libsql/client";
import { getClient } from "@/core/db/client";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getActiveDrafts,
  getLiveDraftingDrafts,
  completeAgedPlayingDrafts,
} from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";
import { resumeAutoPickForCurrentSeat } from "@/core/processPick";
import { ConflictError } from "@/core/errors";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

/**
 * Pick for the seat on the clock in every in-app draft that has one, and cascade
 * from there.
 *
 * The cascade only ever runs as a side effect of a pick landing, and the client
 * trigger only runs in an open browser — so a live draft whose players are all
 * away sits dead, and strict rotisserie order means no other seat can pick to
 * restart it. This is the only thing that recovers it unattended.
 *
 * One draft failing must not cost the others their nudge or fail the cron run:
 * a client racing this call produces a ConflictError, which is a normal outcome
 * here, not an error worth a non-200.
 *
 * Returns the total number of picks made, for the response body. This count is
 * a lower bound, not a guarantee: if a draft lands some picks and then loses a
 * race partway through its cascade, the ConflictError is caught below and that
 * draft's picks so far are never added to the total, even though they are
 * already committed. `autoPicked: 0` in the response does not prove this
 * function did nothing.
 */
async function runAutoPickHeartbeat(client: Client): Promise<number> {
  const draftIds = await getLiveDraftingDrafts(client);
  let picksMade = 0;

  for (const draftId of draftIds) {
    try {
      const outcome = await resumeAutoPickForCurrentSeat(client, draftId);
      picksMade += outcome.picks.length;
    } catch (error) {
      if (error instanceof ConflictError) {
        // A client racing this same seat's turn is routine once players are
        // active, not a failure — console.error here would produce
        // false-positive alerts on every such race.
        console.warn(`[sync] auto-pick heartbeat raced a client for ${draftId}:`, error.message);
      } else {
        console.error(`[sync] auto-pick heartbeat failed for ${draftId}:`, error);
      }
    }
  }

  return picksMade;
}

async function runSync(): Promise<NextResponse> {
  const client = await getClient();

  // Age backstop first so long-stale playing drafts drop out of this run
  await completeAgedPlayingDrafts(client);

  // Before anything Sheets-related. Every early return below is about Sheets
  // ingest — no active sheet draft, no API key, a lock already held — and none
  // of them have any bearing on a live draft stalled on an absent player.
  const autoPicked = await runAutoPickHeartbeat(client);

  // Check for active drafts (cheap query)
  const activeDrafts = await getActiveDrafts(client);
  if (activeDrafts.length === 0) {
    return NextResponse.json({ status: "no_active_drafts", autoPicked });
  }

  // Try to acquire lock
  const locked = await acquireSyncLock(client);
  if (!locked) {
    return NextResponse.json({ status: "in_progress", autoPicked });
  }

  try {
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!apiKey) {
      console.error("[sync] GOOGLE_SHEETS_API_KEY not set");
      return NextResponse.json({ error: "Server misconfiguration", autoPicked }, { status: 500 });
    }

    let totalPicksInserted = 0;
    let totalPicksUpdated = 0;
    let totalMatchesReplaced = 0;

    for (const draft of activeDrafts) {
      try {
        const result = await syncActiveDraft(client, draft, apiKey);
        totalPicksInserted += result.picksInserted;
        totalPicksUpdated += result.picksUpdated;
        totalMatchesReplaced += result.matchesReplaced;
      } catch (error) {
        console.error(`[sync] Error syncing draft ${draft.draftId}:`, error);
        // Continue with other drafts
      }
    }

    if (totalPicksInserted > 0 || totalPicksUpdated > 0 || totalMatchesReplaced > 0) {
      const lastSyncedAt = await updateLastSyncedAt(client);
      return NextResponse.json({
        status: "completed",
        lastSyncedAt,
        picksInserted: totalPicksInserted,
        picksUpdated: totalPicksUpdated,
        matchesReplaced: totalMatchesReplaced,
        autoPicked,
      });
    }

    return NextResponse.json({
      status: "no_change",
      picksInserted: 0,
      picksUpdated: 0,
      matchesReplaced: 0,
      autoPicked,
    });
  } finally {
    await releaseSyncLock(client);
  }
}

/**
 * Constant-time string equality to prevent timing-based secret extraction.
 * Returns false immediately on length mismatch to avoid buffer allocation risk,
 * then delegates to crypto.timingSafeEqual for equal-length strings.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * GET /api/sync — Called by Vercel cron job every minute.
 * Requires CRON_SECRET authorization.
 */
export const GET = withApiErrors(async (request: NextRequest) => {
  // Verify cron secret using constant-time comparison to resist timing attacks
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || !timingSafeStringEqual(authHeader ?? "", `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return await runSync();
}, "[sync] Unexpected error:");
