import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { intParam } from "@/app/api/_utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
  } catch (error) {
    console.error("[/api/drafts/[id]/picks] Error:", error);
    return NextResponse.json(
      { error: "Failed to load picks" },
      { status: 500 },
    );
  }
}
