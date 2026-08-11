import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { reportMatchResult } from "@/core/db/queries/matches";
import { getDraftMeta } from "@/core/db/queries/drafts";
import { validateMatchResult } from "@/core/match-validation";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const POST = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat, wins, losses } = body;
    if (opponent_seat == null || wins == null || losses == null) {
      return NextResponse.json(
        { error: "opponent_seat, wins, and losses required" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(opponent_seat) || !Number.isInteger(wins) || !Number.isInteger(losses)) {
      return NextResponse.json(
        { error: "opponent_seat, wins, and losses must be integers" },
        { status: 400 }
      );
    }
    const validationError = validateMatchResult(wins, losses);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    if (opponent_seat < 1) {
      return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
    }
    if (opponent_seat === mySeat) {
      return NextResponse.json(
        { error: "Cannot report a match against yourself" },
        { status: 400 }
      );
    }

    const meta = await getDraftMeta(client, draftId);
    if (!meta) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, numSeats } = meta;
    if (phase !== "playing" && phase !== "complete") {
      return NextResponse.json(
        { error: `Cannot report matches in '${phase}' phase` },
        { status: 400 }
      );
    }
    if (opponent_seat > numSeats) {
      return NextResponse.json({ error: `opponent_seat must be <= ${numSeats}` }, { status: 400 });
    }

    const seat1 = Math.min(mySeat, opponent_seat);
    const seat2 = Math.max(mySeat, opponent_seat);
    const seat1Wins = mySeat === seat1 ? wins : losses;
    const seat2Wins = mySeat === seat2 ? wins : losses;

    await reportMatchResult(client, draftId, seat1, seat2, seat1Wins, seat2Wins, mySeat);

    return NextResponse.json({ success: true, seat1, seat2, seat1Wins, seat2Wins });
  },
  "[/api/drafts/[id]/match] Error:"
);
