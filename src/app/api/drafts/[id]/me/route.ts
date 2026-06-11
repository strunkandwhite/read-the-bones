import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { extractToken } from "@/core/tokenAuth";
import { resolveToken } from "@/core/db/queries/seatTokens";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { id: draftId } = await params;
    const token = extractToken(request);
    if (!token) {
      return NextResponse.json({ error: "Missing seat token" }, { status: 401 });
    }

    const client = await getClient();
    const resolved = await resolveToken(client, token);
    if (!resolved || resolved.draftId !== draftId) {
      return NextResponse.json({ error: "Invalid seat token" }, { status: 401 });
    }

    return NextResponse.json({
      seat: resolved.seat,
      autoPick: resolved.autoPick,
      displayName: resolved.displayName,
    });
  },
  "[/api/drafts/[id]/me] Error:",
);
