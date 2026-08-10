import { NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getAllCardWinStats } from "@/core/db/queries";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

// Decklist win rates are dev-only tooling and disabled in production.
// Using an env check rather than trusting the client-supplied Host header, which
// can be spoofed and also appears in server/CDN logs when used for auth decisions.
const WIN_STATS_ENABLED = process.env.NODE_ENV !== "production";

export const GET = withApiErrors(async () => {
  if (!WIN_STATS_ENABLED) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const client = await getClient();
  const stats = await getAllCardWinStats(client);

  // No cache-control header: dev-only, always fresh (the query layer memoizes).
  return NextResponse.json({ cards: Object.fromEntries(stats) });
}, "[/api/cards/win-stats] Error:");
