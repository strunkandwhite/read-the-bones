import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";
import { getLatestPickNumber, getRecentPicks, getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";
import { getDraftMeta } from "@/core/db/queries/drafts";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const client = await getClient();

    const meta = await getDraftMeta(client, draftId);
    if (!meta) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const { phase, numSeats, picksPerPlayer } = meta;
    // Use display names (original casing) for the API response
    const bannedCards = meta.bannedCardsDisplay;

    const [latestPickN, recentPicks, seatNames, matchCount, picks] = await Promise.all([
      getLatestPickNumber(client, draftId),
      getRecentPicks(client, draftId, 10),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
      getPicksWithCardDetails(client, draftId),
    ]);

    const next = picksPerPlayer
      ? getNextPick(latestPickN, numSeats, picksPerPlayer)
      : null;
    const totalMatches = (numSeats * (numSeats - 1)) / 2;

    return NextResponse.json({
      phase,
      numSeats,
      picksPerPlayer,
      latestPickN,
      nextSeat: next?.seat ?? null,
      recentPicks,
      seatNames,
      matchCount,
      totalMatches,
      picks,
      bannedCards,
    }, { headers: { "Cache-Control": "no-cache" } });
  },
  "[/api/drafts/[id]/live] Error:",
);
