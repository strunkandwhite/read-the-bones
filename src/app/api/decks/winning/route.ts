import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { getClient } from "@/core/db/client";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

const VALID_COLOR_PAIR = /^[WUBRG]{1,2}$|^C$/;
const WUBRG = "WUBRG";

function normalizeColorPair(input: string): string | null {
  const upper = input.toUpperCase();
  if (!VALID_COLOR_PAIR.test(upper)) return null;
  if (upper.length === 2 && upper[0] === upper[1]) return null;
  if (upper === "C") return "C";
  return upper.split("").sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b)).join("");
}

export const GET = withApiErrors(
  async (request: NextRequest) => {
    const { searchParams } = request.nextUrl;
    const colorPair = searchParams.get("color_pair");

    if (!colorPair) {
      return NextResponse.json({ error: "color_pair is required" }, { status: 400 });
    }

    const normalized = normalizeColorPair(colorPair);
    if (!normalized) {
      return NextResponse.json(
        { error: "color_pair must be 1-2 distinct characters from WUBRG, or C" },
        { status: 400 },
      );
    }

    const draftIdsParam = searchParams.get("draft_ids");
    const draft_ids = draftIdsParam
      ? draftIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;

    const client = await getClient();
    const result = await queries.getWinningDecksByColor(client, {
      color_pair: normalized,
      draft_ids,
    });

    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=300" },
    });
  },
  "[/api/decks/winning] Error:",
);
