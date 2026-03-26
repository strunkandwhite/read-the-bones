import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();

    const draft = await client.execute({
      sql: "SELECT phase, num_seats, picks_per_player FROM drafts WHERE draft_id = ?",
      args: [draftId],
    });
    if (draft.rows.length === 0) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, num_seats: numSeats, picks_per_player: picksPerPlayer } = draft.rows[0];

    const pickResult = await client.execute({
      sql: "SELECT COALESCE(MAX(pick_n), 0) as latest FROM pick_events WHERE draft_id = ?",
      args: [draftId],
    });
    const latestPickN = pickResult.rows[0].latest as number;

    const next = picksPerPlayer
      ? getNextPick(latestPickN, numSeats as number, picksPerPlayer as number)
      : null;

    const recentResult = await client.execute({
      sql: `SELECT pe.pick_n, pe.seat, c.name as card_name
            FROM pick_events pe
            JOIN cards c ON c.card_id = pe.card_id
            WHERE pe.draft_id = ?
            ORDER BY pe.pick_n DESC LIMIT 10`,
      args: [draftId],
    });
    const recentPicks = recentResult.rows.map((r) => ({
      pickN: r.pick_n as number,
      seat: r.seat as number,
      cardName: r.card_name as string,
    }));

    const seatResult = await client.execute({
      sql: "SELECT seat, display_name FROM seat_tokens WHERE draft_id = ? ORDER BY seat",
      args: [draftId],
    });
    const seatNames: Record<string, string> = {};
    for (const r of seatResult.rows) {
      if (r.display_name) seatNames[String(r.seat)] = r.display_name as string;
    }

    const matchResult = await client.execute({
      sql: "SELECT COUNT(*) as cnt FROM match_events WHERE draft_id = ?",
      args: [draftId],
    });
    const matchCount = matchResult.rows[0].cnt as number;
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
    console.error("[/api/drafts/[id]/status] Error:", error);
    return NextResponse.json({ error: "Failed to load status" }, { status: 500 });
  }
}
