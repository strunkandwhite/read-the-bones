import { NextRequest, NextResponse } from "next/server";
import { getCards } from "@/core/getCards";
import { isLocalHost } from "@/core/isLocal";

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
    const host = request.headers.get("host") ?? "";
    const result = await getCards({
      draftIds,
      activeDraft,
      poolAsOfDraft,
      includeWinStats: isLocalHost(host),
    });

    // Cache forever at the edge — the ?v= param busts the cache on new ingestions.
    // When activeDraft is present, disable caching since taken cards change frequently.
    const cacheControl = activeDraft
      ? "no-store"
      : "public, s-maxage=31536000, stale-while-revalidate=60";

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
