import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import {
  acquireSyncLock,
  releaseSyncLock,
  updateLastSyncedAt,
  getActiveDrafts,
  incrementalIngest,
  isRateLimited,
} from "@/core/sync";
import { fetchDraftFromSheet } from "@/build/sheets";

async function runSync(): Promise<NextResponse> {
  const client = await getClient();

  // Check for active drafts first (cheap query)
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

    for (const draft of activeDrafts) {
      try {
        // Fetch CSV data from Google Sheets
        const sheetData = await fetchDraftFromSheet(draft.sheetId, apiKey);

        if (!sheetData.picks) {
          console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
          continue;
        }

        // Run incremental ingestion
        const result = await incrementalIngest(
          client,
          draft.draftId,
          sheetData.picks,
        );
        totalPicksInserted += result.picksInserted;

        if (result.status === "diverged") {
          console.warn(
            `[sync] Draft ${draft.draftId} has diverged data — run pnpm ingest to fix`,
          );
        }
      } catch (error) {
        console.error(`[sync] Error syncing draft ${draft.draftId}:`, error);
        // Continue with other drafts
      }
    }

    if (totalPicksInserted > 0) {
      const lastSyncedAt = await updateLastSyncedAt(client);
      return NextResponse.json({
        status: "completed",
        lastSyncedAt,
        picksInserted: totalPicksInserted,
      });
    }

    return NextResponse.json({
      status: "no_change",
      picksInserted: 0,
    });
  } finally {
    await releaseSyncLock(client);
  }
}

/**
 * GET /api/sync — Called by Vercel cron job.
 * Requires CRON_SECRET authorization.
 */
export async function GET(request: NextRequest) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await runSync();
  } catch (error) {
    console.error("[sync] Unexpected error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}

/**
 * POST /api/sync — Called by "Sync Now" button.
 * Rate-limited to prevent quota exhaustion.
 */
export async function POST() {
  try {
    const client = await getClient();

    // Rate limiting
    if (await isRateLimited(client)) {
      return NextResponse.json({ status: "rate_limited" }, { status: 429 });
    }

    return await runSync();
  } catch (error) {
    console.error("[sync] Unexpected error:", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  }
}
