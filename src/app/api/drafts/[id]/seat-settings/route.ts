import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { updateAutoPick, updateDisplayName } from "@/core/db/queries/seatTokens";
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

    if (body.display_name !== undefined && typeof body.display_name === "string" && body.display_name.length > 50) {
      return NextResponse.json({ error: "display_name must be 50 characters or fewer" }, { status: 400 });
    }

    if (body.auto_pick !== undefined) {
      await updateAutoPick(client, draftId, seat, body.auto_pick);
    }
    if (body.display_name !== undefined) {
      await updateDisplayName(client, draftId, seat, body.display_name || null);
    }

    const result = await client.execute({
      sql: "SELECT auto_pick, display_name FROM seat_tokens WHERE draft_id = ? AND seat = ?",
      args: [draftId, seat],
    });
    const row = result.rows[0];

    return NextResponse.json({
      seat,
      autoPick: row.auto_pick === 1,
      displayName: row.display_name as string | null,
    });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("[/api/drafts/[id]/seat-settings] Error:", error);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
