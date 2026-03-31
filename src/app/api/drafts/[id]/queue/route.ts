import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getQueue, setQueue, type QueueEntry } from "@/core/db/queries/pickQueue";
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

    // Validate and normalize each entry
    const validModes = new Set(['pause', 'flow-through']);
    const normalizedEntries: Array<{ mode: 'pause' | 'flow-through'; cardNames: string[] }> = [];
    for (const entry of body) {
      if (!entry || !Array.isArray(entry.cards) || entry.cards.length === 0) {
        return NextResponse.json({ error: "Each entry must have a non-empty cards array" }, { status: 400 });
      }
      const mode: 'pause' | 'flow-through' = entry.mode === 'flow-through' ? 'flow-through' : 'pause';
      if (entry.mode !== undefined && !validModes.has(entry.mode)) {
        return NextResponse.json({ error: `Invalid mode: ${entry.mode}` }, { status: 400 });
      }
      const cardNames: string[] = entry.cards.map((c: string | { cardName: string }) =>
        typeof c === 'string' ? c : c.cardName
      );
      normalizedEntries.push({ mode, cardNames });
    }

    // Flatten card names for total count and duplicate checks
    const allCardNames = normalizedEntries.flatMap((e) => e.cardNames);
    if (allCardNames.length > 500) {
      return NextResponse.json({ error: "Queue cannot exceed 500 cards" }, { status: 400 });
    }
    const cardNameSet = new Set(allCardNames);
    if (cardNameSet.size !== allCardNames.length) {
      return NextResponse.json({ error: "Duplicate card names are not allowed in the queue" }, { status: 400 });
    }

    // Batch resolve card names to IDs
    const nameToId = await resolveCardIds(client, allCardNames);

    const newEntries: QueueEntry[] = [];
    for (const { mode, cardNames } of normalizedEntries) {
      const resolvedCards: Array<{ id: number; name: string }> = [];
      for (const name of cardNames) {
        const id = nameToId.get(name);
        if (id === undefined) {
          return NextResponse.json({ error: `Card not found: ${name}` }, { status: 400 });
        }
        resolvedCards.push({ id, name });
      }
      newEntries.push({ mode, cards: resolvedCards });
    }

    // Get old queue before replacing, to detect removed cards
    const oldQueue = await getQueue(client, draftId, seat);
    const oldCardNames = oldQueue.flatMap((entry) => entry.cards.map((c) => c.name));

    await setQueue(client, draftId, seat, newEntries);

    // Auto-float any cards that were removed from the queue
    const newCardNameSet = new Set(allCardNames);
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
    const addedCardNames = allCardNames.filter((name) => !oldCardNameSet.has(name));
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
