import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockGetSnapshot = vi.fn();
vi.mock("@/core/db/queries/decks", () => ({
  getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
}));

function makeRequest() {
  return new NextRequest(new URL("http://localhost:3000/api/deck/abc123"), {
    method: "GET",
  });
}

const params = { params: Promise.resolve({ id: "abc123" }) };

describe("GET /api/deck/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns deck on success", async () => {
    const deckState = { mainboard: ["Lightning Bolt"], sideboard: [] };
    mockGetSnapshot.mockResolvedValueOnce({ deckState });

    const res = await GET(makeRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(deckState);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("returns 404 when not found", async () => {
    mockGetSnapshot.mockResolvedValueOnce(null);

    const res = await GET(makeRequest(), params);

    expect(res.status).toBe(404);
  });
});
