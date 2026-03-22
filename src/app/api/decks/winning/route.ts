import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";

const VALID_COLOR_PAIR = /^[WUBRG]{1,2}$|^C$/;

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const colorPair = searchParams.get("color_pair");

    if (!colorPair) {
      return NextResponse.json({ error: "color_pair is required" }, { status: 400 });
    }

    const normalized = colorPair.toUpperCase();
    if (!VALID_COLOR_PAIR.test(normalized)) {
      return NextResponse.json(
        { error: "color_pair must be 1-2 characters from WUBRG, or C" },
        { status: 400 },
      );
    }

    const draftIdsParam = searchParams.get("draft_ids");
    const draft_ids = draftIdsParam
      ? draftIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const result = await queries.getWinningDecksByColor({
      color_pair: normalized,
      draft_ids,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=300" },
    });
  } catch (error) {
    console.error("[/api/decks/winning] Error:", error);
    return NextResponse.json(
      { error: "Failed to load winning decks" },
      { status: 500 },
    );
  }
}
