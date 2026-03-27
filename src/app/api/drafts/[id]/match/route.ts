import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { AppError } from "@/core/errors";
import { getDraftPhase } from "@/core/db/queries/drafts";
import { reportMatchResult } from "@/core/db/queries/matches";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat, wins, losses } = body;
    if (opponent_seat == null || wins == null || losses == null) {
      return NextResponse.json({ error: "opponent_seat, wins, and losses required" }, { status: 400 });
    }
    if (!Number.isInteger(opponent_seat) || !Number.isInteger(wins) || !Number.isInteger(losses)) {
      return NextResponse.json({ error: "opponent_seat, wins, and losses must be integers" }, { status: 400 });
    }
    if (wins < 0 || losses < 0) {
      return NextResponse.json({ error: "wins and losses must be non-negative" }, { status: 400 });
    }
    // MTG matches are best-of-3 (max 2 wins per side)
    if (wins > 2 || losses > 2) {
      return NextResponse.json({ error: "wins and losses must be 0, 1, or 2" }, { status: 400 });
    }
    if (opponent_seat < 1) {
      return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
    }
    if (opponent_seat === mySeat) {
      return NextResponse.json({ error: "Cannot report a match against yourself" }, { status: 400 });
    }

    const phase = await getDraftPhase(client, draftId);
    if (phase === null) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    if (phase !== "playing" && phase !== "complete") {
      return NextResponse.json({ error: `Cannot report matches in '${phase}' phase` }, { status: 400 });
    }

    const seat1 = Math.min(mySeat, opponent_seat);
    const seat2 = Math.max(mySeat, opponent_seat);
    const seat1Wins = mySeat === seat1 ? wins : losses;
    const seat2Wins = mySeat === seat2 ? wins : losses;

    await reportMatchResult(client, draftId, seat1, seat2, seat1Wins, seat2Wins, mySeat);

    return NextResponse.json({ success: true, seat1, seat2, seat1Wins, seat2Wins });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/match] Error:", error);
    return NextResponse.json({ error: "Failed to report match" }, { status: 500 });
  }
}
