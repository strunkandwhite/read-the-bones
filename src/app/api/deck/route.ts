import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { createSnapshot } from "@/core/db/queries/decks";
import { getDraft } from "@/core/db/queries/drafts";
import type { DeckState } from "@/core/types";
import { validateDeckState } from "@/core/validateDeckState";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

const MAX_BODY_SIZE = 100 * 1024; // 100KB

// Simple in-memory rate limit: max 10 snapshots per IP per minute.
// This is a hobby app — a lightweight guard against accidental or casual abuse
// without the overhead of a persistent rate-limit store.
const ipLastRequests = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const timestamps = (ipLastRequests.get(ip) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (timestamps.length >= RATE_MAX) return true;
  timestamps.push(now);
  ipLastRequests.set(ip, timestamps);
  return false;
}

export const POST = withApiErrors(
  async (request: NextRequest) => {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (isRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many requests" },
        { status: 429 },
      );
    }

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

    // Validate that the referenced draft exists before inserting the snapshot.
    if (deckState.draftId) {
      const draft = await getDraft(client, deckState.draftId);
      if (!draft) {
        return NextResponse.json(
          { error: "Draft not found" },
          { status: 400 },
        );
      }
    }

    const { deckId } = await createSnapshot(client, deckState);
    return NextResponse.json({ deckId });
  },
  "[/api/deck] Error:",
);
