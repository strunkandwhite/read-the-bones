import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { AppError } from "@/core/errors";
import { extractToken } from "@/core/tokenAuth";
import { resolveToken } from "@/core/db/queries/seatTokens";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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
      autoPickMode: resolved.autoPickMode,
      displayName: resolved.displayName,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/me] Error:", error);
    return NextResponse.json({ error: "Failed to resolve seat" }, { status: 500 });
  }
}
