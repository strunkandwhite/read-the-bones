import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getLatestPickNumber,
  getRecentPicks,
  getPicksWithCardDetails,
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

  it("returns picks with parsed scryfall data", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Lightning Bolt",
        oracle_id: "abc-123",
        scryfall_json: JSON.stringify({ color_identity: ["R"], mana_cost: "{R}" }),
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
  });

  it("handles null scryfall_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        scryfall_json: null,
      }],
    });

    const result = await getPicksWithCardDetails(client, "draft-1", new Set());

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });

  it("handles invalid scryfall_json gracefully", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{
        pick_n: 1,
        seat: 1,
        name: "Mystery Card",
        oracle_id: "xyz",
        scryfall_json: "not valid json",
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
          scryfall_json: JSON.stringify({ color_identity: ["R"], mana_cost: "{R}" }),
        },
        {
          pick_n: 2,
          seat: 2,
          name: "Dark Ritual",
          oracle_id: "def-456",
          scryfall_json: JSON.stringify({ color_identity: ["B"], mana_cost: "{B}" }),
        },
        {
          pick_n: 3,
          seat: 1,
          name: "Brainstorm",
          oracle_id: "ghi-789",
          scryfall_json: JSON.stringify({ color_identity: ["U"], mana_cost: "{U}" }),
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
          scryfall_json: JSON.stringify({ color_identity: ["R"], mana_cost: "{R}" }),
        }],
      });

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].cardName).toBe("[REDACTED]");
    expect(result[0].oracleId).toBe("");
    expect(result[0].colorIdentity).toEqual([]);
  });
});
