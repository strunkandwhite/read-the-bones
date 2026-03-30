import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { updateAutoPick, updateAutoPickMode, updateDisplayName, getSeatSettings } from "@/core/db/queries/seatTokens";
import { AppError } from "@/core/errors";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();

    if (body.display_name !== undefined && body.display_name !== null && typeof body.display_name !== "string") {
      return NextResponse.json({ error: "display_name must be a string" }, { status: 400 });
    }

    if (body.display_name !== undefined && typeof body.display_name === "string" && body.display_name.length > 50) {
      return NextResponse.json({ error: "display_name must be 50 characters or fewer" }, { status: 400 });
    }

    if (body.auto_pick !== undefined) {
      if (typeof body.auto_pick !== "boolean") {
        return NextResponse.json({ error: "auto_pick must be a boolean" }, { status: 400 });
      }
      await updateAutoPick(client, draftId, seat, body.auto_pick);
    }
    if (body.auto_pick_mode !== undefined) {
      if (!["resilient", "cautious"].includes(body.auto_pick_mode)) {
        return NextResponse.json({ error: "auto_pick_mode must be 'resilient' or 'cautious'" }, { status: 400 });
      }
      await updateAutoPickMode(client, draftId, seat, body.auto_pick_mode);
    }
    if (body.display_name !== undefined) {
      await updateDisplayName(client, draftId, seat, body.display_name || null);
    }

    const settings = await getSeatSettings(client, draftId, seat);

    return NextResponse.json({
      seat,
      autoPick: settings!.autoPick,
      autoPickMode: settings!.autoPickMode,
      displayName: settings!.displayName,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/seat-settings] Error:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
