/**
 * Tests for decklist query functions.
 * Uses mocked database client.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";

vi.mock("./client", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "./client";
import { getDeck, getCardPlayStats, getCardWinStats } from "./queries";

const mockExecute = vi.fn();
const mockGetClient = vi.mocked(getClient);
const mockClient = { execute: mockExecute } as unknown as Client;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetClient.mockResolvedValue({ execute: mockExecute } as any);
});

describe("getDeck", () => {
  it("should return deck and sideboard card names for a seat", async () => {
    // Mock deck query
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_name: "Counterspell", zone: "deck" },
        { card_name: "Lightning Bolt", zone: "deck" },
        { card_name: "Wrath of God", zone: "sideboard" },
      ],
    });

    const result = await getDeck({ draft_id: "tarkir", seat: 1 });

    expect(result).toEqual({
      draft_id: "tarkir",
      seat: 1,
      deck: ["Counterspell", "Lightning Bolt"],
      sideboard: ["Wrath of God"],
    });
  });
});

describe("getCardPlayStats", () => {
  it("should compute play rate across drafts", async () => {
    // Mock resolveCard
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 42, oracle_id: "gen:bolt", name: "Lightning Bolt", scryfall_json: null }],
    });
    // Mock play stats query
    mockExecute.mockResolvedValueOnce({
      rows: [
        { draft_id: "tarkir", seat: 1, zone: "deck" },
        { draft_id: "birds", seat: 1, zone: "deck" },
        { draft_id: "legacy", seat: 2, zone: "sideboard" },
      ],
    });

    const result = await getCardPlayStats(mockClient, { card_name: "Lightning Bolt" });

    expect(result).toEqual({
      card_name: "Lightning Bolt",
      times_drafted: 3,
      times_maindecked: 2,
      play_rate: expect.closeTo(0.667, 2),
      drafts_with_decklists: 3,
    });
  });

  it("should return null when card not found", async () => {
    // resolveCardFuzzy tries 5 tiers: exact, front-face, back-face, prefix, substring
    for (let i = 0; i < 5; i++) {
      mockExecute.mockResolvedValueOnce({ rows: [] });
    }

    const result = await getCardPlayStats(mockClient, { card_name: "Nonexistent" });

    expect(result).toBeNull();
  });

  it("should return zero play rate when never maindecked", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 42, oracle_id: "gen:bolt", name: "Lightning Bolt", scryfall_json: null }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ draft_id: "tarkir", seat: 1, zone: "sideboard" }],
    });

    const result = await getCardPlayStats(mockClient, { card_name: "Lightning Bolt" });

    expect(result!.play_rate).toBe(0);
    expect(result!.times_maindecked).toBe(0);
    expect(result!.times_drafted).toBe(1);
  });
});

describe("getCardWinStats", () => {
  it("should return null when card not found", async () => {
    // resolveCardFuzzy tries 5 tiers: exact, front-face, back-face, prefix, substring
    for (let i = 0; i < 5; i++) {
      mockExecute.mockResolvedValueOnce({ rows: [] });
    }

    const result = await getCardWinStats(mockClient, { card_name: "Nonexistent" });

    expect(result).toBeNull();
  });

  it("should compute win rate from maindecked seats with match data", async () => {
    // Mock resolveCard
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 42, oracle_id: "gen:bolt", name: "Lightning Bolt", scryfall_json: null }],
    });
    // Mock main query: seats that maindecked + their match results
    mockExecute.mockResolvedValueOnce({
      rows: [
        { draft_id: "tarkir", seat: 1, game_wins: 5, game_losses: 2 },
        { draft_id: "tarkir", seat: 3, game_wins: 3, game_losses: 4 },
        { draft_id: "innistrad", seat: 2, game_wins: 6, game_losses: 1 },
      ],
    });

    const result = await getCardWinStats(mockClient, { card_name: "Lightning Bolt" });

    expect(result).toEqual({
      card_name: "Lightning Bolt",
      times_maindecked: 3,
      game_wins: 14,
      game_losses: 7,
      win_rate: expect.closeTo(0.667, 2),
      drafts_with_data: 2,
    });
  });

  it("should return zero stats when no match data exists", async () => {
    // Mock resolveCard
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 42, oracle_id: "gen:bolt", name: "Lightning Bolt", scryfall_json: null }],
    });
    // Mock main query: no rows (card never maindecked or no matches)
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const result = await getCardWinStats(mockClient, { card_name: "Lightning Bolt" });

    expect(result).toEqual({
      card_name: "Lightning Bolt",
      times_maindecked: 0,
      game_wins: 0,
      game_losses: 0,
      win_rate: 0,
      drafts_with_data: 0,
    });
  });
});
