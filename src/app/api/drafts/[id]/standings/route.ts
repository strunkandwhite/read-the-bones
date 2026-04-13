import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { AppError } from "@/core/errors";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const draft = await queries.getDraft(id);
    const numSeats = draft?.num_seats;
    // No redaction — the match matrix makes it trivially deducible
    const noRedaction = new Set<number>();
    const result = await queries.getStandings(id, numSeats, noRedaction);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/standings] Error:", error);
    return NextResponse.json(
      { error: "Failed to load standings" },
      { status: 500 },
    );
  }
}
