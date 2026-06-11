import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import {
  getFloatedCards,
  addFloatedCard,
  removeFloatedCard,
} from "@/core/db/queries/floatedCards";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

type Params = { params: Promise<{ id: string }> };

export const GET = withApiErrors(
  async (request: NextRequest, { params }: Params) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);
    const cards = await getFloatedCards(client, draftId, seat);
    return NextResponse.json({ cards });
  },
  "[/api/drafts/[id]/float] GET Error:",
);

export const PUT = withApiErrors(
  async (request: NextRequest, { params }: Params) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    if (!body.card_name || typeof body.card_name !== "string") {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    await addFloatedCard(client, draftId, seat, body.card_name);
    return NextResponse.json({ ok: true });
  },
  "[/api/drafts/[id]/float] PUT Error:",
);

export const DELETE = withApiErrors(
  async (request: NextRequest, { params }: Params) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    if (!body.card_name || typeof body.card_name !== "string") {
      return NextResponse.json({ error: "card_name required" }, { status: 400 });
    }

    await removeFloatedCard(client, draftId, seat, body.card_name);
    return NextResponse.json({ ok: true });
  },
  "[/api/drafts/[id]/float] DELETE Error:",
);
