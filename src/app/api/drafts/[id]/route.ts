import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    const result = await queries.getDraft(id);
    if (!result) {
      return NextResponse.json({ error: `Draft not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]] Error:",
);
