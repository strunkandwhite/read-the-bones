import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { getClient } from "@/core/db/client";
import { requiredIntParam } from "@/app/api/_utils";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const beforePickN = requiredIntParam(searchParams.get("before_pick_n"));
    if (beforePickN === null) {
      return NextResponse.json(
        { error: "before_pick_n is required and must be an integer" },
        { status: 400 },
      );
    }
    if (beforePickN < 1) {
      return NextResponse.json(
        { error: "before_pick_n must be positive" },
        { status: 400 },
      );
    }
    const client = await getClient();
    const result = await queries.getAvailableCards(client, {
      draft_id: id,
      before_pick_n: beforePickN,
      color: searchParams.get("color") ?? undefined,
      type_contains: searchParams.get("type_contains") ?? undefined,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/available] Error:",
);
