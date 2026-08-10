import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { getClient } from "@/core/db/client";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getActiveDrafts,
  completeAgedPlayingDrafts,
} from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

async function runSync(): Promise<NextResponse> {
  const client = await getClient();

  // Age backstop first so long-stale playing drafts drop out of this run
  await completeAgedPlayingDrafts(client);

  // Check for active drafts (cheap query)
  const activeDrafts = await getActiveDrafts(client);
  if (activeDrafts.length === 0) {
    return NextResponse.json({ status: "no_active_drafts" });
  }

  // Try to acquire lock
  const locked = await acquireSyncLock(client);
  if (!locked) {
    return NextResponse.json({ status: "in_progress" });
  }

  try {
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY;
    if (!apiKey) {
      console.error("[sync] GOOGLE_SHEETS_API_KEY not set");
      return NextResponse.json(
        { error: "Server misconfiguration" },
        { status: 500 },
      );
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
      });
    }

    return NextResponse.json({
      status: "no_change",
      picksInserted: 0,
      picksUpdated: 0,
      matchesReplaced: 0,
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
export const GET = withApiErrors(
  async (request: NextRequest) => {
    // Verify cron secret using constant-time comparison to resist timing attacks
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (!cronSecret || !timingSafeStringEqual(authHeader ?? "", `Bearer ${cronSecret}`)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return await runSync();
  },
  "[sync] Unexpected error:",
);
