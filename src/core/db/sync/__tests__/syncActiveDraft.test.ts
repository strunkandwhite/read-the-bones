// Phase-decision tests for the cron sync path. Sheet fetching is mocked;
// the mock client is routed by SQL shape like the other sync tests.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { syncActiveDraft } from "../syncActiveDraft";
import { fetchDraftTabsRaw } from "../../../sheets";
import type { DraftSheetRawData } from "../../../sheets";

vi.mock("../../../sheets", () => ({
  fetchDraftTabsRaw: vi.fn(),
}));

const mockFetch = vi.mocked(fetchDraftTabsRaw);

function sheet(opts: {
  bobPicked?: boolean;
  matches?: Array<[string, number, string, number]>;
}): DraftSheetRawData {
  return {
    pool: null,
    picks: [
      [],
      [],
      ["", "", "Alice", "Bob", "↩"],
      ["1", "→", "Lightning Bolt", opts.bobPicked === false ? "" : "Counterspell", "R", "U"],
    ],
    matches: opts.matches
      ? [
          [],
          [],
          [],
          ...opts.matches.map(([p1, w1, p2, w2]) => [
            "",
            p1,
            String(w1),
            "VS",
            String(w2),
            p2,
          ]),
        ]
      : null,
  };
}

function phaseClient(opts: {
  phase: string;
  dbPicks?: Array<{ pick_n: number; seat: number; card_id: number; name: string }>;
  optedOutSeats?: number[];
}) {
  return {
    execute: vi.fn().mockImplementation(({ sql }: { sql: string }) => {
      if (sql.includes("privacy_opt_outs")) {
        return Promise.resolve({ rows: (opts.optedOutSeats ?? []).map((seat) => ({ seat })) });
      }
      if (sql.includes("pool_hash")) {
        return Promise.resolve({
          rows: [
            {
              pool_hash: null,
              picks_hash: null,
              matches_hash: null,
              phase: opts.phase,
            },
          ],
        });
      }
      if (sql.includes("JOIN cards")) {
        return Promise.resolve({ rows: opts.dbPicks ?? [] });
      }
      if (sql.includes("IN (")) {
        return Promise.resolve({
          rows: [
            { card_id: 1, name: "Lightning Bolt" },
            { card_id: 2, name: "Counterspell" },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
    batch: vi.fn().mockResolvedValue([]),
  };
}

function phaseWrites(client: { execute: ReturnType<typeof vi.fn> }): string[] {
  return client.execute.mock.calls
    .filter(([p]: any[]) => p.sql.includes("UPDATE drafts SET phase"))
    .map(([p]: any[]) => p.args[0] as string);
}

const draft = { draftId: "test-draft", sheetId: "sheet-1" };

function makeClientWithNoDomainHashes() {
  // draft:create leaves a draft in 'setup' with every domain hash NULL —
  // this is that state, before pnpm sync has ever touched the draft.
  return phaseClient({ phase: "setup" });
}

function spyOnPickInserts(client: { batch: ReturnType<typeof vi.fn> }) {
  const insertSpy = vi.fn();
  client.batch = vi.fn().mockImplementation((stmts: any[]) => {
    for (const s of stmts ?? []) {
      if (typeof s.sql === "string" && s.sql.includes("INSERT") && s.sql.includes("pick_events")) {
        insertSpy(s);
      }
    }
    return Promise.resolve([]);
  });
  return insertSpy;
}

describe("syncActiveDraft phase decisions", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("moves a drafting draft with all picks done but no matches to playing", async () => {
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({ phase: "drafting" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual(["playing"]);
    expect(result.phaseSet).toBe("playing");
  });

  it("moves a playing draft to complete when the full round robin is recorded", async () => {
    // 2 drafters → expectedMatchCount = 1
    mockFetch.mockResolvedValue(sheet({ matches: [["Alice", 2, "Bob", 1]] }));
    const client = phaseClient({ phase: "playing" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual(["complete"]);
    expect(result.status).toBe("completed");
  });

  it("keeps a playing draft in playing while matches are missing", async () => {
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({
      phase: "playing",
      dbPicks: [
        { pick_n: 1, seat: 1, card_id: 1, name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_id: 2, name: "Counterspell" },
      ],
    });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual([]);
    expect(result.phaseSet).toBeNull();
  });

  it("keeps an unfinished draft in drafting", async () => {
    mockFetch.mockResolvedValue(sheet({ bobPicked: false }));
    const client = phaseClient({ phase: "drafting" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    expect(phaseWrites(client)).toEqual([]);
    expect(result.phaseSet).toBeNull();
  });

  it("still syncs picks and matches for a complete draft but never demotes it", async () => {
    mockFetch.mockResolvedValue(sheet({ matches: [["Alice", 2, "Bob", 1]] }));
    const client = phaseClient({ phase: "complete" });
    const result = await syncActiveDraft(client as any, draft, "api-key");
    // target is 'complete' and it already is — no redundant write
    expect(phaseWrites(client)).toEqual([]);
    expect(result.picksInserted).toBe(2);
    expect(result.matchesReplaced).toBe(1);
  });

  it("deletes redacted rows before ingesting and never inserts a redacted pick", async () => {
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({ phase: "drafting", optedOutSeats: [2] });

    await syncActiveDraft(client as any, draft, "api-key");

    const sqls = client.execute.mock.calls.map(([p]: any[]) => p.sql as string);
    const deleteIdx = sqls.findIndex((s) => s.includes("DELETE FROM pick_events"));
    const dbPicksIdx = sqls.findIndex((s) => s.includes("JOIN cards"));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    // Deleting after the ingest read would let detectRemovedPicks see the
    // redacted positions as sheet deletions and flag the draft diverged.
    expect(deleteIdx).toBeLessThan(dbPicksIdx);

    const insertedSeats = client.batch.mock.calls
      .flatMap(([stmts]: any[]) => stmts ?? [])
      .filter((s: any) => s.sql.includes("INSERT OR IGNORE INTO pick_events"))
      .map((s: any) => s.args[2] as number);
    expect(insertedSeats).not.toContain(2);
    expect(insertedSeats).toContain(1);
  });

  it("still advances the phase when a redacted seat's picks are filtered out", async () => {
    // isComplete is computed from the full sheet, so filtering the picks must
    // not strand the draft in `drafting` forever.
    mockFetch.mockResolvedValue(sheet({}));
    const client = phaseClient({ phase: "drafting", optedOutSeats: [2] });

    const result = await syncActiveDraft(client as any, draft, "api-key");

    expect(result.phaseSet).toBe("playing");
    expect(result.diverged).toBe(false);
  });

  it("skips a draft that has never been synced from the CLI", async () => {
    // No domain hashes recorded => draft:create ran but pnpm sync has not.
    // Opt-outs are only recorded by the CLI, so ingesting here would write an
    // opted-out seat's picks before anything knows to exclude them.
    mockFetch.mockResolvedValue(sheet({}));
    const client = makeClientWithNoDomainHashes();
    const insertSpy = spyOnPickInserts(client);

    const result = await syncActiveDraft(client as any, draft, "api-key");

    expect(result.status).toBe("awaiting_cli_sync");
    expect(result.picksInserted).toBe(0);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
