import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { createSnapshot } from "@/core/db/queries/decks";
import type { DeckState } from "@/core/types";
import { validateDeckState } from "@/core/validateDeckState";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export const POST = withApiErrors(
  async (request: NextRequest) => {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413 }
      );
    }

    let deckState: DeckState;
    try {
      deckState = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const validation = validateDeckState(deckState);
    if (!validation.valid) {
      return NextResponse.json(
        { error: "Invalid deck state" },
        { status: 400 }
      );
    }

    const client = await getClient();
    const { deckId } = await createSnapshot(client, deckState);
    return NextResponse.json({ deckId });
  },
  "[/api/deck] Error:",
);
