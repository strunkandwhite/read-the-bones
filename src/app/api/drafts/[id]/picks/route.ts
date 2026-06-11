import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { intParam } from "@/app/api/_utils";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const result = await queries.getPicks({
      draft_id: id,
      seat: intParam(searchParams.get("seat")),
      pick_n_min: intParam(searchParams.get("pick_n_min")),
      pick_n_max: intParam(searchParams.get("pick_n_max")),
      card_name: searchParams.get("card_name") ?? undefined,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/picks] Error:",
);
