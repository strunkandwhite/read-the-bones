import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const result = await queries.getDraft(id);
    if (!result) {
      return NextResponse.json({ error: `Draft not found: ${id}` }, { status: 404 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  } catch (error) {
    console.error("[/api/drafts/[id]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load draft" },
      { status: 500 },
    );
  }
}
