import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { requiredIntParam } from "@/app/api/_utils";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const seat = requiredIntParam(request.nextUrl.searchParams.get("seat"));
    if (seat === null) {
      return NextResponse.json(
        { error: "seat is required and must be an integer" },
        { status: 400 },
      );
    }
    const result = await queries.getDeck({ draft_id: id, seat });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  } catch (error) {
    console.error("[/api/drafts/[id]/deck] Error:", error);
    return NextResponse.json(
      { error: "Failed to load deck" },
      { status: 500 },
    );
  }
}
