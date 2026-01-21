/**
 * Tests for the tool executor module.
 *
 * Tests the routing of tool calls to database query functions
 * and the JSON interface for LLM integration.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the queries module before importing toolExecutor
vi.mock("../db/queries", () => ({
  listDrafts: vi.fn(),
  getDraft: vi.fn(),
  getPicks: vi.fn(),
  getAvailableCards: vi.fn(),
  getStandings: vi.fn(),
  getCardPickStats: vi.fn(),
  lookupCard: vi.fn(),
  getDraftPool: vi.fn(),
}));

// Mock the tools module for isValidToolName
vi.mock("./tools", () => ({
  isValidToolName: vi.fn((name: string) => {
    const validNames = [
      "list_drafts",
      "get_draft",
      "get_picks",
      "get_available_cards",
      "get_standings",
      "get_card_pick_stats",
      "lookup_card",
      "get_draft_pool",
    ];
    return validNames.includes(name);
  }),
}));

import * as queries from "../db/queries";
import { executeTool, executeToolForLLM } from "./toolExecutor";

// Get mocked functions
const mockListDrafts = vi.mocked(queries.listDrafts);
const mockGetDraft = vi.mocked(queries.getDraft);
const mockGetPicks = vi.mocked(queries.getPicks);
const mockGetAvailableCards = vi.mocked(queries.getAvailableCards);
const mockGetStandings = vi.mocked(queries.getStandings);
const mockGetCardPickStats = vi.mocked(queries.getCardPickStats);
const mockLookupCard = vi.mocked(queries.lookupCard);
const mockGetDraftPool = vi.mocked(queries.getDraftPool);

// ============================================================================
// executeTool Tests
// ============================================================================

describe("executeTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Unknown tool
  // --------------------------------------------------------------------------

  describe("unknown tool", () => {
    it("should return error for unknown tool name", async () => {
      const result = await executeTool("unknown_tool", {});

      expect(result).toEqual({
        success: false,
        error: "Unknown tool: unknown_tool",
      });
    });

    it("should return error for empty tool name", async () => {
      const result = await executeTool("", {});

      expect(result).toEqual({
        success: false,
        error: "Unknown tool: ",
      });
    });
  });

  // --------------------------------------------------------------------------
  // list_drafts
  // --------------------------------------------------------------------------

  describe("list_drafts", () => {
    it("should call listDrafts with no filters", async () => {
      mockListDrafts.mockResolvedValueOnce([
        { draft_id: "draft1", draft_name: "Draft 1", draft_date: "2025-01-01" },
      ]);

      const result = await executeTool("list_drafts", {});

      expect(result.success).toBe(true);
      expect(mockListDrafts).toHaveBeenCalledWith({
        date_from: undefined,
        date_to: undefined,
        draft_name: undefined,
      });
    });

    it("should pass filters to listDrafts", async () => {
      mockListDrafts.mockResolvedValueOnce([]);

      await executeTool("list_drafts", {
        date_from: "2025-01-01",
        date_to: "2025-12-31",
        draft_name: "Vintage",
      });

      expect(mockListDrafts).toHaveBeenCalledWith({
        date_from: "2025-01-01",
        date_to: "2025-12-31",
        draft_name: "Vintage",
      });
    });

    it("should return draft list data", async () => {
      const drafts = [
        { draft_id: "d1", draft_name: "Draft 1", draft_date: "2025-01-01" },
        { draft_id: "d2", draft_name: "Draft 2", draft_date: "2025-01-02" },
      ];
      mockListDrafts.mockResolvedValueOnce(drafts);

      const result = await executeTool("list_drafts", {});

      expect(result).toEqual({ success: true, data: drafts });
    });
  });

  // --------------------------------------------------------------------------
  // get_draft
  // --------------------------------------------------------------------------

  describe("get_draft", () => {
    it("should require draft_id", async () => {
      const result = await executeTool("get_draft", {});

      expect(result).toEqual({
        success: false,
        error: "draft_id is required",
      });
    });

    it("should return error when draft not found", async () => {
      mockGetDraft.mockResolvedValueOnce(null);

      const result = await executeTool("get_draft", { draft_id: "nonexistent" });

      expect(result).toEqual({
        success: false,
        error: "Draft not found: nonexistent",
      });
    });

    it("should return draft details", async () => {
      const draftDetails = {
        draft_id: "draft1",
        draft_name: "Vintage Cube",
        draft_date: "2025-01-15",
        num_seats: 8,
      };
      mockGetDraft.mockResolvedValueOnce(draftDetails);

      const result = await executeTool("get_draft", { draft_id: "draft1" });

      expect(result).toEqual({ success: true, data: draftDetails });
    });
  });

  // --------------------------------------------------------------------------
  // get_picks
  // --------------------------------------------------------------------------

  describe("get_picks", () => {
    it("should require draft_id", async () => {
      const result = await executeTool("get_picks", {});

      expect(result).toEqual({
        success: false,
        error: "draft_id is required",
      });
    });

    it("should call getPicks with draft_id only", async () => {
      mockGetPicks.mockResolvedValueOnce({
        draft_id: "draft1",
        total: 0,
        picks: [],
      });

      await executeTool("get_picks", { draft_id: "draft1" });

      expect(mockGetPicks).toHaveBeenCalledWith({
        draft_id: "draft1",
        seat: undefined,
        pick_n_min: undefined,
        pick_n_max: undefined,
        card_name: undefined,
      });
    });

    it("should pass all filters to getPicks", async () => {
      mockGetPicks.mockResolvedValueOnce({
        draft_id: "draft1",
        total: 0,
        picks: [],
      });

      await executeTool("get_picks", {
        draft_id: "draft1",
        seat: 1,
        pick_n_min: 10,
        pick_n_max: 20,
        card_name: "Bolt",
      });

      expect(mockGetPicks).toHaveBeenCalledWith({
        draft_id: "draft1",
        seat: 1,
        pick_n_min: 10,
        pick_n_max: 20,
        card_name: "Bolt",
      });
    });

    it("should return picks data", async () => {
      const picksResult = {
        draft_id: "draft1",
        total: 2,
        picks: [
          { pick_n: 1, seat: 1, card_name: "Lightning Bolt" },
          { pick_n: 2, seat: 2, card_name: "Counterspell" },
        ],
      };
      mockGetPicks.mockResolvedValueOnce(picksResult);

      const result = await executeTool("get_picks", { draft_id: "draft1" });

      expect(result).toEqual({ success: true, data: picksResult });
    });
  });

  // --------------------------------------------------------------------------
  // get_available_cards
  // --------------------------------------------------------------------------

  describe("get_available_cards", () => {
    it("should require draft_id", async () => {
      const result = await executeTool("get_available_cards", { before_pick_n: 5 });

      expect(result).toEqual({
        success: false,
        error: "draft_id is required",
      });
    });

    it("should require before_pick_n", async () => {
      const result = await executeTool("get_available_cards", { draft_id: "draft1" });

      expect(result).toEqual({
        success: false,
        error: "before_pick_n is required",
      });
    });

    it("should call getAvailableCards with required params", async () => {
      mockGetAvailableCards.mockResolvedValueOnce({
        draft_id: "draft1",
        before_pick_n: 5,
        cards: [],
      });

      await executeTool("get_available_cards", {
        draft_id: "draft1",
        before_pick_n: 5,
      });

      expect(mockGetAvailableCards).toHaveBeenCalledWith({
        draft_id: "draft1",
        before_pick_n: 5,
        color: undefined,
        type_contains: undefined,
      });
    });

    it("should pass optional filters", async () => {
      mockGetAvailableCards.mockResolvedValueOnce({
        draft_id: "draft1",
        before_pick_n: 5,
        cards: [],
      });

      await executeTool("get_available_cards", {
        draft_id: "draft1",
        before_pick_n: 5,
        color: "R",
        type_contains: "Instant",
      });

      expect(mockGetAvailableCards).toHaveBeenCalledWith({
        draft_id: "draft1",
        before_pick_n: 5,
        color: "R",
        type_contains: "Instant",
      });
    });

    it("should return available cards data", async () => {
      const cardsResult = {
        draft_id: "draft1",
        before_pick_n: 5,
        cards: [
          { card_name: "Lightning Bolt", remaining_qty: 1 },
          { card_name: "Counterspell", remaining_qty: 2 },
        ],
      };
      mockGetAvailableCards.mockResolvedValueOnce(cardsResult);

      const result = await executeTool("get_available_cards", {
        draft_id: "draft1",
        before_pick_n: 5,
      });

      expect(result).toEqual({ success: true, data: cardsResult });
    });
  });

  // --------------------------------------------------------------------------
  // get_standings
  // --------------------------------------------------------------------------

  describe("get_standings", () => {
    it("should require draft_id", async () => {
      const result = await executeTool("get_standings", {});

      expect(result).toEqual({
        success: false,
        error: "draft_id is required",
      });
    });

    it("should call getStandings with draft_id", async () => {
      mockGetStandings.mockResolvedValueOnce([]);

      await executeTool("get_standings", { draft_id: "draft1" });

      expect(mockGetStandings).toHaveBeenCalledWith("draft1");
    });

    it("should return standings data", async () => {
      const standings = [
        { seat: 1, match_wins: 2, match_losses: 0, game_wins: 4, game_losses: 1 },
        { seat: 2, match_wins: 1, match_losses: 1, game_wins: 3, game_losses: 3 },
      ];
      mockGetStandings.mockResolvedValueOnce(standings);

      const result = await executeTool("get_standings", { draft_id: "draft1" });

      expect(result).toEqual({ success: true, data: standings });
    });
  });

  // --------------------------------------------------------------------------
  // get_card_pick_stats
  // --------------------------------------------------------------------------

  describe("get_card_pick_stats", () => {
    it("should require card_name", async () => {
      const result = await executeTool("get_card_pick_stats", {});

      expect(result).toEqual({
        success: false,
        error: "card_name is required",
      });
    });

    it("should return error when card not found", async () => {
      mockGetCardPickStats.mockResolvedValueOnce(null);

      const result = await executeTool("get_card_pick_stats", { card_name: "Nonexistent" });

      expect(result).toEqual({
        success: false,
        error: "Card not found: Nonexistent",
      });
    });

    it("should call getCardPickStats with params", async () => {
      mockGetCardPickStats.mockResolvedValueOnce({
        card_name: "Lightning Bolt",
        drafts_seen: 5,
        times_picked: 5,
        avg_pick_n: 3.5,
        median_pick_n: 3,
        weighted_geomean: 3.2,
      });

      await executeTool("get_card_pick_stats", {
        card_name: "Lightning Bolt",
        date_from: "2025-01-01",
        date_to: "2025-12-31",
        draft_name: "Vintage",
      });

      expect(mockGetCardPickStats).toHaveBeenCalledWith({
        card_name: "Lightning Bolt",
        date_from: "2025-01-01",
        date_to: "2025-12-31",
        draft_name: "Vintage",
      });
    });

    it("should return card pick stats data", async () => {
      const stats = {
        card_name: "Lightning Bolt",
        drafts_seen: 10,
        times_picked: 10,
        avg_pick_n: 5.2,
        median_pick_n: 4,
        weighted_geomean: 4.5,
      };
      mockGetCardPickStats.mockResolvedValueOnce(stats);

      const result = await executeTool("get_card_pick_stats", { card_name: "Lightning Bolt" });

      expect(result).toEqual({ success: true, data: stats });
    });
  });

  // --------------------------------------------------------------------------
  // lookup_card
  // --------------------------------------------------------------------------

  describe("lookup_card", () => {
    it("should require card_name", async () => {
      const result = await executeTool("lookup_card", {});

      expect(result).toEqual({
        success: false,
        error: "card_name is required",
      });
    });

    it("should return error when card not found", async () => {
      mockLookupCard.mockResolvedValueOnce(null);

      const result = await executeTool("lookup_card", { card_name: "Nonexistent" });

      expect(result).toEqual({
        success: false,
        error: "Card not found: Nonexistent",
      });
    });

    it("should return card lookup data", async () => {
      const cardData = {
        name: "Lightning Bolt",
        oracle_text: "Lightning Bolt deals 3 damage to any target.",
        type_line: "Instant",
        mana_cost: "{R}",
        color_identity: ["R"],
      };
      mockLookupCard.mockResolvedValueOnce(cardData);

      const result = await executeTool("lookup_card", { card_name: "Lightning Bolt" });

      expect(result).toEqual({ success: true, data: cardData });
    });
  });

  // --------------------------------------------------------------------------
  // get_draft_pool
  // --------------------------------------------------------------------------

  describe("get_draft_pool", () => {
    it("should call getDraftPool with provided draft_id", async () => {
      const poolData = {
        draft_id: "draft1",
        draft_name: "Draft 1",
        draft_date: "2025-01-01",
        total_cards: 540,
        cards: [],
        grouped: null,
      };
      mockGetDraftPool.mockResolvedValueOnce(poolData);

      await executeTool("get_draft_pool", { draft_id: "draft1" });

      expect(mockGetDraftPool).toHaveBeenCalledWith({
        draft_id: "draft1",
        include_draft_results: undefined,
        include_card_details: undefined,
        group_by: undefined,
        color: undefined,
        type_contains: undefined,
        name_contains: undefined,
      });
    });

    it("should use most recent draft when draft_id is not provided", async () => {
      const drafts = [
        { draft_id: "recent-draft", draft_name: "Recent Draft", draft_date: "2025-01-15" },
        { draft_id: "old-draft", draft_name: "Old Draft", draft_date: "2025-01-01" },
      ];
      mockListDrafts.mockResolvedValueOnce(drafts);

      const poolData = {
        draft_id: "recent-draft",
        draft_name: "Recent Draft",
        draft_date: "2025-01-15",
        total_cards: 540,
        cards: [],
        grouped: null,
      };
      mockGetDraftPool.mockResolvedValueOnce(poolData);

      const result = await executeTool("get_draft_pool", {});

      expect(mockListDrafts).toHaveBeenCalled();
      expect(mockGetDraftPool).toHaveBeenCalledWith({
        draft_id: "recent-draft",
        include_draft_results: undefined,
        include_card_details: undefined,
        group_by: undefined,
        color: undefined,
        type_contains: undefined,
        name_contains: undefined,
      });
      expect(result).toEqual({ success: true, data: poolData });
    });

    it("should use most recent draft when draft_id is empty string", async () => {
      const drafts = [
        { draft_id: "recent-draft", draft_name: "Recent Draft", draft_date: "2025-01-15" },
      ];
      mockListDrafts.mockResolvedValueOnce(drafts);

      const poolData = {
        draft_id: "recent-draft",
        draft_name: "Recent Draft",
        draft_date: "2025-01-15",
        total_cards: 540,
        cards: [],
        grouped: null,
      };
      mockGetDraftPool.mockResolvedValueOnce(poolData);

      const result = await executeTool("get_draft_pool", { draft_id: "" });

      expect(mockListDrafts).toHaveBeenCalled();
      expect(mockGetDraftPool).toHaveBeenCalledWith({
        draft_id: "recent-draft",
        include_draft_results: undefined,
        include_card_details: undefined,
        group_by: undefined,
        color: undefined,
        type_contains: undefined,
        name_contains: undefined,
      });
      expect(result).toEqual({ success: true, data: poolData });
    });

    it("should return error when no drafts exist and draft_id not provided", async () => {
      mockListDrafts.mockResolvedValueOnce([]);

      const result = await executeTool("get_draft_pool", {});

      expect(result).toEqual({
        success: false,
        error: "No drafts found in database",
      });
    });

    it("should return error when draft not found", async () => {
      mockGetDraftPool.mockResolvedValueOnce(null);

      const result = await executeTool("get_draft_pool", { draft_id: "nonexistent" });

      expect(result).toEqual({
        success: false,
        error: "Draft not found: nonexistent",
      });
    });

    it("should pass all optional parameters", async () => {
      const poolData = {
        draft_id: "draft1",
        draft_name: "Draft 1",
        draft_date: "2025-01-01",
        total_cards: 10,
        cards: null,
        grouped: { R: [] },
      };
      mockGetDraftPool.mockResolvedValueOnce(poolData);

      await executeTool("get_draft_pool", {
        draft_id: "draft1",
        include_draft_results: true,
        include_card_details: true,
        group_by: "color_identity",
        color: "R",
        type_contains: "Instant",
        name_contains: "Bolt",
      });

      expect(mockGetDraftPool).toHaveBeenCalledWith({
        draft_id: "draft1",
        include_draft_results: true,
        include_card_details: true,
        group_by: "color_identity",
        color: "R",
        type_contains: "Instant",
        name_contains: "Bolt",
      });
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe("error handling", () => {
    it("should catch and return errors thrown by query functions", async () => {
      mockListDrafts.mockRejectedValueOnce(new Error("Database connection failed"));

      const result = await executeTool("list_drafts", {});

      expect(result).toEqual({
        success: false,
        error: "Database connection failed",
      });
    });

    it("should handle non-Error thrown values", async () => {
      mockListDrafts.mockRejectedValueOnce("string error");

      const result = await executeTool("list_drafts", {});

      expect(result).toEqual({
        success: false,
        error: "Unknown error",
      });
    });
  });
});

// ============================================================================
// executeToolForLLM Tests
// ============================================================================

describe("executeToolForLLM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return JSON stringified data on success", async () => {
    const drafts = [
      { draft_id: "d1", draft_name: "Draft 1", draft_date: "2025-01-01" },
    ];
    mockListDrafts.mockResolvedValueOnce(drafts);

    const result = await executeToolForLLM("list_drafts", "{}");

    expect(result).toBe(JSON.stringify(drafts));
  });

  it("should return JSON error on unknown tool", async () => {
    const result = await executeToolForLLM("unknown_tool", "{}");

    expect(result).toBe(JSON.stringify({ error: "Unknown tool: unknown_tool" }));
  });

  it("should return JSON error on invalid JSON arguments", async () => {
    const result = await executeToolForLLM("list_drafts", "{ invalid json }");

    expect(result).toBe(JSON.stringify({ error: "Invalid JSON arguments" }));
  });

  it("should return JSON error on query failure", async () => {
    mockGetDraft.mockResolvedValueOnce(null);

    const result = await executeToolForLLM("get_draft", '{"draft_id": "nonexistent"}');

    expect(result).toBe(JSON.stringify({ error: "Draft not found: nonexistent" }));
  });

  it("should parse and pass JSON arguments to tool", async () => {
    mockGetPicks.mockResolvedValueOnce({
      draft_id: "draft1",
      total: 0,
      picks: [],
    });

    await executeToolForLLM(
      "get_picks",
      JSON.stringify({
        draft_id: "draft1",
        seat: 1,
        pick_n_min: 10,
        pick_n_max: 20,
      })
    );

    expect(mockGetPicks).toHaveBeenCalledWith({
      draft_id: "draft1",
      seat: 1,
      pick_n_min: 10,
      pick_n_max: 20,
      card_name: undefined,
    });
  });

  it("should handle complex nested data in response", async () => {
    const complexData = {
      draft_id: "draft1",
      draft_name: "Vintage Cube",
      draft_date: "2025-01-15",
      num_seats: 8,
    };
    mockGetDraft.mockResolvedValueOnce(complexData);

    const result = await executeToolForLLM("get_draft", '{"draft_id": "draft1"}');

    expect(JSON.parse(result)).toEqual(complexData);
  });

  it("should handle empty array response", async () => {
    mockListDrafts.mockResolvedValueOnce([]);

    const result = await executeToolForLLM("list_drafts", "{}");

    expect(result).toBe("[]");
  });

  it("should handle special characters in error messages", async () => {
    mockGetDraft.mockResolvedValueOnce(null);

    const result = await executeToolForLLM("get_draft", '{"draft_id": "test<>draft"}');

    expect(result).toContain("test<>draft");
  });
});
