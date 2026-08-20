import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { reportMatchResult, deleteMatchResult } from "@/core/db/queries/matches";
import { getDraftMeta } from "@/core/db/queries/drafts";
import { validateMatchResult } from "@/core/match-validation";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";
import type { Client } from "@libsql/client";

interface NormalizedSeats {
  seat1: number;
  seat2: number;
}

/**
 * Shared validation for both match mutation endpoints: opponent_seat shape,
 * the self-match rule, draft lookup, the playing/complete phase gate, and
 * seat normalization. `action` only changes wording ("report" vs "delete")
 * in the two messages that differ between POST and DELETE; every other
 * message and status code is identical between callers.
 */
async function validateAndNormalizeSeats(
  client: Client,
  draftId: string,
  mySeat: number,
  opponentSeat: number,
  action: "report" | "delete"
): Promise<NextResponse | NormalizedSeats> {
  if (opponentSeat == null) {
    return NextResponse.json({ error: "opponent_seat required" }, { status: 400 });
  }
  if (!Number.isInteger(opponentSeat)) {
    return NextResponse.json({ error: "opponent_seat must be an integer" }, { status: 400 });
  }
  if (opponentSeat < 1) {
    return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
  }
  if (opponentSeat === mySeat) {
    return NextResponse.json(
      { error: `Cannot ${action} a match against yourself` },
      { status: 400 }
    );
  }

  const meta = await getDraftMeta(client, draftId);
  if (!meta) {
    return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  }
  const { phase, numSeats } = meta;
  if (phase !== "playing" && phase !== "complete") {
    return NextResponse.json(
      { error: `Cannot ${action} matches in '${phase}' phase` },
      { status: 400 }
    );
  }
  if (opponentSeat > numSeats) {
    return NextResponse.json({ error: `opponent_seat must be <= ${numSeats}` }, { status: 400 });
  }

  return {
    seat1: Math.min(mySeat, opponentSeat),
    seat2: Math.max(mySeat, opponentSeat),
  };
}

export const POST = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat, wins, losses } = body;
    if (opponent_seat == null || wins == null || losses == null) {
      return NextResponse.json(
        { error: "opponent_seat, wins, and losses required" },
        { status: 400 }
      );
    }
    if (!Number.isInteger(opponent_seat) || !Number.isInteger(wins) || !Number.isInteger(losses)) {
      return NextResponse.json(
        { error: "opponent_seat, wins, and losses must be integers" },
        { status: 400 }
      );
    }
    const validationError = validateMatchResult(wins, losses);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const normalized = await validateAndNormalizeSeats(
      client,
      draftId,
      mySeat,
      opponent_seat,
      "report"
    );
    if (normalized instanceof NextResponse) {
      return normalized;
    }
    const { seat1, seat2 } = normalized;
    const seat1Wins = mySeat === seat1 ? wins : losses;
    const seat2Wins = mySeat === seat2 ? wins : losses;

    await reportMatchResult(client, draftId, seat1, seat2, seat1Wins, seat2Wins, mySeat);

    return NextResponse.json({ success: true, seat1, seat2, seat1Wins, seat2Wins });
  },
  "[/api/drafts/[id]/match] Error:"
);

export const DELETE = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat } = body;

    const normalized = await validateAndNormalizeSeats(
      client,
      draftId,
      mySeat,
      opponent_seat,
      "delete"
    );
    if (normalized instanceof NextResponse) {
      return normalized;
    }
    const { seat1, seat2 } = normalized;

    // Either participant may delete, mirroring the report path where either
    // participant may overwrite the pair's result.
    const deleted = await deleteMatchResult(client, draftId, seat1, seat2);

    return NextResponse.json({ success: true, seat1, seat2, deleted });
  },
  "[/api/drafts/[id]/match] DELETE Error:"
);
