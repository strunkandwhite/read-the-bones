import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { processPick, triggerAutoPickOnDemand } from "@/core/processPick";
import { resolveCardId } from "@/core/db/queries/cards";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const POST = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const client = await getClient();

    const { seat } = await authenticateSeat(client, request, draftId);
    const body = await request.json();

    // Auto-pick on demand: the client delegates queue-traversal to the server
    // so that cascade and on-demand paths share the same candidate-selection
    // implementation and cannot produce divergent picks.
    if (body.auto === true) {
      const result = await triggerAutoPickOnDemand(client, draftId, seat);
      return NextResponse.json(result);
    }

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
  },
  "[/api/drafts/[id]/pick] Error:",
);
