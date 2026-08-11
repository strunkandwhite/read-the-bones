import { NextRequest, NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { authenticateSeat } from "@/core/tokenAuth";
import { withApiErrors } from "@/app/api/_lib/withApiErrors";

export const GET = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat, autoPick, displayName } = await authenticateSeat(client, request, draftId);
    return NextResponse.json({ seat, autoPick, displayName });
  },
  "[/api/drafts/[id]/me] Error:"
);
