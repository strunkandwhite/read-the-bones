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
import { fetchDraftTabsRaw } from "@/core/sheets";
import { parsePickRows, parseMatchRows } from "@/core/parseSheetRows";
import {
  hashMatches,
  getDomainHashes,
  compareDomainHash,
  updateDomainHashes,
} from "@/core/db/sync/domains";
import {
  batchInsertMatches,
  deleteDomainData,
} from "@/core/db/sync/batch";
import type { MatchInsert } from "@/core/db/sync/batch";

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
    let totalMatchesReplaced = 0;

    for (const draft of activeDrafts) {
      try {
        // Fetch row data from Google Sheets
        const sheetData = await fetchDraftTabsRaw(draft.sheetId, apiKey);

        if (!sheetData.picks) {
          console.warn(`[sync] No picks tab found for draft ${draft.draftId}`);
          continue;
        }

        // Parse rows and run incremental pick ingestion
        const parsedPicks = parsePickRows(sheetData.picks, draft.draftId);
        const result = await incrementalIngest(
          client,
          draft.draftId,
          parsedPicks,
        );
        totalPicksInserted += result.picksInserted;

        if (result.status === "diverged") {
          console.warn(
            `[sync] Draft ${draft.draftId} has diverged data — run pnpm sync to fix`,
          );
        }

        // Sync matches via hash-compare + replace
        const matches = parseMatchRows(
          sheetData.matches,
          parsedPicks.drafterNames,
        );
        if (matches.length > 0) {
          const newMatchesHash = hashMatches(matches);
          const stored = await getDomainHashes(client, draft.draftId);
          const storedMatchesHash = stored?.matchesHash ?? null;

          if (compareDomainHash(newMatchesHash, storedMatchesHash) === "replace") {
            await deleteDomainData(client, draft.draftId, "matches");

            const matchInserts: MatchInsert[] = matches.map((m) => ({
              draftId: draft.draftId,
              seat1: m.seat1 + 1,
              seat2: m.seat2 + 1,
              seat1GamesWon: m.seat1GamesWon,
              seat2GamesWon: m.seat2GamesWon,
            }));

            await batchInsertMatches(client, matchInserts);
            await updateDomainHashes(client, draft.draftId, {
              matchesHash: newMatchesHash,
            });

            totalMatchesReplaced += matchInserts.length;
            // eslint-disable-next-line no-console
            console.log(
              `[sync] Replaced ${matchInserts.length} matches for draft ${draft.draftId}`,
            );
          }
        }
      } catch (error) {
        console.error(`[sync] Error syncing draft ${draft.draftId}:`, error);
        // Continue with other drafts
      }
    }

    if (totalPicksInserted > 0 || totalMatchesReplaced > 0) {
      const lastSyncedAt = await updateLastSyncedAt(client);
      return NextResponse.json({
        status: "completed",
        lastSyncedAt,
        picksInserted: totalPicksInserted,
        matchesReplaced: totalMatchesReplaced,
      });
    }

    return NextResponse.json({
      status: "no_change",
      picksInserted: 0,
      matchesReplaced: 0,
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
