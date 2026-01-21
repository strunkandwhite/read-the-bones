import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await queries.getStandings(id);
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/drafts/[id]/standings] Error:", error);
    return NextResponse.json(
      { error: "Failed to load standings" },
      { status: 500 },
    );
  }
}
