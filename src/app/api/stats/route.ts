import { NextRequest, NextResponse } from "next/server";
import { getDraftStats } from "@/core/getDraftStats";
import { decomposeColorPairs } from "@/core/colorDecomposition";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const draftIdsParam = searchParams.get("draft_ids");
    const draftIds = draftIdsParam?.split(",").filter(Boolean) ?? undefined;

    const result = await getDraftStats({ draftIds });

    const winRateByIndividualColor = decomposeColorPairs(result.winRateByColor);

    return NextResponse.json({
      winRateBySeat: result.winRateBySeat,
      winRateByColorPair: result.winRateByColor,
      winRateByIndividualColor,
    });
  } catch (error) {
    console.error("[/api/stats] Error:", error);
    return NextResponse.json(
      { error: "Failed to load overall stats" },
      { status: 500 },
    );
  }
}
