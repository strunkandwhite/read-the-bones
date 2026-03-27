import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import {
  getFloatedCards,
  addFloatedCard,
  removeFloatedCard,
} from "@/core/db/queries/floatedCards";
import { AppError } from "@/core/errors";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const cards = await getFloatedCards(client, draftId, seat);
    return NextResponse.json({ cards });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/float] GET Error:", error);
    return NextResponse.json({ error: "Failed to load floated cards" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    if (!body.card_name || typeof body.card_name !== "string") {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    await addFloatedCard(client, draftId, seat, body.card_name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/float] PUT Error:", error);
    return NextResponse.json({ error: "Failed to add floated card" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    if (!body.card_name || typeof body.card_name !== "string") {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    await removeFloatedCard(client, draftId, seat, body.card_name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/float] DELETE Error:", error);
    return NextResponse.json({ error: "Failed to remove floated card" }, { status: 500 });
  }
}
