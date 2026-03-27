import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { processPick } from "@/core/processPick";
import { AppError } from "@/core/errors";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: draftId } = await params;
  const client = await getClient();

  try {
    const { seat } = await authenticateSeat(client, request, draftId);
    const body = await request.json();
    const { card_name } = body;
    if (!card_name) {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    const cardRow = await client.execute({
      sql: "SELECT card_id FROM cards WHERE name = ?",
      args: [card_name],
    });
    if (cardRow.rows.length === 0) {
      return NextResponse.json({ error: `Card not found: ${card_name}` }, { status: 400 });
    }
    const cardId = cardRow.rows[0].card_id as number;

    const result = await processPick(client, {
      draftId,
      seat,
      cardId,
      cardName: card_name,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/pick] Error:", error);
    return NextResponse.json({ error: "Pick failed" }, { status: 500 });
  }
}
