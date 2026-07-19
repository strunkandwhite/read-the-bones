import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getNextPick } from "@/core/snakeDraft";
import { getLiveStateSig, getRecentPicks, getPicksWithCardDetails } from "@/core/db/queries/picks";
import { getSeatDisplayNames } from "@/core/db/queries/seatTokens";
import { getMatchCount } from "@/core/db/queries/matches";
import { getDraftMeta } from "@/core/db/queries/drafts";
import { getOptedOutSeats } from "@/core/db/queries/helpers";
import { getQueue } from "@/core/db/queries/pickQueue";
import { getFloatedCards } from "@/core/db/queries/floatedCards";
import { extractToken } from "@/core/tokenAuth";
import { resolveToken } from "@/core/db/queries/seatTokens";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const client = await getClient();

    // --- Optional seat authentication ---
    // /live is a public route: missing/invalid tokens are silently ignored (no 401).
    // A valid token for THIS draft enriches the response with per-seat `me` data,
    // eliminating the need for separate /queue, /float, and /me poll requests.
    let authenticatedSeat: number | null = null;
    let authenticatedAutoPick: boolean | null = null;
    let authenticatedDisplayName: string | null = null;
    const token = extractToken(request);
    if (token) {
      const resolved = await resolveToken(client, token);
      if (resolved && resolved.draftId === draftId) {
        authenticatedSeat = resolved.seat;
        authenticatedAutoPick = resolved.autoPick;
        authenticatedDisplayName = resolved.displayName;
      }
    }

    // --- Change short-circuit ---
    // Client sends ?since=<latestPickN>&sig=<metaSig> from its last successful response.
    // We run getLiveStateSig (cheap queries) to check if anything changed. If the
    // pick number and sig are both identical, return {unchanged:true} without running
    // the heavy board queries. For authenticated callers, the sig includes a per-seat
    // freshness marker (~queueLen:floatCount) so cross-device queue/float changes
    // also break the short-circuit.
    const url = new URL(request.url);
    const sinceParam = url.searchParams.get("since");
    const sigParam = url.searchParams.get("sig");

    const { latestPickN: currentPickN, sig: currentSig } = await getLiveStateSig(
      client,
      draftId,
      authenticatedSeat ?? undefined,
    );

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

    // When authenticated, fetch per-seat data in parallel with board queries.
    const [recentPicks, seatNames, matchCount, picks, seatQueue, seatFloats] = await Promise.all([
      getRecentPicks(client, draftId, 10, optedOutSeats),
      getSeatDisplayNames(client, draftId),
      getMatchCount(client, draftId),
      getPicksWithCardDetails(client, draftId, optedOutSeats),
      authenticatedSeat !== null ? getQueue(client, draftId, authenticatedSeat) : Promise.resolve(null),
      authenticatedSeat !== null ? getFloatedCards(client, draftId, authenticatedSeat) : Promise.resolve(null),
    ]);

    const next = picksPerPlayer
      ? getNextPick(currentPickN, numSeats, picksPerPlayer)
      : null;
    const totalMatches = (numSeats * (numSeats - 1)) / 2;

    // Build `me` when the request carried a valid seat token for this draft.
    // Absent or invalid tokens result in no `me` field — the response is identical
    // to today's unauthenticated response, keeping the route fully public.
    const me = authenticatedSeat !== null ? {
      seat: authenticatedSeat,
      autoPick: authenticatedAutoPick,
      displayName: authenticatedDisplayName,
      queue: seatQueue,
      floatedCards: seatFloats,
    } : undefined;

    return NextResponse.json({
      phase,
      isSheetDraft: meta.sheetId !== null,
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
      // SQL-derived seat-names string. For authenticated callers the sig includes the
      // per-seat freshness marker so cross-device changes break the short-circuit.
      liveSig: currentSig,
      // Per-seat data for authenticated callers — eliminates separate /queue, /float,
      // and /me poll requests. Absent when no valid token was provided.
      ...(me !== undefined ? { me } : {}),
    }, { headers: { "Cache-Control": "no-cache" } });
  },
  "[/api/drafts/[id]/live] Error:",
);
