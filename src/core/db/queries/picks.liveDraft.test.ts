import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getLatestPickNumber,
  getRecentPicks,
  getPicksWithCardDetails,
  getLiveStateSig,
} from "./picks";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

// Mock getClient so existing functions don't fail if accidentally called
vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("getLatestPickNumber", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the latest pick number", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 15 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(15);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("MAX(pick_n)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no picks exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ latest: 0 }] });

    const result = await getLatestPickNumber(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("getRecentPicks", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns recent picks in descending order", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { pick_n: 3, seat: 3, card_name: "Dark Ritual" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
      ],
    });

    // Pass an empty opt-out set so no extra DB query is made
    const result = await getRecentPicks(client, "draft-1", 10, new Set());

    expect(result).toEqual([
      { pickN: 3, seat: 3, cardName: "Dark Ritual" },
      { pickN: 2, seat: 2, cardName: "Counterspell" },
      { pickN: 1, seat: 1, cardName: "Lightning Bolt" },
    ]);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("ORDER BY pe.pick_n DESC LIMIT ?"),
        args: ["draft-1", 10],
      })
    );
  });

  it("returns empty array when no picks", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getRecentPicks(client, "draft-1", 5, new Set());

    expect(result).toEqual([]);
  });

  it("redacts card names for opted-out seats", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { pick_n: 3, seat: 2, card_name: "Dark Ritual" },
        { pick_n: 2, seat: 1, card_name: "Counterspell" },
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
      ],
    });

    const result = await getRecentPicks(client, "draft-1", 10, new Set([1]));

    expect(result).toEqual([
      { pickN: 3, seat: 2, cardName: "Dark Ritual" },
      { pickN: 2, seat: 1, cardName: "[REDACTED]" },
      { pickN: 1, seat: 1, cardName: "[REDACTED]" },
    ]);
  });

  it("fetches opt-outs from DB when not provided", async () => {
    // First call: opt-out query; second call: picks query
    client.execute
      .mockResolvedValueOnce({ rows: [{ draft_id: "draft-1", seat: 2 }] })
      .mockResolvedValueOnce({
        rows: [
          { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
          { pick_n: 2, seat: 2, card_name: "Dark Ritual" },
        ],
      });

    const result = await getRecentPicks(client, "draft-1", 10);

    expect(result[0].cardName).toBe("Lightning Bolt");
    expect(result[1].cardName).toBe("[REDACTED]");
  });
});

describe("getPicksWithCardDetails", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  // The query now uses json_extract to pull color_identity and mana_cost from
  // scryfall_json rather than fetching the full blob. Mock rows must use the
  // aliased column names: color_identity_json (serialized JSON array) and mana_cost.
  it("returns picks with slim json_extract fields", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Lightning Bolt",
        oracle_id: "abc-123",
        color_identity_json: JSON.stringify(["R"]),
        mana_cost: "{R}",
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1", new Set());

    expect(result).toEqual([{
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    }]);
    // Verify the query uses json_extract and the new aliases
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("json_extract"),
        args: ["draft-1"],
      })
    );
  });

  it("handles null color_identity_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        color_identity_json: null,
        mana_cost: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1", new Set());

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });

  it("handles invalid color_identity_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        color_identity_json: "not valid json",
        mana_cost: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1", new Set());

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });

  it("redacts card names and clears card details for opted-out seats", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          pick_n: 1,
          seat: 1,
          name: "Lightning Bolt",
          oracle_id: "abc-123",
          color_identity_json: JSON.stringify(["R"]),
          mana_cost: "{R}",
        },
        {
          pick_n: 2,
          seat: 2,
          name: "Dark Ritual",
          oracle_id: "def-456",
          color_identity_json: JSON.stringify(["B"]),
          mana_cost: "{B}",
        },
        {
          pick_n: 3,
          seat: 1,
          name: "Brainstorm",
          oracle_id: "ghi-789",
          color_identity_json: JSON.stringify(["U"]),
          mana_cost: "{U}",
        },
      ],
    });

    // Seat 2 is opted out
    const result = await getPicksWithCardDetails(client, "draft-1", new Set([2]));

    // Seat 1 picks are unaffected
    expect(result[0]).toEqual({
      pickN: 1,
      seat: 1,
      cardName: "Lightning Bolt",
      oracleId: "abc-123",
      colorIdentity: ["R"],
      manaCost: "{R}",
    });
    // Seat 2 pick is redacted
    expect(result[1]).toEqual({
      pickN: 2,
      seat: 2,
      cardName: "[REDACTED]",
      oracleId: "",
      colorIdentity: [],
      manaCost: "",
    });
    // Seat 1 second pick is unaffected
    expect(result[2]).toEqual({
      pickN: 3,
      seat: 1,
      cardName: "Brainstorm",
      oracleId: "ghi-789",
      colorIdentity: ["U"],
      manaCost: "{U}",
    });
  });

  it("fetches opt-outs from DB when not provided", async () => {
    // First call: opt-out query; second call: picks query
    client.execute
      .mockResolvedValueOnce({ rows: [{ draft_id: "draft-1", seat: 1 }] })
      .mockResolvedValueOnce({
        rows: [{
          pick_n: 1,
          seat: 1,
          name: "Lightning Bolt",
          oracle_id: "abc-123",
          color_identity_json: JSON.stringify(["R"]),
          mana_cost: "{R}",
        }],
      });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].cardName).toBe("[REDACTED]");
    expect(result[0].oracleId).toBe("");
    expect(result[0].colorIdentity).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getLiveStateSig
// ---------------------------------------------------------------------------

describe("getLiveStateSig", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns latestPickN and a composite sig from phase+matchCount+seatNames", async () => {
    // First execute: pick MAX query
    client.execute
      .mockResolvedValueOnce({ rows: [{ latest: 7 }] })
      // Second execute: meta query (phase, match_count, seat_names_csv)
      .mockResolvedValueOnce({
        rows: [{ phase: "drafting", match_count: 2, seat_names_csv: "Alice:Bob" }],
      });

    const result = await getLiveStateSig(client, "draft-1");

    expect(result.latestPickN).toBe(7);
    expect(result.sig).toBe("drafting|2|Alice:Bob");
  });

  it("returns pickN=0 and empty-ish sig when draft has no data", async () => {
    // When phase/seat_names are null but match_count is null → defaults to 0 per ?? 0
    client.execute
      .mockResolvedValueOnce({ rows: [{ latest: 0 }] })
      .mockResolvedValueOnce({
        rows: [{ phase: null, match_count: null, seat_names_csv: null }],
      });

    const result = await getLiveStateSig(client, "draft-1");

    expect(result.latestPickN).toBe(0);
    // phase defaults to "", match_count to 0, seatNamesCsv to "" → sig = "|0|"
    expect(result.sig).toBe("|0|");
  });

  it("uses different sigs for different phase, matchCount, and seatNames", async () => {
    const makeClient = () => {
      const c = createMockClient();
      return c;
    };

    const cases: Array<{
      pickN: number;
      phase: string;
      matchCount: number;
      seatNamesCsv: string;
      expectedSig: string;
    }> = [
      { pickN: 0, phase: "setup", matchCount: 0, seatNamesCsv: "", expectedSig: "setup|0|" },
      { pickN: 5, phase: "drafting", matchCount: 0, seatNamesCsv: "Alice:Bob", expectedSig: "drafting|0|Alice:Bob" },
      { pickN: 5, phase: "drafting", matchCount: 1, seatNamesCsv: "Alice:Bob", expectedSig: "drafting|1|Alice:Bob" },
      { pickN: 5, phase: "playing", matchCount: 1, seatNamesCsv: "Alice:Bob", expectedSig: "playing|1|Alice:Bob" },
    ];

    const sigs = new Set<string>();
    for (const c of cases) {
      const cl = makeClient();
      cl.execute
        .mockResolvedValueOnce({ rows: [{ latest: c.pickN }] })
        .mockResolvedValueOnce({
          rows: [{ phase: c.phase, match_count: c.matchCount, seat_names_csv: c.seatNamesCsv }],
        });
      const res = await getLiveStateSig(cl, "draft-1");
      expect(res.sig).toBe(c.expectedSig);
      sigs.add(res.sig);
    }
    // All four cases produce unique sigs
    expect(sigs.size).toBe(4);
  });
});
