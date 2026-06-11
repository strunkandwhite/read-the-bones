import { NextResponse } from "next/server";
import { getClient } from "@/core/db/client";
import { getSyncStatus, getActiveDraftInfo, getServerIngestionHash } from "@/core/db/sync/lock";

export async function GET() {
  try {
    const client = await getClient();
    const [syncStatus, activeDrafts, ingestionHash] = await Promise.all([
      getSyncStatus(client),
      getActiveDraftInfo(client),
      getServerIngestionHash(client),
    ]);

    return NextResponse.json({
      ...syncStatus,
      activeDrafts,
      ingestionHash,
    });
  } catch (error) {
    console.error("[sync-status] Error:", error);
    return NextResponse.json(
      { error: "Failed to get sync status" },
      { status: 500 }
    );
  }
}
