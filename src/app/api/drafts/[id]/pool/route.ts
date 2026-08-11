import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { getClient } from "@/core/db/client";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const groupByValues = ["none", "color_identity", "type"] as const;
    const groupByRaw = searchParams.get("group_by");
    if (groupByRaw && !groupByValues.includes(groupByRaw as (typeof groupByValues)[number])) {
      return NextResponse.json(
        {
          error: `Invalid group_by value: ${groupByRaw}. Must be one of: ${groupByValues.join(", ")}`,
        },
        { status: 400 }
      );
    }
    const client = await getClient();
    const result = await queries.getDraftPool(client, {
      draft_id: id,
      include_draft_results: searchParams.get("include_draft_results") === "true",
      include_card_details: searchParams.get("include_card_details") === "true",
      group_by: (groupByRaw as (typeof groupByValues)[number]) ?? undefined,
      color: searchParams.get("color") ?? undefined,
      type_contains: searchParams.get("type_contains") ?? undefined,
      name_contains: searchParams.get("name_contains") ?? undefined,
    });
    if (!result) {
      return NextResponse.json({ error: `Draft not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/pool] Error:"
);
