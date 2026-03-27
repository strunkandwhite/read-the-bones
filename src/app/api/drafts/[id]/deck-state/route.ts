import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getWipDeck, upsertWipDeck } from "@/core/db/queries/decks";
import { validateDeckState } from "@/core/validateDeckState";
import { AppError } from "@/core/errors";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const result = await getWipDeck(client, draftId, seat);

    if (!result) {
      return NextResponse.json({ error: "No deck state found" }, { status: 404 });
    }

    return NextResponse.json(result.deckState);
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/deck-state] GET Error:", error);
    return NextResponse.json({ error: "Failed to load deck state" }, { status: 500 });
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

    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }

    let deckState;
    try {
      deckState = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const validation = validateDeckState(deckState);
    if (!validation.valid) {
      return NextResponse.json({ error: "Invalid deck state" }, { status: 400 });
    }

    await upsertWipDeck(client, draftId, seat, deckState);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/deck-state] PUT Error:", error);
    return NextResponse.json({ error: "Failed to save deck state" }, { status: 500 });
  }
}
