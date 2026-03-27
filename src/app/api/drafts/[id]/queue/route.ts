import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getQueue, setQueue } from "@/core/db/queries/pickQueue";
import { AppError } from "@/core/errors";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const queue = await getQueue(client, draftId, seat);
    return NextResponse.json({ queue });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/queue] GET Error:", error);
    return NextResponse.json({ error: "Failed to load queue" }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const body = await request.json();
    const cardNames: string[] = body.map((entry: { card_name: string }) => entry.card_name);

    const cardIds: number[] = [];
    for (const name of cardNames) {
      const result = await client.execute({
        sql: "SELECT card_id FROM cards WHERE name = ?",
        args: [name],
      });
      if (result.rows.length === 0) {
        return NextResponse.json({ error: `Card not found: ${name}` }, { status: 400 });
      }
      cardIds.push(result.rows[0].card_id as number);
    }

    await setQueue(client, draftId, seat, cardIds);
    const queue = await getQueue(client, draftId, seat);
    return NextResponse.json({ queue });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/queue] PUT Error:", error);
    return NextResponse.json({ error: "Failed to update queue" }, { status: 500 });
  }
}
