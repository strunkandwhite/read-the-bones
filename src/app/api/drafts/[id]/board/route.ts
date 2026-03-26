import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";

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

    const picksResult = await client.execute({
      sql: `SELECT pe.pick_n, pe.seat, c.name, c.oracle_id, c.scryfall_json
            FROM pick_events pe
            JOIN cards c ON c.card_id = pe.card_id
            WHERE pe.draft_id = ?
            ORDER BY pe.pick_n`,
      args: [draftId],
    });
    const picks = picksResult.rows.map((r) => {
      let colorIdentity: string[] = [];
      let manaCost = "";
      try {
        const sf = JSON.parse(r.scryfall_json as string);
        colorIdentity = sf.color_identity ?? [];
        manaCost = sf.mana_cost ?? "";
        // DFCs: use front-face mana cost only
        if (!manaCost && sf.card_faces?.[0]?.mana_cost) {
          manaCost = sf.card_faces[0].mana_cost;
        }
      } catch { /* ignore parse errors */ }
      return {
        pickN: r.pick_n as number,
        seat: r.seat as number,
        cardName: r.name as string,
        oracleId: r.oracle_id as string,
        colorIdentity,
        manaCost,
      };
    });

    const seatResult = await client.execute({
      sql: "SELECT seat, display_name FROM seat_tokens WHERE draft_id = ? ORDER BY seat",
      args: [draftId],
    });
    const seatNames: Record<string, string> = {};
    for (const r of seatResult.rows) {
      if (r.display_name) seatNames[String(r.seat)] = r.display_name as string;
    }

    const bannedCards: string[] = d.banned_cards
      ? JSON.parse(d.banned_cards as string)
      : [];

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
    console.error("[/api/drafts/[id]/board] Error:", error);
    return NextResponse.json({ error: "Failed to load board" }, { status: 500 });
  }
}
