import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { intParam, requiredIntParam } from "@/app/api/_utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const beforePickN = requiredIntParam(searchParams.get("before_pick_n"));
    if (beforePickN === null) {
      return NextResponse.json(
        { error: "before_pick_n is required and must be an integer" },
        { status: 400 },
      );
    }
    const result = await queries.rankAvailableCards({
      draft_id: id,
      before_pick_n: beforePickN,
      color: searchParams.get("color") ?? undefined,
      type_contains: searchParams.get("type_contains") ?? undefined,
      deck_colors: searchParams.get("deck_colors") ?? undefined,
      limit: intParam(searchParams.get("limit")),
      sort_by: (() => {
        const sortByValues = ["geomean_pick", "win_rate", "play_rate"] as const;
        const raw = searchParams.get("sort_by");
        if (!raw) return undefined;
        if (!sortByValues.includes(raw as typeof sortByValues[number])) return undefined;
        return raw as typeof sortByValues[number];
      })(),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/drafts/[id]/available/ranked] Error:", error);
    return NextResponse.json(
      { error: "Failed to rank available cards" },
      { status: 500 },
    );
  }
}
