import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { getClient } from "@/core/db/client";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const client = await getClient();
    const draft = await queries.getDraft(client, id);
    const numSeats = draft?.num_seats;
    const result = await queries.getStandings(client, id, numSeats);
    // no-cache (like /live): standings mutate during a live pod, and a CDN-cached
    // body served right after a match report makes the reported result vanish
    // from the client until the cache entry expires.
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-cache" },
    });
  },
  "[/api/drafts/[id]/standings] Error:"
);
