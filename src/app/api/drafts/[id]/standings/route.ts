import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { getClient } from "@/core/db/client";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    const client = await getClient();
    const draft = await queries.getDraft(client, id);
    const numSeats = draft?.num_seats;
    // No redaction — the match matrix makes it trivially deducible
    const noRedaction = new Set<number>();
    const result = await queries.getStandings(client, id, numSeats, noRedaction);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/standings] Error:",
);
