import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const cardName = searchParams.get("card_name");
    if (!cardName) {
      return NextResponse.json({ error: "card_name is required" }, { status: 400 });
    }
    const result = await queries.getCardStats({
      card_name: cardName,
      draft_id: searchParams.get("draft_id") ?? undefined,
      date_from: searchParams.get("date_from") ?? undefined,
      date_to: searchParams.get("date_to") ?? undefined,
      draft_name: searchParams.get("draft_name") ?? undefined,
      deck_colors: searchParams.get("deck_colors") ?? undefined,
    });
    if (!result) {
      const fuzzy = await queries.resolveCardFuzzy(cardName);
      if (fuzzy.candidates) {
        return NextResponse.json(
          { error: `Card not found: ${cardName}`, candidates: fuzzy.candidates },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: `Card not found: ${cardName}` },
        { status: 404 },
      );
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, s-maxage=300" },
    });
  } catch (error) {
    console.error("[/api/cards/stats] Error:", error);
    return NextResponse.json(
      { error: "Failed to load card stats" },
      { status: 500 },
    );
  }
}
