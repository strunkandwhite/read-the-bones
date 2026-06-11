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

const mockGetDraft = vi.fn();
vi.mock("@/core/db/queries/drafts", () => ({
  getDraft: (...args: unknown[]) => mockGetDraft(...args),
}));

function makeRequest(body: unknown, ip?: string) {
  return new NextRequest(new URL("http://localhost:3000/api/deck"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/deck", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates snapshot on valid deck state with existing draft", async () => {
    const deckState = { draftId: "draft-1", seat: 1, zones: {}, basicLands: {} };
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockGetDraft.mockResolvedValueOnce({ draft_id: "draft-1" });
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

  it("returns 400 when referenced draftId does not exist in DB", async () => {
    const deckState = { draftId: "nonexistent-draft", seat: 1, zones: {}, basicLands: {} };
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockGetDraft.mockResolvedValueOnce(null); // draft not found

    const res = await POST(makeRequest(deckState));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Draft not found");
  });

  it("returns 500 on server error", async () => {
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockGetDraft.mockResolvedValueOnce({ draft_id: "draft-1" });
    mockCreateSnapshot.mockRejectedValueOnce(new Error("DB error"));

    const res = await POST(makeRequest({ draftId: "draft-1", mainboard: [] }));

    expect(res.status).toBe(500);
  });

  it("returns 429 when rate limit exceeded", async () => {
    mockValidateDeckState.mockReturnValue({ valid: true });
    mockGetDraft.mockResolvedValue({ draft_id: "draft-rl" });
    mockCreateSnapshot.mockResolvedValue({ deckId: "x" });

    // Use a unique IP to avoid interference from other tests
    const ip = "10.0.0.99";

    // Send 10 requests (at the limit)
    for (let i = 0; i < 10; i++) {
      await POST(makeRequest({ draftId: "draft-rl", seat: 1 }, ip));
    }

    // 11th should be rate-limited
    const res = await POST(makeRequest({ draftId: "draft-rl", seat: 1 }, ip));
    const body = await res.json();

    expect(res.status).toBe(429);
    expect(body.error).toBe("Too many requests");
  });
});
