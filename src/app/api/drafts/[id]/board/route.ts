import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { AppError } from "@/core/errors";
import { parseBannedCardNames } from "@/core/db/queries/helpers";
import { getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    const draft = await client.execute({
      sql: "SELECT draft_id, num_seats, picks_per_player, phase, banned_cards FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const d = draft.rows[0];

    const picks = await getPicksWithCardDetails(client, draftId);
    const seatNames = await getSeatDisplayNames(client, draftId);
    const bannedCards = parseBannedCardNames(d.banned_cards as string | null);

    return NextResponse.json({
      draftId,
      numSeats: d.num_seats,
      picksPerPlayer: d.picks_per_player,
      phase: d.phase,
      seatNames,
      picks,
      bannedCards,
    }, {
      headers: { "Cache-Control": "public, s-maxage=5" },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/board] Error:", error);
    return NextResponse.json({ error: "Failed to load board" }, { status: 500 });
  }
}
