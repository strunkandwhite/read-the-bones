import { NextRequest, NextResponse } from "next/server";
import { getDraftStats } from "@/core/getDraftStats";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const draftsParam = searchParams.get("drafts");
  const draftIds = draftsParam
    ? draftsParam.split(",").filter(Boolean)
    : undefined;

  try {
    const result = await getDraftStats({ draftIds });

    const response = NextResponse.json(result);
    response.headers.set(
      "Cache-Control",
      "public, s-maxage=31536000, stale-while-revalidate=60"
    );

    return response;
  } catch (error) {
    console.error("[/api/draft-stats] Error:", error);
    return NextResponse.json(
      { error: "Failed to load draft stats" },
      { status: 500 }
    );
  }
}
