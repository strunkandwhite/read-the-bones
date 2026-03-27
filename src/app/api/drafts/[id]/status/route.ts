import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { AppError } from "@/core/errors";
import { getNextPick } from "@/core/snakeDraft";
import { getLatestPickNumber, getRecentPicks } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    // Draft metadata still fetched inline — it returns multiple columns
    // specific to this route's response shape
    const draft = await client.execute({
      sql: "SELECT phase, num_seats, picks_per_player FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, num_seats: numSeats, picks_per_player: picksPerPlayer } = draft.rows[0];

    const [latestPickN, recentPicks, seatNames, matchCount] = await Promise.all([
      getLatestPickNumber(client, draftId),
      getRecentPicks(client, draftId, 10),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
    ]);
    const next = picksPerPlayer
      ? getNextPick(latestPickN, numSeats as number, picksPerPlayer as number)
      : null;

    const ns = numSeats as number;
    const totalMatches = (ns * (ns - 1)) / 2;

    return NextResponse.json({
      phase,
      latestPickN,
      nextSeat: next?.seat ?? null,
      numSeats,
      picksPerPlayer,
      recentPicks,
      seatNames,
      matchCount,
      totalMatches,
    }, {
      headers: { "Cache-Control": "no-cache" },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/status] Error:", error);
    return NextResponse.json({ error: "Failed to load status" }, { status: 500 });
  }
}
