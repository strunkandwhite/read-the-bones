import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getColorPairBreakdown } from "./colorPairBreakdown";

// Mock inferDeckColor for isolation
vi.mock("../../../inferDeckColor", () => ({
  inferDeckColor: vi.fn(),
}));

function createMockClient() {
  return {
    execute: vi.fn(),
  } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

describe("getColorPairBreakdown", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
  });

  it("returns top color pairs sorted by frequency", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");

    // 4 decks maindecked the target card.
    // The query returns all maindecked cards for those decks with scryfall_json.
    client.execute.mockResolvedValueOnce({
      rows: [
        // Deck d1:1 — two cards with red and white
        { draft_id: "d1", seat: 1, scryfall_json: '{"color_identity":["R"]}' },
        { draft_id: "d1", seat: 1, scryfall_json: '{"color_identity":["W"]}' },
        // Deck d1:2 — two cards with red and white
        { draft_id: "d1", seat: 2, scryfall_json: '{"color_identity":["R"]}' },
        { draft_id: "d1", seat: 2, scryfall_json: '{"color_identity":["W"]}' },
        // Deck d2:1 — two cards with red and black
        { draft_id: "d2", seat: 1, scryfall_json: '{"color_identity":["R"]}' },
        { draft_id: "d2", seat: 1, scryfall_json: '{"color_identity":["B"]}' },
        // Deck d2:3 — two cards with blue and red
        { draft_id: "d2", seat: 3, scryfall_json: '{"color_identity":["U"]}' },
        { draft_id: "d2", seat: 3, scryfall_json: '{"color_identity":["R"]}' },
      ],
    });

    // Mock inferDeckColor for each unique deck
    (inferDeckColor as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("RW") // d1:1
      .mockReturnValueOnce("RW") // d1:2
      .mockReturnValueOnce("BR") // d2:1
      .mockReturnValueOnce("UR"); // d2:3

    const result = await getColorPairBreakdown(client, "Lightning Bolt");
    expect(result).toEqual([
      { colorPair: "RW", percentage: 50, deckCount: 2 },
      { colorPair: "BR", percentage: 25, deckCount: 1 },
      { colorPair: "UR", percentage: 25, deckCount: 1 },
    ]);
  });

  it("includes all pairs regardless of percentage", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");

    // 10 decks total. Generate rows — one per deck for simplicity.
    client.execute.mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, (_, i) => ({
        draft_id: `d${i}`,
        seat: 1,
        scryfall_json: '{"color_identity":["R"]}',
      })),
    });

    // 9 are RW, 1 is RG
    (inferDeckColor as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RG");

    const result = await getColorPairBreakdown(client, "Some Card");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ colorPair: "RW", percentage: 90, deckCount: 9 });
    expect(result[1]).toEqual({ colorPair: "RG", percentage: 10, deckCount: 1 });
  });

  it("returns empty array when card has never been maindecked", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });
    const result = await getColorPairBreakdown(client, "Unplayed Card");
    expect(result).toEqual([]);
  });

  it("caps at 4 results", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");

    // 10 decks, one row each
    client.execute.mockResolvedValueOnce({
      rows: Array.from({ length: 10 }, (_, i) => ({
        draft_id: `d${i}`,
        seat: 1,
        scryfall_json: '{"color_identity":["R"]}',
      })),
    });

    // 5 different color pairs, each at 20%
    (inferDeckColor as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("RW")
      .mockReturnValueOnce("BR")
      .mockReturnValueOnce("BR")
      .mockReturnValueOnce("UR")
      .mockReturnValueOnce("UR")
      .mockReturnValueOnce("RG")
      .mockReturnValueOnce("RG")
      .mockReturnValueOnce("BG")
      .mockReturnValueOnce("BG");

    const result = await getColorPairBreakdown(client, "Popular Card");
    expect(result).toHaveLength(4);
  });

  it("handles cards with no color identity (colorless)", async () => {
    const { inferDeckColor } = await import("../../../inferDeckColor");

    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "d1", seat: 1, scryfall_json: '{"color_identity":[]}' },
        { draft_id: "d1", seat: 1, scryfall_json: null },
      ],
    });

    (inferDeckColor as ReturnType<typeof vi.fn>).mockReturnValueOnce("C");

    const result = await getColorPairBreakdown(client, "Sol Ring");
    expect(result).toEqual([{ colorPair: "C", percentage: 100, deckCount: 1 }]);
  });

  it("accepts optional draftId filter", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    await getColorPairBreakdown(client, "Lightning Bolt", "draft-1");

    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("dc.draft_id = ?");
    expect(call.args).toContain("draft-1");
  });
});
