import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { requiredIntParam } from "@/app/api/_utils";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const seat = requiredIntParam(request.nextUrl.searchParams.get("seat"));
    if (seat === null) {
      return NextResponse.json(
        { error: "seat is required and must be an integer" },
        { status: 400 }
      );
    }
    const result = await queries.getDeck({ draft_id: id, seat });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/deck] Error:"
);
