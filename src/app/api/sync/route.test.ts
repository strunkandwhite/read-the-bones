import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockClient = vi.hoisted(() => ({ execute: vi.fn(), batch: vi.fn() }));
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue(mockClient),
}));

vi.mock("@/core/db/sync/lock", () => ({
  acquireSyncLock: vi.fn().mockResolvedValue(true),
  releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  updateLastSyncedAt: vi.fn().mockResolvedValue("1234567890"),
  getActiveDrafts: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/core/db/sync/syncActiveDraft", () => ({
  syncActiveDraft: vi.fn().mockResolvedValue({
    draftId: "test-draft",
    picksInserted: 0,
    picksUpdated: 0,
    matchesReplaced: 0,
    status: "no_change",
    diverged: false,
    phaseSet: null,
  }),
}));

import { GET } from "./route";
import { getActiveDrafts } from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";

// Helper to create GET request with cron auth
function cronRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/sync"), {
    headers: { authorization: "Bearer test-cron-secret" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.GOOGLE_SHEETS_API_KEY = "test-api-key";
});

describe("GET /api/sync (cron)", () => {
  it("returns 401 without valid cron secret", async () => {
    const res = await GET(new NextRequest(new URL("http://localhost:3000/api/sync")));
    expect(res.status).toBe(401);
  });

  it("returns no_active_drafts when none exist", async () => {
    const res = await GET(cronRequest());
    const body = await res.json();
    expect(body.status).toBe("no_active_drafts");
  });

  it("returns no_change when syncActiveDraft reports no change", async () => {
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-abc" },
    ]);
    vi.mocked(syncActiveDraft).mockResolvedValue({
      draftId: "draft-1",
      picksInserted: 0,
      picksUpdated: 0,
      matchesReplaced: 0,
      status: "no_change",
      diverged: false,
      phaseSet: null,
    });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(body.status).toBe("no_change");
    expect(body.picksInserted).toBe(0);
    expect(body.matchesReplaced).toBe(0);
  });

  it("returns completed with totals when picks and/or matches changed", async () => {
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-abc" },
      { draftId: "draft-2", sheetId: "sheet-def" },
    ]);
    vi.mocked(syncActiveDraft)
      .mockResolvedValueOnce({
        draftId: "draft-1",
        picksInserted: 3,
        picksUpdated: 0,
        matchesReplaced: 2,
        status: "updated",
        diverged: false,
        phaseSet: null,
      })
      .mockResolvedValueOnce({
        draftId: "draft-2",
        picksInserted: 1,
        picksUpdated: 0,
        matchesReplaced: 0,
        status: "updated",
        diverged: false,
        phaseSet: null,
      });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(body.status).toBe("completed");
    expect(body.picksInserted).toBe(4);
    expect(body.matchesReplaced).toBe(2);
  });

  it("passes api key and draft info to syncActiveDraft", async () => {
    const draft = { draftId: "terminate", sheetId: "sheet-123" };
    vi.mocked(getActiveDrafts).mockResolvedValue([draft]);

    await GET(cronRequest());

    expect(syncActiveDraft).toHaveBeenCalledWith(mockClient, draft, "test-api-key");
  });

  it("continues with other drafts if one fails", async () => {
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-1" },
      { draftId: "draft-2", sheetId: "sheet-2" },
    ]);
    vi.mocked(syncActiveDraft)
      .mockRejectedValueOnce(new Error("Sheets API error"))
      .mockResolvedValueOnce({
        draftId: "draft-2",
        picksInserted: 1,
        picksUpdated: 0,
        matchesReplaced: 0,
        status: "updated",
        diverged: false,
        phaseSet: null,
      });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(syncActiveDraft).toHaveBeenCalledTimes(2);
    expect(body.status).toBe("completed");
    expect(body.picksInserted).toBe(1);
  });

  it("returns 500 when GOOGLE_SHEETS_API_KEY is not set", async () => {
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-abc" },
    ]);
    delete process.env.GOOGLE_SHEETS_API_KEY;

    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Server misconfiguration");
  });
});
