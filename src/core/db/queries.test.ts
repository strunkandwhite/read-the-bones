/**
 * Tests for database query functions.
 *
 * Uses vitest mocking to mock the database client and test
 * query logic without requiring a real database connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the client module — still needed for rankAvailableCards (top-level, calls getClient internally)
vi.mock("./client", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "./client";
import {
  resolveCard,
  resolveCardFuzzy,
  lookupCardWithApiFallback as lookupCard,
  listDrafts,
  getDraft,
  getPicks,
  getAvailableCards,
  getStandings,
  getCardPickStats,
  getDraftPool,
  rankAvailableCards,
} from "./queries";

// Get the mocked getClient function (used by rankAvailableCards)
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

    const result = await resolveCard(mockClient as never, "Lightning Bolt");

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

    const result = await resolveCard(mockClient as never, "Nonexistent Card");

    expect(result).toBeNull();
  });

  it("should resolve card by name regardless of case", async () => {
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

    const result = await resolveCard(mockClient as never, "LIGHTNING BOLT");

    // The lookup must succeed even when the input case differs from the stored name
    expect(result).not.toBeNull();
    expect(result?.name).toBe("Lightning Bolt");
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

    const result = await resolveCard(mockClient as never, "Test Card");

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

    const result = await resolveCardFuzzy(mockClient as never, "Lightning Bolt");

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

    const result = await resolveCardFuzzy(mockClient as never, "Fable of the Mirror-Breaker");

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

    const result = await resolveCardFuzzy(mockClient as never, "Insectile Aberration");

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

    const result = await resolveCardFuzzy(mockClient as never, "Fire");

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

    const result = await resolveCardFuzzy(mockClient as never, "Lightning Hel");

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

    const result = await resolveCardFuzzy(mockClient as never, "Totally Nonexistent Card");

    expect(result.match).toBeNull();
    expect(result.candidates).toBeNull();
  });
});

// ============================================================================
// lookupCardWithApiFallback Tests
// ============================================================================

describe("lookupCardWithApiFallback", () => {
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

    const result = await lookupCard(mockClient as never, "Lightning Bolt");

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

    const result = await lookupCard(mockClient as never, "Force of Will");

    expect(result).toEqual({
      name: "Force of Will",
      oracle_text:
        "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.",
      type_line: "Instant",
      mana_cost: "{3}{U}{U}",
      color_identity: ["U"],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.scryfall.com/cards/named?exact=Force%20of%20Will",
      { headers: expect.objectContaining({ "User-Agent": expect.any(String) }) }
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

    const result = await lookupCard(mockClient as never, "Totally Fake Card");

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

    const result = await lookupCard(mockClient as never, "Some Card");

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

    const result = await lookupCard(mockClient as never, "Delver of Secrets");

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

    await lookupCard(mockClient as never, "Lightning Bolt");

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

    const result = await lookupCard(mockClient as never, "Test Card");

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

    const result = await lookupCard(mockClient as never, "Test Card");

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

    const result = await lookupCard(mockClient as never, "Test Card");

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

    const result = await listDrafts(mockClient as never);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      draft_id: "draft1",
      draft_name: "Draft 1",
      draft_date: "2025-01-01",
    });
  });

  it("should filter by date range", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts(mockClient as never, { date_from: "2025-01-01", date_to: "2025-12-31" });

    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("d.draft_date >= ?"),
      args: expect.arrayContaining(["2025-01-01", "2025-12-31"]),
    });
  });

  it("should filter by draft_name (partial match)", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts(mockClient as never, { draft_name: "Vintage" });

    expect(mockClient.execute).toHaveBeenCalledWith({
      sql: expect.stringContaining("LOWER(d.draft_name) LIKE LOWER(?)"),
      args: ["%Vintage%"],
    });
  });

  it("should combine multiple filters", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await listDrafts(mockClient as never, {
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

    const result = await listDrafts(mockClient as never);

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

    const result = await getDraft(mockClient as never, "draft1");

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

    const result = await getDraft(mockClient as never, "nonexistent");

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

    const result = await getPicks(mockClient as never, { draft_id: "draft1" });

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

    await getPicks(mockClient as never, { draft_id: "draft1", seat: 1 });

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

    await getPicks(mockClient as never, { draft_id: "draft1", pick_n_min: 10, pick_n_max: 20 });

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

    await getPicks(mockClient as never, { draft_id: "draft1", card_name: "Bolt" });

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

    const result = await getPicks(mockClient as never, { draft_id: "draft1" });

    expect(result.picks).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("should redact seats for opted-out players", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ draft_id: "draft1", seat: 2 }]));
    // Mock picks query
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
        { pick_n: 2, seat: 2, card_name: "Counterspell" },
      ])
    );

    const result = await getPicks(mockClient as never, { draft_id: "draft1" });

    expect(result.redacted_seats).toEqual([2]);
    expect(result.picks[0].seat).toBe(1);
    expect(result.picks[1].seat).toBe("[REDACTED]");
  });

  it("should return empty when querying opted-out seat directly", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ draft_id: "draft1", seat: 2 }]));

    const result = await getPicks(mockClient as never, { draft_id: "draft1", seat: 2 });

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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
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

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.cards).toHaveLength(0);
  });

  it("P9: does NOT select scryfall_json when no color/type_contains filters are set", async () => {
    // Draft lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: null }])
    );
    // Cube cards
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", qty: 1 },
      ])
    );
    // Picks
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
      // No color or type_contains
    });

    // The second execute call is the cube cards query
    const cubeCardsSql: string = (mockClient.execute.mock.calls[1][0] as { sql: string }).sql;
    expect(cubeCardsSql).not.toContain("scryfall_json");
  });

  it("P9: selects scryfall_json when color filter is set", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: null }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", scryfall_json: JSON.stringify({ color_identity: ["R"] }), qty: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
      color: "R",
    });

    // Query must include scryfall_json when filter is active
    const cubeCardsSql: string = (mockClient.execute.mock.calls[1][0] as { sql: string }).sql;
    expect(cubeCardsSql).toContain("scryfall_json");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Lightning Bolt");
  });

  it("P9: selects scryfall_json when type_contains filter is set", async () => {
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: null }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Tarmogoyf", scryfall_json: JSON.stringify({ type_line: "Creature - Lhurgoyf" }), qty: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
      type_contains: "Creature",
    });

    const cubeCardsSql: string = (mockClient.execute.mock.calls[1][0] as { sql: string }).sql;
    expect(cubeCardsSql).toContain("scryfall_json");
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Tarmogoyf");
  });

  it("excludes a banned card by exact name match", async () => {
    // Draft lookup — returns banned_cards column
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: JSON.stringify(["Lightning Bolt"]) }])
    );
    // Cube cards: Lightning Bolt + Counterspell
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Lightning Bolt", qty: 1 },
        { card_id: 2, name: "Counterspell", qty: 1 },
      ])
    );
    // No picks
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
    });

    // Lightning Bolt should be excluded
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Counterspell");
  });

  it("excludes a DFC by its front-face name when only the full name is in the cube", async () => {
    // Banned card stored as just the front face: "Delver of Secrets"
    // Cube card is the full DFC name: "Delver of Secrets // Insectile Aberration"
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: JSON.stringify(["Delver of Secrets"]) }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Delver of Secrets // Insectile Aberration", qty: 1 },
        { card_id: 2, name: "Force of Will", qty: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
    });

    // DFC should be excluded because its front face is banned
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Force of Will");
  });

  it("ban matching is case-insensitive", async () => {
    // Ban stored with mixed case
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, banned_cards: JSON.stringify(["CHANNEL"]) }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { card_id: 1, name: "Channel", qty: 1 },
        { card_id: 2, name: "Mox Pearl", qty: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getAvailableCards(mockClient as never, {
      draft_id: "draft1",
      before_pick_n: 5,
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0].card_name).toBe("Mox Pearl");
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
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
        { draft_id: "draft1", seat1: 1, seat2: 3, seat1_wins: 2, seat2_wins: 0 },
        { draft_id: "draft1", seat1: 2, seat2: 3, seat1_wins: 1, seat2_wins: 2 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

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
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 1, seat2_wins: 1 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

    // Draw - neither seat gets a match win or loss
    expect(result.standings).toHaveLength(2);
    const seat1 = result.standings.find((s) => s.seat === 1);
    const seat2 = result.standings.find((s) => s.seat === 2);

    expect(seat1?.matchWins).toBe(0);
    expect(seat1?.matchLosses).toBe(0);
    expect(seat2?.matchWins).toBe(0);
    expect(seat2?.matchLosses).toBe(0);

    // The seats tie on every tiebreaker and their only match was a draw, so
    // head-to-head resolves nothing and the original order is kept
    expect(result.standings.map((s) => s.seat)).toEqual([1, 2]);
  });

  it("should return empty array when no matches", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events (empty)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getStandings(mockClient as never, "draft1");

    expect(result.standings).toEqual([]);
  });

  it("should sort by match wins then OMW% then OGW%", async () => {
    // Mock opt-outs query (no opt-outs)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Mock match events: 3 players round-robin
    // Seat 1 beats seat 2 (2-1), seat 3 beats seat 1 (2-0), seat 2 beats seat 3 (2-1)
    // Records: seat 1 = 1-1, seat 2 = 1-1, seat 3 = 1-1
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
        { draft_id: "draft1", seat1: 1, seat2: 3, seat1_wins: 0, seat2_wins: 2 },
        { draft_id: "draft1", seat1: 2, seat2: 3, seat1_wins: 2, seat2_wins: 1 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

    // All 3 seats have 1 match win. OMW% breaks the tie:
    // Seat 1 opponents: seat 2 (1/2=0.5), seat 3 (1/2=0.5) → OMW% = 0.5
    // Seat 2 opponents: seat 1 (1/2=0.5), seat 3 (1/2=0.5) → OMW% = 0.5
    // Seat 3 opponents: seat 1 (1/2=0.5), seat 2 (1/2=0.5) → OMW% = 0.5
    // OMW% tied, so OGW% breaks it:
    // Seat 1 opponents GWR: seat 2 (3/6=0.5), seat 3 (3/5=0.6) → OGW% = 0.55
    // Seat 2 opponents GWR: seat 1 (2/5=0.4), seat 3 (3/5=0.6) → OGW% = 0.5
    // Seat 3 opponents GWR: seat 1 (2/5=0.4), seat 2 (3/6=0.5) → OGW% = 0.45
    // Order: seat 1 (0.55) > seat 2 (0.5) > seat 3 (0.45)
    expect(result.standings[0].seat).toBe(1);
    expect(result.standings[1].seat).toBe(2);
    expect(result.standings[2].seat).toBe(3);
  });

  it("breaks exact OMW% ties by OGW% despite float summation noise", async () => {
    // Real pod data where seats 2, 3, and 8 all finish 5-4 with OMW% values
    // that are exactly equal in real arithmetic — each seat's opponent set
    // differs from the others' only by swapping in an opponent with an
    // identical record — but float summation order leaves ~1e-16 differences
    // between them. OGW% must decide the tie: seat 3 (≈49.0%) ranks above
    // seats 8 and 2 (≈48.5%).
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    const matches: Array<[number, number, number, number]> = [
      [1, 2, 1, 2], [1, 3, 2, 1], [1, 5, 2, 0], [1, 6, 2, 1], [1, 8, 1, 2],
      [1, 9, 0, 2], [2, 3, 1, 2], [2, 4, 2, 1], [2, 5, 2, 1], [2, 6, 2, 0],
      [2, 7, 2, 0], [2, 8, 1, 2], [2, 9, 1, 2], [2, 10, 0, 2], [3, 4, 2, 1],
      [3, 5, 0, 2], [3, 6, 0, 2], [3, 7, 2, 0], [3, 8, 2, 1], [3, 9, 2, 1],
      [3, 10, 1, 2], [4, 5, 2, 1], [4, 6, 2, 0], [4, 7, 2, 1], [4, 8, 2, 1],
      [4, 9, 2, 1], [4, 10, 0, 2], [5, 6, 1, 2], [5, 8, 2, 1], [5, 9, 2, 0],
      [5, 10, 1, 2], [6, 8, 0, 2], [6, 10, 0, 2], [7, 8, 1, 2], [7, 10, 2, 1],
      [8, 9, 2, 0], [8, 10, 0, 2], [9, 10, 1, 2],
    ];
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult(
        matches.map(([seat1, seat2, seat1Wins, seat2Wins]) => ({
          draft_id: "draft1",
          seat1,
          seat2,
          seat1_wins: seat1Wins,
          seat2_wins: seat2Wins,
        }))
      )
    );

    const result = await getStandings(mockClient as never, "draft1");

    const seats = result.standings.map((s) => s.seat);
    expect(seats[0]).toBe(10); // 7-1, clear first
    expect(seats[1]).toBe(3); // 5-4, wins the OGW% tiebreak among the 5-4 group
    expect(seats[2]).toBe(8); // 5-4, tied with seat 2 through OGW% but won head-to-head 2-1
    expect(seats[3]).toBe(2);
    expect(seats[4]).toBe(4); // 5-3, same match wins as the 5-4 group but lower OMW%
    // Seats 6 and 9 (both 2-5) also tie exactly on OMW%/OGW% but have no
    // reported match against each other, so head-to-head leaves their order
    expect(seats[7]).toBe(6);
    expect(seats[8]).toBe(9);
  });

  it("leaves ties of three or more seats in sorted order (head-to-head can be cyclic)", async () => {
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Seats 1, 2, 3 beat each other in a cycle (1>2, 2>3, 3>1, all 2-0) and
    // all sweep seat 4, so they tie exactly on record, OMW%, and OGW%.
    // Head-to-head is cyclic, so the group keeps its sorted (insertion) order.
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 },
        { draft_id: "draft1", seat1: 2, seat2: 3, seat1_wins: 2, seat2_wins: 0 },
        { draft_id: "draft1", seat1: 1, seat2: 3, seat1_wins: 0, seat2_wins: 2 },
        { draft_id: "draft1", seat1: 1, seat2: 4, seat1_wins: 2, seat2_wins: 0 },
        { draft_id: "draft1", seat1: 2, seat2: 4, seat1_wins: 2, seat2_wins: 0 },
        { draft_id: "draft1", seat1: 3, seat2: 4, seat1_wins: 2, seat2_wins: 0 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

    expect(result.standings.map((s) => s.seat)).toEqual([1, 2, 3, 4]);
  });

  it("should redact opted-out seats in standings", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ draft_id: "draft1", seat: 2 }]));
    // Mock match events
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 1 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

    expect(result.redacted_seats).toEqual([2]);
    expect(result.standings).toHaveLength(2);
    // Seat 1 wins, so it's first
    expect(result.standings[0].seat).toBe(1);
    expect(result.standings[1].seat).toBe("[REDACTED]");
  });

  it("pads with zero-record entries for seats with no matches when numSeats is provided", async () => {
    // No opt-outs
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Only seat 1 vs seat 2 has played
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 },
      ])
    );

    // numSeats = 4: seats 3 and 4 have never played
    const result = await getStandings(mockClient as never, "draft1", 4);

    expect(result.standings).toHaveLength(4);
    const seatNums = result.standings.map((s) => s.seat);
    expect(seatNums).toContain(3);
    expect(seatNums).toContain(4);
    const seat3 = result.standings.find((s) => s.seat === 3)!;
    expect(seat3.matchWins).toBe(0);
    expect(seat3.matchLosses).toBe(0);
    expect(seat3.omwPct).toBeNull();
    expect(seat3.ogwPct).toBeNull();
  });

  it("applies the 1/3 floor to OMW% and OGW% tiebreakers", async () => {
    // No opt-outs
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Seat 1 beats seat 2 (2-0); seat 2 has record 0-1 → raw OMW% for seat 1 = 0/1 = 0,
    // but floor raises it to 1/3
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "draft1", seat1: 1, seat2: 2, seat1_wins: 2, seat2_wins: 0 },
      ])
    );

    const result = await getStandings(mockClient as never, "draft1");

    // Seat 1 has opponent seat 2 with 0 match wins and 0 game wins
    // Raw MWR for seat 2 = 0/1 = 0, floored at 1/3
    const seat1 = result.standings.find((s) => s.seat === 1)!;
    expect(seat1.omwPct).toBeCloseTo(1 / 3, 5);
    // Raw GWR for seat 2 = 0 / (0+2) = 0, floored at 1/3
    expect(seat1.ogwPct).toBeCloseTo(1 / 3, 5);
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

    const result = await getCardPickStats(mockClient as never, { card_name:"Nonexistent" });

    expect(result).toBeNull();
  });

  it("should return zero stats when card exists but not in any draft", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats(mockClient as never, { card_name:"Test Card" });

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

    const result = await getCardPickStats(mockClient as never, { card_name:"Lightning Bolt" });

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

    const result = await getCardPickStats(mockClient as never, { card_name:"Test Card" });

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

    const result = await getCardPickStats(mockClient as never, { card_name:"Test Card" });

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

    const result = await getCardPickStats(mockClient as never, { card_name:"Test Card" });

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

    await getCardPickStats(mockClient as never, {
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

    await getCardPickStats(mockClient as never, {
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

  it("weights the more recent session more heavily", async () => {
    // Card lookup
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    // Drafts with card — two sessions
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", cube_snapshot_id: 1, draft_date: "2026-07-17" },
        { draft_id: "older", cube_snapshot_id: 1, draft_date: "2026-03-08" },
      ])
    );
    // Banned cards check (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Cube sizes
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    // Picks of this card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", pick_n: 10, seat: 1 },
        { draft_id: "older", pick_n: 100, seat: 1 },
      ])
    );
    // Opt-outs (none)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    // Deck cards (no decklist data)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats(mockClient as never, { card_name: "Test Card" });

    // 'older' is one session back, weight 0.5^(1/4) = 0.8409:
    // exp((1*ln(10) + 0.8409*ln(100)) / 1.8409) = 28.63.
    // Flat weighting would give exp((ln(10) + ln(100)) / 2) = 31.62.
    expect(result?.weighted_geomean).toBeCloseTo(28.6, 1);
  });

  it("counts sessions rather than elapsed time", async () => {
    // Identical to the previous fixture except the older draft is one week
    // back instead of four months. It is still one session back, so the score
    // must be identical — recency decays over drafting, not over the calendar.
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ card_id: 1, oracle_id: "abc", name: "Test Card", scryfall_json: null }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", cube_snapshot_id: 1, draft_date: "2026-07-17" },
        { draft_id: "older", cube_snapshot_id: 1, draft_date: "2026-07-10" },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cube_snapshot_id: 1, total_cards: 540 }])
    );
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { draft_id: "recent", pick_n: 10, seat: 1 },
        { draft_id: "older", pick_n: 100, seat: 1 },
      ])
    );
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    const result = await getCardPickStats(mockClient as never, { card_name: "Test Card" });

    expect(result?.weighted_geomean).toBeCloseTo(28.6, 1);
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

    const result = await getDraftPool(mockClient as never, { draft_id: "draft1" });

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

    const result = await getDraftPool(mockClient as never, { draft_id: "nonexistent" });

    expect(result).toBeNull();
  });

  it("should redact opted-out seats when include_draft_results is true", async () => {
    // Mock opt-outs query (seat 2 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ draft_id: "draft1", seat: 2 }]));
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

    const result = await getDraftPool(mockClient as never, {
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

    const result = await getDraftPool(mockClient as never, {
      draft_id: "draft1",
      include_draft_results: true,
    });

    expect(result).not.toBeNull();
    expect(result!.redacted_seats).toBeUndefined();
    expect(result!.cards![0].drafted_by_seat).toBe(1);
  });

  it("should not expose seat info when include_draft_results is false", async () => {
    // Mock opt-outs query (seat 1 opted out)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ draft_id: "draft1", seat: 1 }]));
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

    const result = await getDraftPool(mockClient as never, {
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

