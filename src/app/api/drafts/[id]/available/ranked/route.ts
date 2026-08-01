import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { intParam, requiredIntParam } from "@/app/api/_utils";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

// Worth-model fields (worth/danger/pick_value, seat horizons, color flags)
// are only available in non-production environments. Using an env check
// rather than trusting the client-supplied Host header, which can be spoofed
// and also appears in server/CDN logs when used for auth decisions.
const WORTH_ENABLED = process.env.NODE_ENV !== "production";

const LEGACY_SORT_VALUES = ["geomean_pick", "win_rate", "play_rate"] as const;
const WORTH_SORT_VALUES = ["pick_value", "first_pick_score"] as const;
const ALL_SORT_VALUES = [...LEGACY_SORT_VALUES, ...WORTH_SORT_VALUES] as const;
type SortBy = (typeof ALL_SORT_VALUES)[number];

const WUBRG = "WUBRG";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id } = await params;
    const { searchParams } = request.nextUrl;
    const beforePickN = requiredIntParam(searchParams.get("before_pick_n"));
    if (beforePickN === null) {
      return NextResponse.json(
        { error: "before_pick_n is required and must be an integer" },
        { status: 400 },
      );
    }

    const seat = intParam(searchParams.get("seat"));

    const committedColorsRaw = searchParams.get("committed_colors");
    let committedColors: string | undefined;
    if (committedColorsRaw !== null) {
      // "" is a valid state (uncommitted); anything longer than a pair or
      // outside WUBRG is a caller error.
      const isValid =
        committedColorsRaw.length <= 2 &&
        [...committedColorsRaw].every((letter) => WUBRG.includes(letter));
      if (!isValid) {
        return NextResponse.json(
          { error: "committed_colors must be at most two letters from WUBRG" },
          { status: 400 },
        );
      }
      committedColors = committedColorsRaw;
    }

    // Unrecognized legacy sort_by values silently fall through to undefined
    // (documented quirk, preserved as-is). Only the two worth-model values
    // participate in the production gating rule below.
    const rawSortBy = searchParams.get("sort_by");
    const sortBy =
      rawSortBy !== null && (ALL_SORT_VALUES as readonly string[]).includes(rawSortBy)
        ? (rawSortBy as SortBy)
        : undefined;

    const worthRequested =
      sortBy === "pick_value" ||
      sortBy === "first_pick_score" ||
      seat !== undefined ||
      committedColors !== undefined;
    if (worthRequested && !WORTH_ENABLED) {
      // Explicit rejection beats silently downgrading to a non-worth ranking.
      return NextResponse.json(
        { error: "worth model is not available in production" },
        { status: 400 },
      );
    }

    const result = await queries.rankAvailableCards({
      draft_id: id,
      before_pick_n: beforePickN,
      color: searchParams.get("color") ?? undefined,
      type_contains: searchParams.get("type_contains") ?? undefined,
      deck_colors: searchParams.get("deck_colors") ?? undefined,
      limit: Math.max(1, Math.min(Number(searchParams.get("limit")) || 50, 1000)),
      sort_by: sortBy,
      seat,
      committed_colors: committedColors,
      include_worth: (WORTH_ENABLED && worthRequested) || undefined,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=60" },
    });
  },
  "[/api/drafts/[id]/available/ranked] Error:",
);
