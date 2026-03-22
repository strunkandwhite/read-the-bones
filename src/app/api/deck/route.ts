import { NextRequest, NextResponse } from "next/server";
import { createSharedDeck } from "@/core/db/queries/sharedDecks";
import type { DeckState } from "@/core/types";
import { validateDeckState } from "@/core/validateDeckState";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

export async function POST(request: NextRequest) {
  try {
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

    const { deckId } = await createSharedDeck(deckState);
    return NextResponse.json({ deckId });
  } catch (error) {
    console.error("[/api/deck] Error:", error);
    return NextResponse.json(
      { error: "Failed to create shared deck" },
      { status: 500 }
    );
  }
}
