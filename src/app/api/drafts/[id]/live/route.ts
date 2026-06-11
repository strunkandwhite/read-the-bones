import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";
import { getLatestPickNumber, getRecentPicks, getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";
import { parseBannedCardNames } from "@/core/db/queries/helpers";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const client = await getClient();

    const draft = await client.execute({
      sql: "SELECT phase, num_seats, picks_per_player, banned_cards FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const {
      phase,
      num_seats: numSeats,
      picks_per_player: picksPerPlayer,
      banned_cards: bannedCardsRaw,
    } = draft.rows[0];

    const [latestPickN, recentPicks, seatNames, matchCount, picks] = await Promise.all([
      getLatestPickNumber(client, draftId),
      getRecentPicks(client, draftId, 10),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
      getPicksWithCardDetails(client, draftId),
    ]);

    const next = picksPerPlayer
      ? getNextPick(latestPickN, numSeats as number, picksPerPlayer as number)
      : null;
    const ns = numSeats as number;
    const totalMatches = (ns * (ns - 1)) / 2;
    const bannedCards = parseBannedCardNames(bannedCardsRaw as string | null);

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
