import { NextRequest, NextResponse } from "next/server";
import { getDraftStats } from "@/core/getDraftStats";
import { decomposeColorPairs } from "@/core/colorDecomposition";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (request: NextRequest) => {
    const { searchParams } = request.nextUrl;
    const draftIdsParam = searchParams.get("draft_ids");
    const draftIds = draftIdsParam?.split(",").filter(Boolean) ?? undefined;

    const result = await getDraftStats({ draftIds });

    const winRateByIndividualColor = decomposeColorPairs(result.winRateByColor);

    return NextResponse.json({
      winRateBySeat: result.winRateBySeat,
      winRateByColorPair: result.winRateByColor,
      winRateByIndividualColor,
    }, {
      headers: { "Cache-Control": "public, s-maxage=300" },
    });
  },
  "[/api/stats] Error:",
);
