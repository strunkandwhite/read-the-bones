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

    const result = await getRecentPicks(client, "draft-1", 10);

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

    const result = await getRecentPicks(client, "draft-1", 5);

    expect(result).toEqual([]);
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

    const result = await getPicksWithCardDetails(client, "draft-1");

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

    const result = await getPicksWithCardDetails(client, "draft-1");

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

    const result = await getPicksWithCardDetails(client, "draft-1");

    expect(result[0].colorIdentity).toEqual([]);
    expect(result[0].manaCost).toBe("");
  });
});
