import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { processPick } from "@/core/processPick";
import { AppError } from "@/core/errors";
import { resolveCardId } from "@/core/db/queries/cards";

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

    const cardId = await resolveCardId(client, card_name);
    if (cardId === null) {
      return NextResponse.json({ error: `Card not found: ${card_name}` }, { status: 400 });
    }

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
