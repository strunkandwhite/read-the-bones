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
  getLiveDraftingDrafts: vi.fn().mockResolvedValue([]),
  completeAgedPlayingDrafts: vi.fn().mockResolvedValue(0),
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

vi.mock("@/core/processPick", () => ({
  resumeAutoPickForCurrentSeat: vi.fn().mockResolvedValue({
    picks: [], phaseChanged: false, newPhase: null,
  }),
}));

import { GET } from "./route";
import { getActiveDrafts, getLiveDraftingDrafts, acquireSyncLock } from "@/core/db/sync/lock";
import { syncActiveDraft } from "@/core/db/sync/syncActiveDraft";
import { resumeAutoPickForCurrentSeat } from "@/core/processPick";

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
    expect(body.picksUpdated).toBe(0);
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
        picksUpdated: 1,
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
    expect(body.picksUpdated).toBe(1);
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
    expect(body.picksUpdated).toBe(0);
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

// vi.clearAllMocks() clears recorded calls but leaves implementations and any
// queued mockResolvedValueOnce values in place, so each of these resets the
// mocks it drives rather than inheriting whatever the previous test left.
describe("GET /api/sync — live-draft auto-pick heartbeat", () => {
  beforeEach(() => {
    vi.mocked(getActiveDrafts).mockReset().mockResolvedValue([]);
    vi.mocked(getLiveDraftingDrafts).mockReset().mockResolvedValue([]);
    vi.mocked(resumeAutoPickForCurrentSeat).mockReset().mockResolvedValue({
      picks: [], phaseChanged: false, newPhase: null,
    });
  });

  it("nudges live drafts even when no Sheets draft is active", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["kishla-skimmer"]);
    vi.mocked(resumeAutoPickForCurrentSeat).mockResolvedValue({
      picks: [{ pickN: 384, seat: 4, cardId: 1, cardName: "Bolt" }],
      phaseChanged: false,
      newPhase: null,
    });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledWith(mockClient, "kishla-skimmer");
    expect(body.status).toBe("no_active_drafts");
    expect(body.autoPicked).toBe(1);
  });

  it("nudges every live draft and totals the picks", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["draft-a", "draft-b"]);
    vi.mocked(resumeAutoPickForCurrentSeat)
      .mockResolvedValueOnce({
        picks: [{ pickN: 1, seat: 1, cardId: 1, cardName: "A" }],
        phaseChanged: false, newPhase: null,
      })
      .mockResolvedValueOnce({
        picks: [
          { pickN: 2, seat: 2, cardId: 2, cardName: "B" },
          { pickN: 3, seat: 3, cardId: 3, cardName: "C" },
        ],
        phaseChanged: false, newPhase: null,
      });

    const body = await (await GET(cronRequest())).json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledTimes(2);
    expect(body.autoPicked).toBe(3);
  });

  it("keeps going when one draft's nudge throws", async () => {
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["bad-draft", "good-draft"]);
    vi.mocked(resumeAutoPickForCurrentSeat)
      .mockRejectedValueOnce(new Error("Conflict: pick_n already exists — retry"))
      .mockResolvedValueOnce({
        picks: [{ pickN: 9, seat: 1, cardId: 1, cardName: "A" }],
        phaseChanged: false, newPhase: null,
      });

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.autoPicked).toBe(1);
  });

  it("nudges live drafts even when the sync lock is already held", async () => {
    // A non-empty activeDrafts plus a held lock is the only way to reach the
    // in_progress return — an empty activeDrafts list would return earlier,
    // at no_active_drafts, without ever exercising this branch.
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-abc" },
    ]);
    vi.mocked(acquireSyncLock).mockResolvedValueOnce(false);
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["kishla-skimmer"]);

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledWith(mockClient, "kishla-skimmer");
    expect(body.status).toBe("in_progress");
  });

  it("runs the heartbeat even without a Sheets API key", async () => {
    // Likewise, activeDrafts must be non-empty to reach the API-key check at
    // all — otherwise this returns at no_active_drafts before ever looking at
    // GOOGLE_SHEETS_API_KEY, and the test would pass for the wrong reason.
    vi.mocked(getActiveDrafts).mockResolvedValue([
      { draftId: "draft-1", sheetId: "sheet-abc" },
    ]);
    delete process.env.GOOGLE_SHEETS_API_KEY;
    vi.mocked(getLiveDraftingDrafts).mockResolvedValue(["kishla-skimmer"]);

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(resumeAutoPickForCurrentSeat).toHaveBeenCalledWith(mockClient, "kishla-skimmer");
    expect(res.status).toBe(500);
    expect(body.error).toBe("Server misconfiguration");
  });
});
