import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getSnapshot } from "@/core/db/queries/decks";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
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
  } catch (error) {
    console.error("[/api/deck/[id]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load shared deck" },
      { status: 500 }
    );
  }
}
