import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";

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
    if (opponent_seat === mySeat) {
      return NextResponse.json({ error: "Cannot report a match against yourself" }, { status: 400 });
    }

    const draft = await client.execute({
      sql: "SELECT phase FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const phase = draft.rows[0].phase as string;
    if (phase !== "playing" && phase !== "complete") {
      return NextResponse.json({ error: `Cannot report matches in '${phase}' phase` }, { status: 400 });
    }

    const seat1 = Math.min(mySeat, opponent_seat);
    const seat2 = Math.max(mySeat, opponent_seat);
    const seat1Wins = mySeat === seat1 ? wins : losses;
    const seat2Wins = mySeat === seat2 ? wins : losses;

    await client.execute({
      sql: `INSERT OR REPLACE INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins, reported_by_seat)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [draftId, seat1, seat2, seat1Wins, seat2Wins, mySeat],
    });

    return NextResponse.json({ success: true, seat1, seat2, seat1Wins, seat2Wins });
  } catch (error) {
    if (error instanceof Error && error.message.includes("token")) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("[/api/drafts/[id]/match] Error:", error);
    return NextResponse.json({ error: "Failed to report match" }, { status: 500 });
  }
}
