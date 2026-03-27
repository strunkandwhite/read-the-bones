import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getQueue, setQueue } from "@/core/db/queries/pickQueue";
import { addFloatedCard } from "@/core/db/queries/floatedCards";
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
    if (!Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be an array" }, { status: 400 });
    }
    const cardNames: string[] = body.map((entry: { card_name: string }) => entry.card_name);

    // Batch resolve card names to IDs
    const placeholders = cardNames.map(() => "?").join(", ");
    const result = await client.execute({
      sql: `SELECT card_id, name FROM cards WHERE name IN (${placeholders})`,
      args: cardNames,
    });

    const nameToId = new Map<string, number>();
    for (const row of result.rows) {
      nameToId.set(row.name as string, row.card_id as number);
    }

    const cardIds: number[] = [];
    for (const name of cardNames) {
      const id = nameToId.get(name);
      if (id === undefined) {
        return NextResponse.json({ error: `Card not found: ${name}` }, { status: 400 });
      }
      cardIds.push(id);
    }

    // Get old queue before replacing, to detect removed cards
    const oldQueue = await getQueue(client, draftId, seat);
    const oldCardNames = oldQueue.map((q) => q.cardName);

    await setQueue(client, draftId, seat, cardIds);

    // Auto-float any cards that were removed from the queue
    const newCardNameSet = new Set(cardNames);
    for (const oldName of oldCardNames) {
      if (!newCardNameSet.has(oldName)) {
        await addFloatedCard(client, draftId, seat, oldName);
      }
    }

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
