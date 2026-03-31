import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getQueue, setQueue } from "@/core/db/queries/pickQueue";
import { resolveCardIds } from "@/core/db/queries/cards";
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
    if (body.length > 500) {
      return NextResponse.json({ error: "Queue cannot exceed 500 entries" }, { status: 400 });
    }
    const cardNames: string[] = body.map((entry: { card_name: string }) => entry.card_name);

    // Batch resolve card names to IDs
    const nameToId = await resolveCardIds(client, cardNames);

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
    const removedCardNames = oldCardNames.filter((name) => !newCardNameSet.has(name));
    if (removedCardNames.length > 0) {
      await client.batch(
        removedCardNames.map((name) => ({
          sql: "INSERT OR IGNORE INTO floated_cards (draft_id, seat, card_name) VALUES (?, ?, ?)",
          args: [draftId, seat, name],
        }))
      );
    }

    // Auto-unfloat any cards that were added to the queue (queue supersedes float)
    const oldCardNameSet = new Set(oldCardNames);
    const addedCardNames = cardNames.filter((name) => !oldCardNameSet.has(name));
    if (addedCardNames.length > 0) {
      await client.batch(
        addedCardNames.map((name) => ({
          sql: "DELETE FROM floated_cards WHERE draft_id = ? AND seat = ? AND card_name = ?",
          args: [draftId, seat, name],
        }))
      );
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
