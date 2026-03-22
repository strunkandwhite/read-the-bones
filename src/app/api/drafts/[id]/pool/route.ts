import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const groupByValues = ["none", "color_identity", "type"] as const;
    const groupByRaw = searchParams.get("group_by");
    if (groupByRaw && !groupByValues.includes(groupByRaw as typeof groupByValues[number])) {
      return NextResponse.json(
        { error: `Invalid group_by value: ${groupByRaw}. Must be one of: ${groupByValues.join(", ")}` },
        { status: 400 },
      );
    }
    const result = await queries.getDraftPool({
      draft_id: id,
      include_draft_results: searchParams.get("include_draft_results") === "true",
      include_card_details: searchParams.get("include_card_details") === "true",
      group_by: (groupByRaw as typeof groupByValues[number]) ?? undefined,
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
  } catch (error) {
    console.error("[/api/drafts/[id]/pool] Error:", error);
    return NextResponse.json(
      { error: "Failed to load draft pool" },
      { status: 500 },
    );
  }
}
