import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { getWipDeck, upsertWipDeck } from "@/core/db/queries/decks";
import { validateDeckState } from "@/core/validateDeckState";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export const GET = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const result = await getWipDeck(client, draftId, seat);

    if (!result) {
      return NextResponse.json({ error: "No deck state found" }, { status: 404 });
    }

    return NextResponse.json(result.deckState);
  },
  "[/api/drafts/[id]/deck-state] GET Error:"
);

export const PUT = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
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

    // Guard against cross-draft writes: the body must identify the same draft and seat
    // that the route and token resolve to.
    if (deckState.draftId !== draftId) {
      return NextResponse.json({ error: "draftId mismatch" }, { status: 400 });
    }
    if (deckState.seat !== seat) {
      return NextResponse.json({ error: "seat mismatch" }, { status: 400 });
    }

    await upsertWipDeck(client, draftId, seat, deckState);
    return NextResponse.json({ ok: true });
  },
  "[/api/drafts/[id]/deck-state] PUT Error:"
);
