import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

import { getSearchableCards } from "./search";

const mockExecute = vi.fn();
const mockClient = { execute: mockExecute } as unknown as Client;

describe("getSearchableCards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns all cards with scryfall_json for global search", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          name: "Lightning Bolt",
          scryfall_json:
            '{"name":"Lightning Bolt","colors":["R"],"type_line":"Instant","oracle_text":"Deal 3 damage.","mana_cost":"{R}","cmc":1,"color_identity":["R"]}',
        },
        {
          name: "Counterspell",
          scryfall_json:
            '{"name":"Counterspell","colors":["U"],"type_line":"Instant","oracle_text":"Counter target spell.","mana_cost":"{U}{U}","cmc":2,"color_identity":["U"]}',
        },
      ],
    });

    const result = await getSearchableCards(mockClient, {});
    expect(result).toHaveLength(2);
    expect(result![0].name).toBe("Lightning Bolt");
    expect(result![0].scryfall_json).toContain("Lightning Bolt");
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0].sql).toContain("FROM cards");
    expect(mockExecute.mock.calls[0][0].sql).not.toContain("cube_snapshot_cards");
  });

  it("scopes to draft cube when draftId provided", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 }],
    });

    const result = await getSearchableCards(mockClient, { draftId: "tarkir" });
    expect(result).toHaveLength(1);
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[0][0].args).toEqual(["tarkir"]);
    expect(mockExecute.mock.calls[1][0].sql).toContain("cube_snapshot_cards");
  });

  it("returns null when draft not found", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await getSearchableCards(mockClient, { draftId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("subtracts picked cards when availableOnly is set", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 2 },
        { card_id: 2, name: "Counterspell", scryfall_json: '{"name":"Counterspell"}', qty: 1 },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 2, pick_count: 1 }],
    });

    const result = await getSearchableCards(mockClient, {
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Lightning Bolt");
    expect(result![0].remaining_qty).toBe(2);
    expect(mockExecute).toHaveBeenCalledTimes(3);
  });

  it("excludes banned cards when availableOnly is set", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: '["Lightning Bolt"]' }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 },
        { card_id: 2, name: "Counterspell", scryfall_json: '{"name":"Counterspell"}', qty: 1 },
      ],
    });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await getSearchableCards(mockClient, {
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("Counterspell");
  });

  it("excludes cards with zero remaining qty", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ cube_snapshot_id: 42, banned_cards: null }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 1, name: "Lightning Bolt", scryfall_json: '{"name":"Lightning Bolt"}', qty: 1 },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 1, pick_count: 1 }],
    });

    const result = await getSearchableCards(mockClient, {
      draftId: "tarkir",
      availableOnly: true,
      beforePickN: 50,
    });

    expect(result).toHaveLength(0);
  });
});
