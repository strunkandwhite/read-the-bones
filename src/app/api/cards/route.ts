import { NextRequest, NextResponse } from "next/server";
import { getCards } from "@/core/getCards";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  // Parse draft IDs from comma-separated query param
  const draftsParam = searchParams.get("drafts");
  const draftIds = draftsParam
    ? draftsParam.split(",").filter(Boolean)
    : undefined;

  // Parse active draft ID (for taken-card filtering, not included in stats)
  const activeDraft = searchParams.get("activeDraft") ?? undefined;

  // Parse pool-as-of draft ID (use this draft's cube snapshot for pool filtering)
  const poolAsOfDraft = searchParams.get("poolAsOfDraft") ?? undefined;

  try {
    const result = await getCards({
      draftIds,
      activeDraft,
      poolAsOfDraft,
    });

    // Cache forever at the edge — the ?v= param busts the cache on new ingestions.
    // Previously the activeDraft path was no-store because takenCards changed per pick.
    // Now that the client derives taken state from board.picks (populated by /live polling),
    // the payload only changes when ingestion changes — so the same long-cache policy applies.
    // A fresh-page-load client may briefly see stale takenCards from the edge cache, but
    // polling (which starts immediately after mount) overrides it via board.picks recompute.
    const cacheControl = "public, s-maxage=31536000, stale-while-revalidate=60";

    return NextResponse.json(result, {
      headers: { "Cache-Control": cacheControl },
    });
  } catch (error) {
    console.error("[/api/cards] Error:", error);
    return NextResponse.json(
      { error: "Failed to load card data" },
      { status: 500 }
    );
  }
}
