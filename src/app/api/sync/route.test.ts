import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Mocks ---

const mockClient = vi.hoisted(() => ({ execute: vi.fn(), batch: vi.fn() }));
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue(mockClient),
}));

vi.mock("@/core/sync", () => ({
  acquireSyncLock: vi.fn().mockResolvedValue(true),
  releaseSyncLock: vi.fn().mockResolvedValue(undefined),
  updateLastSyncedAt: vi.fn().mockResolvedValue("1234567890"),
  getActiveDrafts: vi.fn().mockResolvedValue([]),
  incrementalIngest: vi.fn().mockResolvedValue({ status: "no_change", picksInserted: 0 }),
}));

vi.mock("@/core/sheets", () => ({
  fetchDraftTabsRaw: vi.fn().mockResolvedValue({ picks: [], pool: [], matches: [] }),
}));

vi.mock("@/core/parseSheetRows", () => ({
  parsePickRows: vi.fn().mockReturnValue({ picks: [], numDrafters: 0, drafterNames: [], isComplete: false }),
  parseMatchRows: vi.fn().mockReturnValue([]),
}));

vi.mock("@/core/db/sync/domains", () => ({
  hashMatches: vi.fn().mockReturnValue("new-match-hash"),
  getDomainHashes: vi.fn().mockResolvedValue({ poolHash: null, picksHash: null, matchesHash: null, currentPhase: null }),
  compareDomainHash: vi.fn().mockReturnValue("skip"),
  updateDomainHashes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/core/db/sync/batch", () => ({
  batchInsertMatches: vi.fn().mockResolvedValue(undefined),
  deleteDomainData: vi.fn().mockResolvedValue(undefined),
}));

import { GET } from "./route";
import { getActiveDrafts, incrementalIngest } from "@/core/sync";
import { fetchDraftTabsRaw } from "@/core/sheets";
import { parsePickRows, parseMatchRows } from "@/core/parseSheetRows";
import { hashMatches, getDomainHashes, compareDomainHash, updateDomainHashes } from "@/core/db/sync/domains";
import { batchInsertMatches, deleteDomainData } from "@/core/db/sync/batch";

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
});

describe("match sync in runSync", () => {
  const activeDraft = { draftId: "terminate", sheetId: "sheet-123" };

  beforeEach(() => {
    vi.mocked(getActiveDrafts).mockResolvedValue([activeDraft]);
    vi.mocked(fetchDraftTabsRaw).mockResolvedValue({
      picks: [["row"]],
      pool: [],
      matches: [["match-row"]],
    });
    vi.mocked(parsePickRows).mockReturnValue({
      picks: [],
      numDrafters: 2,
      drafterNames: ["Alice", "Bob"],
      isComplete: false,
      doublePickStartsAfterRound: null, picksPerPlayer: 0,
    });
  });

  it("skips match sync when no matches are parsed", async () => {
    vi.mocked(parseMatchRows).mockReturnValue([]);

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(parseMatchRows).toHaveBeenCalledWith([["match-row"]], ["Alice", "Bob"]);
    expect(hashMatches).not.toHaveBeenCalled();
    expect(body.status).toBe("no_change");
    expect(body.matchesReplaced).toBe(0);
  });

  it("skips match sync when hash is unchanged", async () => {
    vi.mocked(parseMatchRows).mockReturnValue([
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
    ]);
    vi.mocked(compareDomainHash).mockReturnValue("skip");

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(hashMatches).toHaveBeenCalled();
    expect(getDomainHashes).toHaveBeenCalledWith(mockClient, "terminate");
    expect(deleteDomainData).not.toHaveBeenCalled();
    expect(batchInsertMatches).not.toHaveBeenCalled();
    expect(body.status).toBe("no_change");
    expect(body.matchesReplaced).toBe(0);
  });

  it("replaces matches when hash differs", async () => {
    vi.mocked(parseMatchRows).mockReturnValue([
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
      { seat1: 0, seat2: 2, seat1GamesWon: 1, seat2GamesWon: 2 },
    ]);
    vi.mocked(compareDomainHash).mockReturnValue("replace");

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(deleteDomainData).toHaveBeenCalledWith(mockClient, "terminate", "matches");
    expect(batchInsertMatches).toHaveBeenCalledWith(mockClient, [
      { draftId: "terminate", seat1: 1, seat2: 2, seat1GamesWon: 2, seat2GamesWon: 1 },
      { draftId: "terminate", seat1: 1, seat2: 3, seat1GamesWon: 1, seat2GamesWon: 2 },
    ]);
    expect(updateDomainHashes).toHaveBeenCalledWith(mockClient, "terminate", {
      matchesHash: "new-match-hash",
    });
    expect(body.status).toBe("completed");
    expect(body.matchesReplaced).toBe(2);
  });

  it("converts seats from 0-indexed to 1-indexed", async () => {
    vi.mocked(parseMatchRows).mockReturnValue([
      { seat1: 3, seat2: 7, seat1GamesWon: 2, seat2GamesWon: 0 },
    ]);
    vi.mocked(compareDomainHash).mockReturnValue("replace");

    await GET(cronRequest());

    expect(batchInsertMatches).toHaveBeenCalledWith(mockClient, [
      { draftId: "terminate", seat1: 4, seat2: 8, seat1GamesWon: 2, seat2GamesWon: 0 },
    ]);
  });

  it("syncs matches even when no new picks are inserted", async () => {
    vi.mocked(incrementalIngest).mockResolvedValue({ status: "no_change", picksInserted: 0 });
    vi.mocked(parseMatchRows).mockReturnValue([
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
    ]);
    vi.mocked(compareDomainHash).mockReturnValue("replace");

    const res = await GET(cronRequest());
    const body = await res.json();

    expect(batchInsertMatches).toHaveBeenCalled();
    expect(body.status).toBe("completed");
    expect(body.picksInserted).toBe(0);
    expect(body.matchesReplaced).toBe(1);
  });

  it("continues with other drafts if match sync fails for one", async () => {
    const drafts = [
      { draftId: "draft-1", sheetId: "sheet-1" },
      { draftId: "draft-2", sheetId: "sheet-2" },
    ];
    vi.mocked(getActiveDrafts).mockResolvedValue(drafts);
    vi.mocked(parseMatchRows).mockReturnValue([
      { seat1: 0, seat2: 1, seat1GamesWon: 2, seat2GamesWon: 1 },
    ]);
    vi.mocked(compareDomainHash).mockReturnValue("replace");

    // First draft fails on match insert, second succeeds
    vi.mocked(batchInsertMatches)
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce(undefined);

    const res = await GET(cronRequest());
    const body = await res.json();

    // Second draft's matches should still be synced
    expect(batchInsertMatches).toHaveBeenCalledTimes(2);
    expect(body.status).toBe("completed");
    expect(body.matchesReplaced).toBe(1);
  });

  it("skips matches when picks tab is missing", async () => {
    vi.mocked(fetchDraftTabsRaw).mockResolvedValue({
      picks: null,
      pool: [],
      matches: [["match-row"]],
    });

    const res = await GET(cronRequest());
    const body = await res.json();

    // parseMatchRows should not be called since we continue before reaching it
    expect(parseMatchRows).not.toHaveBeenCalled();
    expect(body.status).toBe("no_change");
  });
});
