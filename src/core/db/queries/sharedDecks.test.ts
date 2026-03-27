import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../client", () => ({ getClient: vi.fn() }));

import { getClient } from "../client";
import { createSharedDeck, getSharedDeck } from "./sharedDecks";

const mockGetClient = vi.mocked(getClient);

function createMockClient() {
  return { execute: vi.fn() };
}

describe("createSharedDeck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("inserts deck state and returns the deck ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
    mockClient.execute.mockResolvedValue({ rows: [] });

    const deckState = {
      draftId: "tarkir",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };

    const result = await createSharedDeck(deckState);

    expect(result.deckId).toBeDefined();
    expect(typeof result.deckId).toBe("string");
    expect(result.deckId.length).toBe(8);
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT INTO shared_decks"),
        args: [result.deckId, "tarkir", 3, JSON.stringify(deckState)],
      })
    );
  });
});

describe("getSharedDeck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns deck state for a valid ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);

    const deckState = {
      draftId: "tarkir",
      seat: 3,
      zones: { deck: {}, sideboard: {} },
      basicLands: { Plains: 0, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
    };

    mockClient.execute.mockResolvedValue({
      rows: [{
        deck_id: "abc12345",
        draft_id: "tarkir",
        seat: 3,
        deck_state: JSON.stringify(deckState),
        created_at: "2026-03-20T00:00:00",
      }],
    });

    const result = await getSharedDeck("abc12345");
    expect(result).not.toBeNull();
    expect(result!.deckId).toBe("abc12345");
    expect(result!.draftId).toBe("tarkir");
    expect(result!.seat).toBe(3);
    expect(result!.deckState.draftId).toBe("tarkir");
    expect(result!.deckState.seat).toBe(3);
    expect(result!.createdAt).toBe("2026-03-20T00:00:00");
  });

  it("returns null for unknown ID", async () => {
    const mockClient = createMockClient();
    mockGetClient.mockResolvedValue(mockClient as never);
    mockClient.execute.mockResolvedValue({ rows: [] });

    const result = await getSharedDeck("nonexistent");
    expect(result).toBeNull();
  });
});
