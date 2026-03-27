import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockCreateSnapshot = vi.fn();
vi.mock("@/core/db/queries/decks", () => ({
  createSnapshot: (...args: unknown[]) => mockCreateSnapshot(...args),
}));

const mockValidateDeckState = vi.fn();
vi.mock("@/core/validateDeckState", () => ({
  validateDeckState: (...args: unknown[]) => mockValidateDeckState(...args),
}));

function makeRequest(body: unknown) {
  return new NextRequest(new URL("http://localhost:3000/api/deck"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/deck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates snapshot on valid deck state", async () => {
    const deckState = { mainboard: ["Lightning Bolt"], sideboard: [] };
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockCreateSnapshot.mockResolvedValueOnce({ deckId: "abc123" });

    const res = await POST(makeRequest(deckState));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deckId).toBe("abc123");
  });

  it("returns 400 on invalid deck state", async () => {
    mockValidateDeckState.mockReturnValueOnce({ valid: false });

    const res = await POST(makeRequest({ bad: "data" }));

    expect(res.status).toBe(400);
  });

  it("returns 500 on server error", async () => {
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockCreateSnapshot.mockRejectedValueOnce(new Error("DB error"));

    const res = await POST(makeRequest({ mainboard: [] }));

    expect(res.status).toBe(500);
  });
});
