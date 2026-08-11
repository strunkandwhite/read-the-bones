/**
 * syncAll happy path + continue-on-error behaviour.
 *
 * syncAll is the CLI entry point (pnpm sync). It was previously untested.
 *
 * We mock the heavy external dependencies (Sheets fetch, Scryfall cache,
 * opt-outs, loadEnv) and drive the orchestration with a mock client whose
 * execute() returns canned rows.  The intent is to verify:
 *
 *   1. Multiple drafts are each processed independently.
 *   2. A failed draft (Sheets error) does not abort the run; the error is
 *      captured in runResult.errors and results still contain the entry.
 *   3. Missing GOOGLE_SHEETS_API_KEY returns an error immediately with no
 *      draft queries.
 *   4. filterDraftId narrows the query to a single draft.
 *   5. No-drafts-found path returns empty results cleanly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncAll } from "../index";

// ---------------------------------------------------------------------------
// External dependency mocks
// ---------------------------------------------------------------------------

// fetchDraftTabsRaw — simulates Sheets API calls
vi.mock("../../../sheets", () => ({
  fetchDraftTabsRaw: vi.fn(),
}));

// loadScryfallCache — avoid reading the real cache file from disk
vi.mock("../../ingest/scryfall", () => ({
  loadScryfallCache: vi.fn().mockReturnValue(new Map()),
  backfillScryfallData: vi.fn().mockResolvedValue(0),
}));

// loadOptOutNames — no opt-outs in tests
vi.mock("../../../optOuts", () => ({
  loadOptOutNames: vi.fn().mockReturnValue(new Set()),
}));

// loadEnv — no-op; tests set env vars directly
vi.mock("../../ingest/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ingest/utils")>();
  return {
    ...actual,
    loadEnv: vi.fn(),
  };
});

import { fetchDraftTabsRaw } from "../../../sheets";

// ---------------------------------------------------------------------------
// Minimal raw data builders (same shapes as sync.test.ts helpers)
// ---------------------------------------------------------------------------

function minimalPickRows(drafterName: string): string[][] {
  return [[], [], ["", "", drafterName, "↩"], ["1", "→", "Lightning Bolt", "R"]];
}

function minimalPoolRows(): string[][] {
  return [
    ["", "Card Name", "", "Color"],
    ["", "Lightning Bolt", "", "R"],
  ];
}

const MINIMAL_RAW_DATA = {
  pool: minimalPoolRows(),
  picks: minimalPickRows("Alice"),
  matches: null,
};

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

type ExecHandler = (params: { sql: string; args: unknown[] }) => {
  rows: Record<string, unknown>[];
  lastInsertRowid?: bigint;
};

function makeClient(execHandler?: ExecHandler) {
  const handler: ExecHandler = execHandler ?? (() => ({ rows: [] }));
  return {
    execute: vi
      .fn()
      .mockImplementation((params: { sql: string; args: unknown[] }) =>
        Promise.resolve(handler(params))
      ),
    batch: vi.fn().mockResolvedValue([]),
  };
}

function makeMultiDraftClient(
  drafts: Array<{ draftId: string; sheetId: string }>
): ReturnType<typeof makeClient> {
  return makeClient((params) => {
    // Draft list query (for all-active or filter)
    if (
      params.sql.includes("SELECT draft_id, sheet_id FROM drafts") &&
      !params.sql.includes("pool_hash")
    ) {
      return {
        rows: drafts.map((d) => ({ draft_id: d.draftId, sheet_id: d.sheetId })),
      };
    }
    // Card cache load
    if (params.sql.includes("SELECT card_id, name FROM cards")) {
      return { rows: [{ card_id: 1, name: "Lightning Bolt" }] };
    }
    // getDomainHashes — trigger full replace
    if (params.sql.includes("pool_hash")) {
      return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
    }
    // ensureCubeSnapshot — no existing snapshot
    if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
      return { rows: [] };
    }
    // INSERT INTO cube_snapshots
    if (params.sql.includes("INSERT INTO cube_snapshots")) {
      return { rows: [], lastInsertRowid: BigInt(1) };
    }
    return { rows: [] };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_SHEETS_API_KEY = "test-api-key";
});

afterEach(() => {
  delete process.env.GOOGLE_SHEETS_API_KEY;
});

describe("syncAll", () => {
  describe("missing GOOGLE_SHEETS_API_KEY", () => {
    it("returns an error and makes no DB queries", async () => {
      delete process.env.GOOGLE_SHEETS_API_KEY;

      const client = makeClient();
      const result = await syncAll(client as any);

      expect(result.errors).toContain("GOOGLE_SHEETS_API_KEY not set");
      expect(result.results).toHaveLength(0);
      // No draft queries should have run
      const executedSqls = client.execute.mock.calls.map((c: any[]) => c[0].sql as string);
      const draftQueries = executedSqls.filter((sql) => sql.includes("SELECT draft_id"));
      expect(draftQueries).toHaveLength(0);
    });
  });

  describe("no active drafts", () => {
    it("returns empty results when no drafts have a sheet_id and matching phase", async () => {
      const client = makeClient((params) => {
        if (params.sql.includes("SELECT card_id, name FROM cards")) return { rows: [] };
        if (params.sql.includes("SELECT draft_id, sheet_id FROM drafts")) return { rows: [] };
        return { rows: [] };
      });

      const result = await syncAll(client as any);

      expect(result.results).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("happy path — multiple drafts", () => {
    it("processes each draft and collects results", async () => {
      const drafts = [
        { draftId: "draft-alpha", sheetId: "sheet-a" },
        { draftId: "draft-beta", sheetId: "sheet-b" },
      ];
      const client = makeMultiDraftClient(drafts);

      vi.mocked(fetchDraftTabsRaw).mockResolvedValue(MINIMAL_RAW_DATA);

      const result = await syncAll(client as any);

      expect(result.errors).toHaveLength(0);
      expect(result.results).toHaveLength(2);
      expect(result.results.map((r) => r.draftId).sort()).toEqual(["draft-alpha", "draft-beta"]);

      // Both drafts should have been processed (fetchDraftTabsRaw called twice)
      expect(vi.mocked(fetchDraftTabsRaw)).toHaveBeenCalledTimes(2);
    });

    it("all pool/picks/matches actions are returned for each draft", async () => {
      const drafts = [{ draftId: "draft-one", sheetId: "sheet-1" }];
      const client = makeMultiDraftClient(drafts);
      vi.mocked(fetchDraftTabsRaw).mockResolvedValue(MINIMAL_RAW_DATA);

      const result = await syncAll(client as any);

      const r = result.results[0];
      expect(r.draftId).toBe("draft-one");
      // First sync with null hashes → replace for pool and picks (no matches in MINIMAL_RAW_DATA)
      expect(r.poolAction).toBe("replace");
      expect(r.picksAction).toBe("replace");
    });
  });

  describe("continue-on-error — one draft fails, others continue", () => {
    it("captures the error for the failing draft and still processes the rest", async () => {
      const drafts = [
        { draftId: "draft-failing", sheetId: "sheet-fail" },
        { draftId: "draft-ok", sheetId: "sheet-ok" },
      ];
      const client = makeMultiDraftClient(drafts);

      vi.mocked(fetchDraftTabsRaw)
        .mockRejectedValueOnce(new Error("Sheets quota exceeded")) // first draft fails
        .mockResolvedValueOnce(MINIMAL_RAW_DATA); // second succeeds

      const result = await syncAll(client as any);

      // Error captured for the failing draft
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("draft-failing");
      expect(result.errors[0]).toContain("Sheets quota exceeded");

      // Both drafts appear in results
      expect(result.results).toHaveLength(2);

      const failedResult = result.results.find((r) => r.draftId === "draft-failing");
      const okResult = result.results.find((r) => r.draftId === "draft-ok");

      expect(failedResult?.error).toContain("Sheets quota exceeded");
      // The successful draft should have been processed
      expect(okResult?.error).toBeUndefined();
      expect(okResult?.poolAction).toBe("replace");
    });

    it("continues processing remaining drafts even if the first throws", async () => {
      const drafts = [
        { draftId: "draft-1", sheetId: "sheet-1" },
        { draftId: "draft-2", sheetId: "sheet-2" },
        { draftId: "draft-3", sheetId: "sheet-3" },
      ];
      const client = makeMultiDraftClient(drafts);

      vi.mocked(fetchDraftTabsRaw)
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValue(MINIMAL_RAW_DATA);

      const result = await syncAll(client as any);

      expect(result.results).toHaveLength(3);
      expect(result.errors).toHaveLength(1);

      const successCount = result.results.filter((r) => !r.error).length;
      expect(successCount).toBe(2);
    });
  });

  describe("filterDraftId option", () => {
    it("queries only the specified draft by ID", async () => {
      const client = makeClient((params) => {
        if (params.sql.includes("SELECT card_id, name FROM cards")) {
          return { rows: [{ card_id: 1, name: "Lightning Bolt" }] };
        }
        if (
          params.sql.includes("SELECT draft_id, sheet_id FROM drafts") &&
          params.sql.includes("draft_id = ?")
        ) {
          // filterDraftId query
          return { rows: [{ draft_id: "draft-x", sheet_id: "sheet-x" }] };
        }
        if (params.sql.includes("pool_hash")) {
          return { rows: [{ pool_hash: null, picks_hash: null, matches_hash: null }] };
        }
        if (params.sql.includes("SELECT cube_snapshot_id FROM cube_snapshots")) {
          return { rows: [] };
        }
        if (params.sql.includes("INSERT INTO cube_snapshots")) {
          return { rows: [], lastInsertRowid: BigInt(1) };
        }
        return { rows: [] };
      });

      vi.mocked(fetchDraftTabsRaw).mockResolvedValue(MINIMAL_RAW_DATA);

      const result = await syncAll(client as any, { filterDraftId: "draft-x" });

      expect(result.results).toHaveLength(1);
      expect(result.results[0].draftId).toBe("draft-x");
      expect(result.errors).toHaveLength(0);
    });

    it("returns an error when the filtered draft is not found", async () => {
      const client = makeClient((params) => {
        if (params.sql.includes("SELECT card_id, name FROM cards")) return { rows: [] };
        if (params.sql.includes("SELECT draft_id, sheet_id FROM drafts")) {
          return { rows: [] }; // not found
        }
        return { rows: [] };
      });

      const result = await syncAll(client as any, { filterDraftId: "nonexistent" });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("nonexistent");
      expect(result.results).toHaveLength(0);
    });
  });
});
