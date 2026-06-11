import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";
import { getLiveStateSig, getRecentPicks, getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";
import { getDraftMeta } from "@/core/db/queries/drafts";
import { getOptedOutSeats } from "@/core/db/queries/helpers";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const client = await getClient();

    // --- Change short-circuit ---
    // Client sends ?since=<latestPickN>&sig=<metaSig> from its last successful response.
    // We run getLiveStateSig (two fast queries) to check if anything changed. If the
    // pick number and meta signature are both identical, return {unchanged:true} without
    // running the heavy board queries. Never false-positives: sig covers phase, matchCount,
    // and seat display names — any of those changing breaks the short-circuit.
    const url = new URL(request.url);
    const sinceParam = url.searchParams.get("since");
    const sigParam = url.searchParams.get("sig");

    const { latestPickN: currentPickN, sig: currentSig } = await getLiveStateSig(client, draftId);

    // If getLiveStateSig found no draft (sig would be "||"), the draft-not-found check
    // below (via getDraftMeta) will still handle it correctly.
    if (
      sinceParam !== null &&
      sigParam !== null &&
      Number(sinceParam) === currentPickN &&
      sigParam === currentSig
    ) {
      return NextResponse.json({ unchanged: true }, { headers: { "Cache-Control": "no-cache" } });
    }

    const meta = await getDraftMeta(client, draftId);
    if (!meta) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }

    const { phase, numSeats, picksPerPlayer } = meta;
    // Use display names (original casing) for the API response
    const bannedCards = meta.bannedCardsDisplay;

    // Fetch opt-outs once and share across both pick queries to avoid duplicate DB hits.
    const optedOutSeats = await getOptedOutSeats(client, draftId);

    const [recentPicks, seatNames, matchCount, picks] = await Promise.all([
      getRecentPicks(client, draftId, 10, optedOutSeats),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
      getPicksWithCardDetails(client, draftId, optedOutSeats),
    ]);

    const next = picksPerPlayer
      ? getNextPick(currentPickN, numSeats, picksPerPlayer)
      : null;
    const totalMatches = (numSeats * (numSeats - 1)) / 2;

    return NextResponse.json({
      phase,
      numSeats,
      picksPerPlayer,
      latestPickN: currentPickN,
      nextSeat: next?.seat ?? null,
      recentPicks,
      seatNames,
      matchCount,
      totalMatches,
      picks,
      bannedCards,
      // Client echoes latestPickN + sig back on subsequent polls for the change short-circuit.
      // Including sig in the response avoids the client having to recompute the server's
      // SQL-derived seat-names string.
      liveSig: currentSig,
    }, { headers: { "Cache-Control": "no-cache" } });
  },
  "[/api/drafts/[id]/live] Error:",
);
