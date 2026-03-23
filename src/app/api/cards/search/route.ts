import { NextRequest, NextResponse } from "next/server";
import * as queries from "@/core/db/queries";
import { searchLocalCards } from "@/core/localSearch";
import { transformScryfallJson } from "@/core/db/queries/helpers";
import type { ScryCard } from "@/core/types";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const q = searchParams.get("q");
    const draftId = searchParams.get("draft_id");
    const availableOnly = searchParams.get("available_only") === "true";
    const beforePickNRaw = searchParams.get("before_pick_n");
    const beforePickN = beforePickNRaw ? parseInt(beforePickNRaw, 10) : undefined;

    // Parameter validation
    if (!q) {
      return NextResponse.json({ error: "q parameter is required" }, { status: 400 });
    }
    if (availableOnly && !draftId) {
      return NextResponse.json(
        { error: "available_only requires draft_id" },
        { status: 400 },
      );
    }
    if (beforePickN !== undefined && !availableOnly) {
      return NextResponse.json(
        { error: "before_pick_n requires available_only" },
        { status: 400 },
      );
    }
    if (availableOnly && beforePickN === undefined) {
      return NextResponse.json(
        { error: "before_pick_n is required when available_only is set" },
        { status: 400 },
      );
    }

    // Fetch cards from DB
    const dbCards = await queries.getSearchableCards({
      ...(draftId ? { draftId } : {}),
      ...(availableOnly ? { availableOnly, beforePickN } : {}),
    });

    if (dbCards === null) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    // Convert to ScryCard for search, tracking remaining_qty by name
    const scryfallCards: ScryCard[] = [];
    const remainingQtyMap = new Map<string, number>();

    for (const card of dbCards) {
      const scryCard = transformScryfallJson(card.scryfall_json, card.name);
      if (scryCard) {
        scryfallCards.push(scryCard);
        if (card.remaining_qty !== undefined) {
          remainingQtyMap.set(scryCard.name, card.remaining_qty);
        }
      }
    }

    // Run search
    const matches = searchLocalCards(q, scryfallCards);

    // Map to snake_case response
    const cards = matches.map((card) => {
      const result: Record<string, unknown> = {
        name: card.name,
        image_uri: card.imageUri,
        mana_cost: card.manaCost,
        mana_value: card.manaValue,
        type_line: card.typeLine,
        colors: card.colors,
        color_identity: card.colorIdentity,
        oracle_text: card.oracleText,
      };
      if (remainingQtyMap.has(card.name)) {
        result.remaining_qty = remainingQtyMap.get(card.name);
      }
      return result;
    });

    const cacheControl = draftId ? "no-store" : "public, s-maxage=300";

    return NextResponse.json(
      {
        query: q,
        total: cards.length,
        draft_id: draftId ?? null,
        before_pick_n: beforePickN ?? null,
        cards,
      },
      { headers: { "Cache-Control": cacheControl } },
    );
  } catch (error) {
    console.error("[/api/cards/search] Error:", error);
    return NextResponse.json(
      { error: "Failed to search cards" },
      { status: 500 },
    );
  }
}
