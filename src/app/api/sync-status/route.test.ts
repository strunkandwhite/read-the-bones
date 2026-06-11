import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue(mockClient),
}));

vi.mock("@/core/db/sync/lock", () => ({
  getSyncStatus: vi.fn().mockResolvedValue({
    lastSyncedAt: "1700000000",
    syncInProgress: false,
  }),
  getActiveDraftInfo: vi.fn().mockResolvedValue([
    { id: "draft-1", numSeats: 10 },
  ]),
  getServerIngestionHash: vi.fn().mockResolvedValue("abc123def456abcd"),
}));

import { GET } from "./route";
import { getSyncStatus, getActiveDraftInfo, getServerIngestionHash } from "@/core/db/sync/lock";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/sync-status", () => {
  it("returns combined sync status, active drafts, and ingestionHash", async () => {
    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({
      lastSyncedAt: "1700000000",
      syncInProgress: false,
      activeDrafts: [{ id: "draft-1", numSeats: 10 }],
      ingestionHash: "abc123def456abcd",
    });
  });

  it("calls getSyncStatus, getActiveDraftInfo, and getServerIngestionHash", async () => {
    await GET();

    expect(getSyncStatus).toHaveBeenCalledWith(mockClient);
    expect(getActiveDraftInfo).toHaveBeenCalledWith(mockClient);
    expect(getServerIngestionHash).toHaveBeenCalledWith(mockClient);
  });

  it("returns 500 on error", async () => {
    vi.mocked(getSyncStatus).mockRejectedValueOnce(new Error("DB error"));

    const res = await GET();
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body.error).toBe("Failed to get sync status");
  });
});
