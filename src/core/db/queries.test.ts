/**
 * Tests for database query functions.
 *
 * Uses vitest mocking to mock the database client and test
 * query logic without requiring a real database connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the client module before importing queries
vi.mock("./client", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "./client";
import {
  resolveCard,
  resolveCardFuzzy,
  lookupCard,
  listDrafts,
  getDraft,
  getPicks,
  getAvailableCards,
  getStandings,
  getCardPickStats,
  getDraftPool,
  rankAvailableCards,
} from "./queries";

// Get the mocked getClient function
const mockGetClient = vi.mocked(getClient);

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a mock database client with execute function.
 */
function createMockClient() {
  return {
    execute: vi.fn(),
  };
}

/**
 * Create a mock query result with rows.
 */
function createQueryResult(rows: Record<string, unknown>[]) {
  return { rows };
}

// ============================================================================
// resolveCard Tests
// ============================================================================

describe("resolveCard", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return card when found", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc-123",
          name: "Lightning Bolt",
          scryfall_json: '{"name": "Lightning Bolt"}',
        },
      ])
    );

    const result = await resolveCard("Lightning Bolt");

    expect(result).toEqual({
      card_id: 1,
      oracle_id: "abc-123",
      name: "Lightning Bolt",
      scryfall_json: '{"name": "Lightning Bolt"}',
    });
  });

  it("should return null when card not found", async () => {
    // resolveCard delegates to resolveCardFuzzy, which tries all 5 tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    const result = await resolveCard("Nonexistent Card");

    expect(result).toBeNull();
  });

  it("should perform case-insensitive search", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Lightning Bolt",
          scryfall_json: null,
        },
      ])
    );

    await resolveCard("LIGHTNING BOLT");

    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("LOWER(name) = LOWER(?)"),
      args: ["LIGHTNING BOLT"],
    });
  });

  it("should handle null scryfall_json", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Test Card",
          scryfall_json: null,
        },
      ])
    );

    const result = await resolveCard("Test Card");

    expect(result?.scryfall_json).toBeNull();
  });
});

// ============================================================================
// resolveCardFuzzy Tests
// ============================================================================

describe("resolveCardFuzzy", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return exact match", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc-123",
          name: "Lightning Bolt",
          scryfall_json: '{"name": "Lightning Bolt"}',
        },
      ])
    );

    const result = await resolveCardFuzzy("Lightning Bolt");

    expect(result.match).not.toBeNull();
    expect(result.match!.match_type).toBe("exact");
    expect(result.match!.card.name).toBe("Lightning Bolt");
    expect(result.candidates).toBeNull();
  });

  it("should return front-face DFC match when exact fails", async () => {
    // Exact: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Front-face: single match
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 2,
          oracle_id: "def-456",
          name: "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki",
          scryfall_json: null,
        },
      ])
    );

    const result = await resolveCardFuzzy("Fable of the Mirror-Breaker");

    expect(result.match).not.toBeNull();
    expect(result.match!.match_type).toBe("front_face");
    expect(result.match!.card.name).toBe("Fable of the Mirror-Breaker // Reflection of Kiki-Jiki");
    expect(result.candidates).toBeNull();
  });

  it("should return back-face DFC match when exact and front-face fail", async () => {
    // Exact: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Front-face: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Back-face: single match
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 3,
          oracle_id: "ghi-789",
          name: "Delver of Secrets // Insectile Aberration",
          scryfall_json: null,
        },
      ])
    );

    const result = await resolveCardFuzzy("Insectile Aberration");

    expect(result.match).not.toBeNull();
    expect(result.match!.match_type).toBe("back_face");
    expect(result.match!.card.name).toBe("Delver of Secrets // Insectile Aberration");
    expect(result.candidates).toBeNull();
  });

  it("should return candidates when front-face is ambiguous", async () => {
    // Exact: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Front-face: multiple matches
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 10,
          oracle_id: "aaa",
          name: "Fire // Ice",
          scryfall_json: null,
        },
        {
          card_id: 11,
          oracle_id: "bbb",
          name: "Fire // Lightning",
          scryfall_json: null,
        },
      ])
    );

    const result = await resolveCardFuzzy("Fire");

    expect(result.match).toBeNull();
    expect(result.candidates).toEqual(["Fire // Ice", "Fire // Lightning"]);
  });

  it("should return prefix match when earlier tiers fail", async () => {
    // Exact: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Front-face: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Back-face: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Prefix: single match
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 5,
          oracle_id: "jkl-012",
          name: "Lightning Helix",
          scryfall_json: null,
        },
      ])
    );

    const result = await resolveCardFuzzy("Lightning Hel");

    expect(result.match).not.toBeNull();
    expect(result.match!.match_type).toBe("prefix");
    expect(result.match!.card.name).toBe("Lightning Helix");
    expect(result.candidates).toBeNull();
  });

  it("should return null match and null candidates when nothing found", async () => {
    // Exact: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Front-face: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Back-face: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Prefix: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Substring: no match
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await resolveCardFuzzy("Totally Nonexistent Card");

    expect(result.match).toBeNull();
    expect(result.candidates).toBeNull();
  });
});

// ============================================================================
// lookupCard Tests
// ============================================================================

describe("lookupCard", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
    // Save original fetch
    originalFetch = global.fetch;
  });

  afterEach(() => {
    // Restore original fetch
    global.fetch = originalFetch;
  });

  it("should return parsed card data from database", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Lightning Bolt",
          scryfall_json: JSON.stringify({
            oracle_text: "Lightning Bolt deals 3 damage to any target.",
            type_line: "Instant",
            mana_cost: "{R}",
            color_identity: ["R"],
          }),
        },
      ])
    );

    const result = await lookupCard("Lightning Bolt");

    expect(result).toEqual({
      name: "Lightning Bolt",
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      type_line: "Instant",
      mana_cost: "{R}",
      color_identity: ["R"],
    });
  });

  it("should fallback to Scryfall API when card not in database", async () => {
    // Database returns empty for all fuzzy tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    // Mock Scryfall API response
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: "Force of Will",
        oracle_text:
          "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
        type_line: "Instant",
        mana_cost: "{3}{U}{U}",
        color_identity: ["U"],
      }),
    });

    const result = await lookupCard("Force of Will");

    expect(result).toEqual({
      name: "Force of Will",
      oracle_text:
        "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
      type_line: "Instant",
      mana_cost: "{3}{U}{U}",
      color_identity: ["U"],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Force%20of%20Will"
    );
  });

  it("should return null when card not found in database or API", async () => {
    // Database returns empty for all fuzzy tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    // Mock Scryfall API 404 response
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await lookupCard("Totally Fake Card");

    expect(result).toBeNull();
  });

  it("should handle Scryfall API network error gracefully", async () => {
    // Database returns empty for all fuzzy tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    // Mock network error
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("Network error"));

    const result = await lookupCard("Some Card");

    expect(result).toBeNull();
  });

  it("should handle double-faced cards from Scryfall API", async () => {
    // Database returns empty for all fuzzy tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    // Mock Scryfall API response for a double-faced card (matches real API shape:
    // top-level type_line present, oracle_text/mana_cost only on card_faces)
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: "Delver of Secrets // Insectile Aberration",
        type_line: "Creature — Human Wizard // Creature — Human Insect",
        color_identity: ["U"],
        card_faces: [
          {
            name: "Delver of Secrets",
            mana_cost: "{U}",
            type_line: "Creature — Human Wizard",
            oracle_text:
              "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.",
          },
          {
            name: "Insectile Aberration",
            mana_cost: "",
            type_line: "Creature — Human Insect",
            oracle_text: "Flying",
          },
        ],
      }),
    });

    const result = await lookupCard("Delver of Secrets");

    // transformApiResponse concatenates face oracle text with \n\n (no labels)
    // and uses the front face mana_cost for DFCs
    expect(result).toEqual({
      name: "Delver of Secrets // Insectile Aberration",
      oracle_text:
        "At the beginning of your upkeep, look at the top card of your library. You may reveal that card. If an instant or sorcery card is revealed this way, transform Delver of Secrets.\n\nFlying",
      type_line: "Creature — Human Wizard // Creature — Human Insect",
      mana_cost: "{U}",
      color_identity: ["U"],
    });
  });

  it("should not call Scryfall API when card is found in database", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Lightning Bolt",
          scryfall_json: JSON.stringify({
            oracle_text: "Lightning Bolt deals 3 damage to any target.",
            type_line: "Instant",
            mana_cost: "{R}",
            color_identity: ["R"],
          }),
        },
      ])
    );

    global.fetch = vi.fn();

    await lookupCard("Lightning Bolt");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("should handle null scryfall_json", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Test Card",
          scryfall_json: null,
        },
      ])
    );

    const result = await lookupCard("Test Card");

    expect(result).toEqual({
      name: "Test Card",
      oracle_text: null,
      type_line: null,
      mana_cost: null,
      color_identity: [],
    });
  });

  it("should handle invalid JSON in scryfall_json", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Test Card",
          scryfall_json: "invalid json",
        },
      ])
    );

    const result = await lookupCard("Test Card");

    expect(result).toEqual({
      name: "Test Card",
      oracle_text: null,
      type_line: null,
      mana_cost: null,
      color_identity: [],
    });
  });

  it("should handle partial scryfall data", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          oracle_id: "abc",
          name: "Test Card",
          scryfall_json: JSON.stringify({
            oracle_text: "Some text",
            // Missing other fields
          }),
        },
      ])
    );

    const result = await lookupCard("Test Card");

    expect(result).toEqual({
      name: "Test Card",
      oracle_text: "Some text",
      type_line: null,
      mana_cost: null,
      color_identity: [],
    });
  });
});

// ============================================================================
// listDrafts Tests
// ============================================================================

describe("listDrafts", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return all drafts when no filters", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", draft_name: "Draft 1", draft_date: "2025-01-01" },
        { draft_id: "draft2", draft_name: "Draft 2", draft_date: "2025-01-02" },
      ])
    );

    const result = await listDrafts();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      draft_id: "draft1",
      draft_name: "Draft 1",
      draft_date: "2025-01-01",
    });
  });

  it("should filter by date range", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts({ date_from: "2025-01-01", date_to: "2025-12-31" });

    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("d.draft_date >= ?"),
      args: expect.arrayContaining(["2025-01-01", "2025-12-31"]),
    });
  });

  it("should filter by draft_name (partial match)", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts({ draft_name: "Vintage" });

    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("LOWER(d.draft_name) LIKE LOWER(?)"),
      args: ["%Vintage%"],
    });
  });

  it("should combine multiple filters", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts({
      date_from: "2025-01-01",
      draft_name: "Cube",
    });

    // The SQL should contain both filter conditions joined by AND
    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("d.draft_date >= ?"),
      args: expect.arrayContaining(["2025-01-01", "%Cube%"]),
    });
    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("LOWER(d.draft_name) LIKE LOWER(?)"),
      args: expect.any(Array),
    });
  });

  it("should return empty array when no drafts found", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await listDrafts();

    expect(result).toEqual([]);
  });
});

// ============================================================================
// getDraft Tests
// ============================================================================

describe("getDraft", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return draft with num_seats", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", draft_name: "Vintage Cube", draft_date: "2025-01-15", num_seats: 8, banned_cards: '["Lightning Bolt"]' },
      ])
    );

    const result = await getDraft("draft1");

    expect(result).toEqual({
      draft_id: "draft1",
      draft_name: "Vintage Cube",
      draft_date: "2025-01-15",
      num_seats: 8,
      banned_cards: ["Lightning Bolt"],
    });
  });

  it("should return null when draft not found", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getDraft("nonexistent");

    expect(result).toBeNull();
  });
});

// ============================================================================
// getPicks Tests
// ============================================================================

describe("getPicks", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return picks for a draft", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
      ])
    );

    const result = await getPicks({ draft_id: "draft1" });

    expect(result).toEqual({
      draft_id: "draft1",
      total: 2,
      picks: [
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
      ],
    });
  });

  it("should filter by seat", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getPicks({ draft_id: "draft1", seat: 1 });

    expect(mockClient.execute).toHaveBeenLastCalledWith({
      sql: expect.stringContaining("pe.seat = ?"),
      args: ["draft1", 1],
    });
  });

  it("should filter by pick range", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getPicks({ draft_id: "draft1", pick_n_min: 10, pick_n_max: 20 });

    expect(mockClient.execute).toHaveBeenLastCalledWith({
      sql: expect.stringMatching(/pe\.pick_n >= \?.*pe\.pick_n <= \?/),
      args: ["draft1", 10, 20],
    });
  });

  it("should filter by card_name (partial match)", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getPicks({ draft_id: "draft1", card_name: "Bolt" });

    expect(mockClient.execute).toHaveBeenLastCalledWith({
      sql: expect.stringContaining("LOWER(c.name) LIKE LOWER(?)"),
      args: ["draft1", "%Bolt%"],
    });
  });

  it("should return empty picks when none found", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getPicks({ draft_id: "draft1" });

    expect(result.picks).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("should redact seats for opted-out players", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ seat: 2 }]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
      ])
    );

    const result = await getPicks({ draft_id: "draft1" });

    expect(result.redacted_seats).toEqual([2]);
    expect(result.picks[0].seat).toBe(1);
    expect(result.picks[1].seat).toBe("[REDACTED]");
  });

  it("should return empty when querying opted-out seat directly", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ seat: 2 }]));

    const result = await getPicks({ draft_id: "draft1", seat: 2 });

    expect(result.total).toBe(0);
    expect(result.redacted_seats).toEqual([2]);
    expect(result.picks).toEqual([]);
  });
});

// ============================================================================
// getAvailableCards Tests
// ============================================================================

describe("getAvailableCards", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return available cards before a pick", async () => {
    // Draft lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    // Cube cards
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", scryfall_json: null, qty: 1 },
        { card_id: 2, name: "Counterspell", scryfall_json: null, qty: 1 },
        { card_id: 3, name: "Dark Ritual", scryfall_json: null, qty: 1 },
      ])
    );
    // Picked cards
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, pick_count: 1 }])
    );

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.draft_id).toBe("draft1");
    expect(result.before_pick_n).toBe(5);
    expect(result.cards).toHaveLength(2);
    expect(result.cards.map((c) => c.card_name).sort()).toEqual([
      "Counterspell",
      "Dark Ritual",
    ]);
  });

  it("should return empty when draft not found", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards({
      draft_id: "nonexistent",
      before_pick_n: 1,
    });

    expect(result.cards).toEqual([]);
  });

  it("should filter by color identity", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          name: "Lightning Bolt",
          scryfall_json: JSON.stringify({ color_identity: ["R"] }),
          qty: 1,
        },
        {
          card_id: 2,
          name: "Counterspell",
          scryfall_json: JSON.stringify({ color_identity: ["U"] }),
          qty: 1,
        },
        {
          card_id: 3,
          name: "Sol Ring",
          scryfall_json: JSON.stringify({ color_identity: [] }),
          qty: 1,
        },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      color: "R",
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Lightning Bolt");
  });

  it("should filter colorless cards with C", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          name: "Lightning Bolt",
          scryfall_json: JSON.stringify({ color_identity: ["R"] }),
          qty: 1,
        },
        {
          card_id: 2,
          name: "Sol Ring",
          scryfall_json: JSON.stringify({ color_identity: [] }),
          qty: 1,
        },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      color: "C",
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Sol Ring");
  });

  it("should filter by type_contains", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          card_id: 1,
          name: "Lightning Bolt",
          scryfall_json: JSON.stringify({ type_line: "Instant" }),
          qty: 1,
        },
        {
          card_id: 2,
          name: "Tarmogoyf",
          scryfall_json: JSON.stringify({ type_line: "Creature - Lhurgoyf" }),
          qty: 1,
        },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      type_contains: "Creature",
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Tarmogoyf");
  });

  it("should handle multiple quantities", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", scryfall_json: null, qty: 3 },
      ])
    );
    // One copy already picked
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, pick_count: 1 }])
    );

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].remaining_qty).toBe(2);
  });

  it("should exclude cards with no remaining copies", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", scryfall_json: null, qty: 1 },
      ])
    );
    // Already picked
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, pick_count: 1 }])
    );

    const result = await getAvailableCards({
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.cards).toHaveLength(0);
  });
});

// ============================================================================
// getStandings Tests
// ============================================================================

describe("getStandings", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should compute standings from match results", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
        { seat1: 1, seat2: 3, seat1_wins: 2, seat2_wins: 0 },
        { seat1: 2, seat2: 3, seat1_wins: 1, seat2_wins: 2 },
      ])
    );

    const result = await getStandings("draft1");

    // Seat 1: 2 match wins, 0 losses, 4 game wins, 1 game loss
    // Seat 3: 1 match win, 1 loss, 2 game wins, 3 game losses
    // Seat 2: 0 match wins, 2 losses, 2 game wins, 4 game losses
    expect(result.standings).toHaveLength(3);
    expect(result.standings[0].seat).toBe(1);
    expect(result.standings[0].matchWins).toBe(2);
    expect(result.standings[0].matchLosses).toBe(0);
    expect(result.standings[0].gameWins).toBe(4);
    expect(result.standings[0].gameLosses).toBe(1);
  });

  it("should handle draws (equal game wins)", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { seat1: 1, seat2: 2, seat1_wins: 1, seat2_wins: 1 },
      ])
    );

    const result = await getStandings("draft1");

    // Draw - neither seat gets a match win or loss
    expect(result.standings).toHaveLength(2);
    const seat1 = result.standings.find((s) => s.seat === 1);
    const seat2 = result.standings.find((s) => s.seat === 2);

    expect(seat1?.matchWins).toBe(0);
    expect(seat1?.matchLosses).toBe(0);
    expect(seat2?.matchWins).toBe(0);
    expect(seat2?.matchLosses).toBe(0);
  });

  it("should return empty array when no matches", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events (empty)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getStandings("draft1");

    expect(result.standings).toEqual([]);
  });

  it("should sort by match wins then game win rate", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        // Seat 1: 1-0, 2-1 games (66% game winrate)
        { seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
        // Seat 3: 1-0, 2-0 games (100% game winrate)
        { seat1: 3, seat2: 4, seat1_wins: 2, seat2_wins: 0 },
      ])
    );

    const result = await getStandings("draft1");

    // Both have 1 match win, but seat 3 has better game winrate
    expect(result.standings[0].seat).toBe(3);
    expect(result.standings[1].seat).toBe(1);
  });

  it("should redact opted-out seats in standings", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ seat: 2 }]));
    // Mock match events
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
      ])
    );

    const result = await getStandings("draft1");

    expect(result.redacted_seats).toEqual([2]);
    expect(result.standings).toHaveLength(2);
    // Seat 1 wins, so it's first
    expect(result.standings[0].seat).toBe(1);
    expect(result.standings[1].seat).toBe("[REDACTED]");
  });
});

// ============================================================================
// getCardPickStats Tests
// ============================================================================

describe("getCardPickStats", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return null when card not found", async () => {
    // resolveCard delegates to resolveCardFuzzy, which tries all 5 tiers
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // exact
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // front-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // back-face
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // prefix
    mockClient.execute.mockResolvedValueOnce(createQueryResult([])); // substring

    const result = await getCardPickStats({ card_name: "Nonexistent" });

    expect(result).toBeNull();
  });

  it("should return zero stats when card exists but not in any draft", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats({ card_name: "Test Card" });

    expect(result).toEqual({
      card_name: "Test Card",
      drafts_seen: 0,
      times_picked: 0,
      avg_pick_n: 0,
      median_pick_n: 0,
      weighted_geomean: 0,
    });
  });

  it("should compute basic stats for a card picked in one draft", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Lightning Bolt", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ draft_id: "draft1", cube_snapshot_id: 1 }])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks of this card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ draft_id: "draft1", pick_n: 5, seat: 1 }])
    );
    // Opt-outs (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Deck cards (no decklist data)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats({ card_name: "Lightning Bolt" });

    expect(result?.drafts_seen).toBe(1);
    expect(result?.times_picked).toBe(1);
    expect(result?.avg_pick_n).toBe(5);
    expect(result?.median_pick_n).toBe(5);
    expect(result?.weighted_geomean).toBe(5);
    expect(result?.play_rate).toBeUndefined();
  });

  it("should compute median correctly for multiple picks", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", cube_snapshot_id: 1 },
        { draft_id: "draft2", cube_snapshot_id: 1 },
        { draft_id: "draft3", cube_snapshot_id: 1 },
      ])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks - positions 5, 10, 20
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", pick_n: 5, seat: 1 },
        { draft_id: "draft2", pick_n: 20, seat: 2 },
        { draft_id: "draft3", pick_n: 10, seat: 3 },
      ])
    );
    // Opt-outs (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Deck cards (no decklist data)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats({ card_name: "Test Card" });

    expect(result?.times_picked).toBe(3);
    expect(result?.median_pick_n).toBe(10); // Middle value of [5, 10, 20]
  });

  it("should include play rate when decklist data exists", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", cube_snapshot_id: 1 },
        { draft_id: "draft2", cube_snapshot_id: 1 },
      ])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", pick_n: 5, seat: 1 },
        { draft_id: "draft2", pick_n: 10, seat: 2 },
      ])
    );
    // Opt-outs (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Deck cards: maindecked in draft1, sideboarded in draft2
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat: 1, zone: "deck" },
        { draft_id: "draft2", seat: 2, zone: "sideboard" },
      ])
    );

    const result = await getCardPickStats({ card_name: "Test Card" });

    expect(result?.times_in_pool_with_decklist).toBe(2);
    expect(result?.times_maindecked).toBe(1);
    expect(result?.play_rate).toBe(0.5);
  });

  it("should exclude opted-out seats from pick stats and play rate", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", cube_snapshot_id: 1 },
      ])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks: seat 1 picked at 5, seat 2 (opted out) picked at 50
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", pick_n: 5, seat: 1 },
        { draft_id: "draft1", pick_n: 50, seat: 2 },
      ])
    );
    // Opt-outs: seat 2 in draft1 is opted out
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ draft_id: "draft1", seat: 2 }])
    );
    // Deck cards: seat 1 maindecked, seat 2 (opted out) maindecked
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat: 1, zone: "deck" },
        { draft_id: "draft1", seat: 2, zone: "deck" },
      ])
    );

    const result = await getCardPickStats({ card_name: "Test Card" });

    // Only seat 1's pick should count
    expect(result?.times_picked).toBe(1);
    expect(result?.avg_pick_n).toBe(5);
    // Only seat 1's decklist should count
    expect(result?.times_in_pool_with_decklist).toBe(1);
    expect(result?.times_maindecked).toBe(1);
    expect(result?.play_rate).toBe(1);
  });

  it("should apply date filters", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test", scryfall_json: null }])
    );
    // Should verify the date filter is in the query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getCardPickStats({
      card_name: "Test",
      date_from: "2025-01-01",
      date_to: "2025-12-31",
    });

    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("d.draft_date >= ?"),
        args: expect.arrayContaining([1, "2025-01-01", "2025-12-31"]),
      })
    );
  });

  it("should apply draft name filter", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test", scryfall_json: null }])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getCardPickStats({
      card_name: "Test",
      draft_name: "Vintage",
    });

    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("LOWER(d.draft_name) LIKE LOWER(?)"),
        args: expect.arrayContaining(["%Vintage%"]),
      })
    );
  });
});

// ============================================================================
// getDraftPool Tests
// ============================================================================

describe("getDraftPool", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  it("should return draft pool with cards", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock pool query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Lightning Bolt",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: 1,
          drafted_pick_n: 5,
        },
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Counterspell",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: null,
          drafted_pick_n: null,
        },
      ])
    );

    const result = await getDraftPool({ draft_id: "draft1" });

    expect(result).not.toBeNull();
    expect(result!.draft_id).toBe("draft1");
    expect(result!.draft_name).toBe("Vintage Cube");
    expect(result!.total_cards).toBe(2);
    expect(result!.cards).toHaveLength(2);
    expect(result!.cards![0].card_name).toBe("Lightning Bolt");
    expect(result!.cards![1].card_name).toBe("Counterspell");
  });

  it("should return null when draft not found", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock pool query (empty)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock draft existence check
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getDraftPool({ draft_id: "nonexistent" });

    expect(result).toBeNull();
  });

  it("should redact opted-out seats when include_draft_results is true", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ seat: 2 }]));
    // Mock pool query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Lightning Bolt",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: 1,
          drafted_pick_n: 5,
        },
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Counterspell",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: 2,
          drafted_pick_n: 10,
        },
      ])
    );

    const result = await getDraftPool({
      draft_id: "draft1",
      include_draft_results: true,
    });

    expect(result).not.toBeNull();
    expect(result!.redacted_seats).toEqual([2]);
    expect(result!.cards![0].drafted_by_seat).toBe(1);
    expect(result!.cards![1].drafted_by_seat).toBe("[REDACTED]");
    // pick_n should still be visible
    expect(result!.cards![1].drafted_pick_n).toBe(10);
  });

  it("should not include redacted_seats when no opt-outs", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock pool query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Lightning Bolt",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: 1,
          drafted_pick_n: 5,
        },
      ])
    );

    const result = await getDraftPool({
      draft_id: "draft1",
      include_draft_results: true,
    });

    expect(result).not.toBeNull();
    expect(result!.redacted_seats).toBeUndefined();
    expect(result!.cards![0].drafted_by_seat).toBe(1);
  });

  it("should not expose seat info when include_draft_results is false", async () => {
    // Mock opt-outs query (seat 1 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ seat: 1 }]));
    // Mock pool query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          draft_id: "draft1",
          draft_name: "Vintage Cube",
          draft_date: "2025-01-15",
          card_name: "Lightning Bolt",
          quantity: 1,
          scryfall_json: null,
          drafted_by_seat: 1,
          drafted_pick_n: 5,
        },
      ])
    );

    const result = await getDraftPool({
      draft_id: "draft1",
      include_draft_results: false,
    });

    expect(result).not.toBeNull();
    // When include_draft_results is false, seat info is null regardless of opt-out
    expect(result!.cards![0].drafted_by_seat).toBeNull();
    expect(result!.cards![0].drafted_pick_n).toBeNull();
    // redacted_seats is still tracked to inform that opted-out players exist
    expect(result!.redacted_seats).toEqual([1]);
  });
});

// ============================================================================
// rankAvailableCards Tests
// ============================================================================

describe("rankAvailableCards", () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
  });

  /**
   * Helper to set up the 3 mocks for getAvailableCards (draft lookup, cube cards, picks).
   * Returns the card names that will be "available" for the rest of the pipeline.
   */
  function mockGetAvailableCards(
    cubeCards: { card_id: number; name: string; qty: number }[],
    pickedCardIds: { card_id: number; pick_count: number }[] = []
  ) {
    // 1. Draft lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 100 }])
    );
    // 2. Cube cards
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(
        cubeCards.map((c) => ({
          card_id: c.card_id,
          name: c.name,
          scryfall_json: null,
          qty: c.qty,
        }))
      )
    );
    // 3. Picks before N
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(pickedCardIds)
    );
  }

  /**
   * Helper to set up batch resolution + stats mocks (steps 2-5)
   * for cards that pass through getAvailableCards.
   */
  function mockBatchStats(opts: {
    cards: { card_id: number; name: string }[];
    draftsWithCard?: { draft_id: string; cube_snapshot_id: number; card_id: number }[];
    picksOfCard?: { card_id: number; draft_id: string; pick_n: number }[];
    cubeSizes?: { cube_snapshot_id: number; total_cards: number }[];
    playStats?: { card_id: number; draft_id: string; seat: number; zone: string }[];
    winStats?: { card_id: number; draft_id: string; seat: number; game_wins: number; game_losses: number }[];
    optOuts?: { draft_id: string; seat: number }[];
  }) {
    // 4. Batch card ID resolution
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.cards)
    );
    // 5. Drafts with card (parallel query 1)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.draftsWithCard ?? [])
    );
    // 6. Picks of card (parallel query 2)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.picksOfCard ?? [])
    );
    // 7. Cube sizes (parallel query 3)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.cubeSizes ?? [])
    );
    // 8. Play stats (parallel query 4)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.playStats ?? [])
    );
    // 9. Win stats (parallel query 5)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.winStats ?? [])
    );
    // 10. Opt-outs query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(opts.optOuts ?? [])
    );
  }

  it("should return empty result when no cards are available", async () => {
    // getAvailableCards: draft found but cube has no cards
    mockGetAvailableCards([], []);

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.draft_id).toBe("draft1");
    expect(result.before_pick_n).toBe(5);
    expect(result.total_available).toBe(0);
    expect(result.cards).toEqual([]);
  });

  it("should rank cards by geomean_pick (lower first) by default", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Lightning Bolt", qty: 1 },
      { card_id: 2, name: "Counterspell", qty: 1 },
    ]);

    mockBatchStats({
      cards: [
        { card_id: 1, name: "Lightning Bolt" },
        { card_id: 2, name: "Counterspell" },
      ],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 2 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 3 },
        { card_id: 2, draft_id: "d1", pick_n: 20 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
    });

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
    });

    expect(result.total_available).toBe(2);
    expect(result.cards).toHaveLength(2);
    // Lightning Bolt picked at 3 should rank before Counterspell picked at 20
    expect(result.cards[0].card_name).toBe("Lightning Bolt");
    expect(result.cards[1].card_name).toBe("Counterspell");
    expect(result.cards[0].geomean_pick).toBeLessThan(result.cards[1].geomean_pick);
    expect(result.cards[0].times_picked).toBe(1);
    expect(result.cards[1].times_picked).toBe(1);
  });

  it("should sort by win_rate descending when sort_by is win_rate", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Lightning Bolt", qty: 1 },
      { card_id: 2, name: "Counterspell", qty: 1 },
    ]);

    mockBatchStats({
      cards: [
        { card_id: 1, name: "Lightning Bolt" },
        { card_id: 2, name: "Counterspell" },
      ],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 2 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 3 },
        { card_id: 2, draft_id: "d1", pick_n: 5 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
      playStats: [
        { card_id: 1, draft_id: "d1", seat: 1, zone: "deck" },
        { card_id: 2, draft_id: "d1", seat: 2, zone: "deck" },
      ],
      winStats: [
        // Bolt: 3 wins, 7 losses → 0.3 win rate
        { card_id: 1, draft_id: "d1", seat: 1, game_wins: 3, game_losses: 7 },
        // Counterspell: 8 wins, 2 losses → 0.8 win rate
        { card_id: 2, draft_id: "d1", seat: 2, game_wins: 8, game_losses: 2 },
      ],
    });

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      sort_by: "win_rate",
    });

    expect(result.cards).toHaveLength(2);
    // Counterspell has higher win rate, should be first
    expect(result.cards[0].card_name).toBe("Counterspell");
    expect(result.cards[1].card_name).toBe("Lightning Bolt");
    expect(result.cards[0].win_rate).toBeGreaterThan(result.cards[1].win_rate!);
  });

  it("should respect limit parameter", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Card A", qty: 1 },
      { card_id: 2, name: "Card B", qty: 1 },
      { card_id: 3, name: "Card C", qty: 1 },
    ]);

    mockBatchStats({
      cards: [
        { card_id: 1, name: "Card A" },
        { card_id: 2, name: "Card B" },
        { card_id: 3, name: "Card C" },
      ],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 2 },
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 3 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 1 },
        { card_id: 2, draft_id: "d1", pick_n: 10 },
        { card_id: 3, draft_id: "d1", pick_n: 50 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
    });

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      limit: 2,
    });

    expect(result.total_available).toBe(3);
    expect(result.cards).toHaveLength(2);
  });

  it("should return null win_rate and false low_sample when no win data exists", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Lightning Bolt", qty: 1 },
    ]);

    mockBatchStats({
      cards: [{ card_id: 1, name: "Lightning Bolt" }],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 5 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
      // No play stats or win stats
    });

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Lightning Bolt");
    expect(result.cards[0].win_rate).toBeNull();
    expect(result.cards[0].win_rate_ci).toBeNull();
    expect(result.cards[0].low_sample).toBe(false);
    expect(result.cards[0].play_rate).toBeNull();
    expect(result.cards[0].play_rate_filtered).toBe(false);
    expect(result.cards[0].win_rate_filtered).toBe(false);
  });

  it("should mark stats as filtered when deck_colors matches seats", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Lightning Bolt", qty: 1 },
    ]);

    mockBatchStats({
      cards: [{ card_id: 1, name: "Lightning Bolt" }],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 5 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
      // Seat 1 has play+win data and will match the color filter
      playStats: [
        { card_id: 1, draft_id: "d1", seat: 1, zone: "deck" },
      ],
      winStats: [
        { card_id: 1, draft_id: "d1", seat: 1, game_wins: 7, game_losses: 3 },
      ],
    });

    // getSeatsMatchingColors: seat 1 is an RG deck (many R and G cards)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([
      { draft_id: "d1", seat: 1, scryfall_json: JSON.stringify({ name: "Bolt", color_identity: ["R"] }) },
      { draft_id: "d1", seat: 1, scryfall_json: JSON.stringify({ name: "Bolt2", color_identity: ["R"] }) },
      { draft_id: "d1", seat: 1, scryfall_json: JSON.stringify({ name: "Growth", color_identity: ["G"] }) },
      { draft_id: "d1", seat: 1, scryfall_json: JSON.stringify({ name: "Growth2", color_identity: ["G"] }) },
    ]));

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      deck_colors: "RG",
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].play_rate).toBe(1.0);
    expect(result.cards[0].play_rate_filtered).toBe(true);
    expect(result.cards[0].win_rate).toBe(0.7);
    expect(result.cards[0].win_rate_filtered).toBe(true);
  });

  it("should fall back to overall stats when deck_colors filter produces no data for a card", async () => {
    mockGetAvailableCards([
      { card_id: 1, name: "Lightning Bolt", qty: 1 },
    ]);

    mockBatchStats({
      cards: [{ card_id: 1, name: "Lightning Bolt" }],
      draftsWithCard: [
        { draft_id: "d1", cube_snapshot_id: 100, card_id: 1 },
      ],
      picksOfCard: [
        { card_id: 1, draft_id: "d1", pick_n: 5 },
      ],
      cubeSizes: [{ cube_snapshot_id: 100, total_cards: 540 }],
      // Play/win data exists for seat 1, but color filter won't match seat 1
      playStats: [
        { card_id: 1, draft_id: "d1", seat: 1, zone: "deck" },
      ],
      winStats: [
        { card_id: 1, draft_id: "d1", seat: 1, game_wins: 6, game_losses: 4 },
      ],
    });

    // getSeatsMatchingColors query — return empty (no seats match the color)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await rankAvailableCards({
      draft_id: "draft1",
      before_pick_n: 1,
      deck_colors: "BG",
    });

    expect(result.cards).toHaveLength(1);
    // Filtered stats are empty, so overall stats should be used as fallback
    expect(result.cards[0].play_rate).toBe(1.0);
    expect(result.cards[0].play_rate_filtered).toBe(false);
    expect(result.cards[0].win_rate).toBe(0.6);
    expect(result.cards[0].win_rate_filtered).toBe(false);
  });
});

