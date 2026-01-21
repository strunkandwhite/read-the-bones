import { NextRequest, NextResponse } from "next/server";
import { getDraftStats } from "@/core/getDraftStats";
import { wilsonInterval } from "@/core/wilsonInterval";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const draftIdsParam = searchParams.get("draft_ids");
    const draftIds = draftIdsParam?.split(",").filter(Boolean) ?? undefined;

    const result = await getDraftStats({ draftIds });

    // Decompose color pairs into individual color buckets
    const buckets = new Map<string, { wins: number; losses: number }>();
    for (const c of result.winRateByColor) {
      const colors = c.color === "C" ? ["C"] : c.color.split("");
      for (const color of colors) {
        if (!buckets.has(color)) buckets.set(color, { wins: 0, losses: 0 });
        const b = buckets.get(color)!;
        b.wins += c.wins;
        b.losses += c.losses;
      }
    }
    const order = "WUBRGC";
    const winRateByIndividualColor = [...buckets.entries()]
      .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
      .map(([color, { wins, losses }]) => {
        const total = wins + losses;
        const [ciLower, ciUpper] = wilsonInterval(wins, total);
        return { color, wins, losses, winRate: total > 0 ? wins / total : 0, ciLower, ciUpper };
      });

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
