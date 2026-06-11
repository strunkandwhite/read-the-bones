import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getSnapshot } from "@/core/db/queries/decks";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ) => {
    const { id } = await params;
    const client = await getClient();
    const result = await getSnapshot(client, id);

    if (!result) {
      return NextResponse.json({ error: "Deck not found" }, { status: 404 });
    }

    return NextResponse.json(result.deckState, {
      headers: {
        "Cache-Control": "public, s-maxage=31536000, immutable",
      },
    });
  },
  "[/api/deck/[id]] Error:",
);
