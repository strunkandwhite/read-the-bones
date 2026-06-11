import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (request: NextRequest) => {
    const { searchParams } = request.nextUrl;
    const result = await queries.listDrafts({
      date_from: searchParams.get("date_from") ?? undefined,
      date_to: searchParams.get("date_to") ?? undefined,
      draft_name: searchParams.get("draft_name") ?? undefined,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts] Error:",
);
