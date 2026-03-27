import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PUT } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockGetWipDeck = vi.fn();
const mockUpsertWipDeck = vi.fn();
vi.mock("@/core/db/queries/decks", () => ({
  getWipDeck: (...args: unknown[]) => mockGetWipDeck(...args),
  upsertWipDeck: (...args: unknown[]) => mockUpsertWipDeck(...args),
}));

const mockValidateDeckState = vi.fn();
vi.mock("@/core/validateDeckState", () => ({
  validateDeckState: (...args: unknown[]) => mockValidateDeckState(...args),
}));

function makeGetRequest(token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/deck-state"), {
    method: "GET",
    headers: { "X-Seat-Token": token },
  });
}

function makePutRequest(body: unknown, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/deck-state"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Seat-Token": token,
    },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: "test" }) };

describe("GET /api/drafts/[id]/deck-state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns deck state on success", async () => {
    const deckState = { mainboard: ["Lightning Bolt"], sideboard: [] };
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockGetWipDeck.mockResolvedValueOnce({ deckState });

    const res = await GET(makeGetRequest(), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual(deckState);
  });

  it("returns 404 when no WIP deck exists", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockGetWipDeck.mockResolvedValueOnce(null);

    const res = await GET(makeGetRequest(), params);

    expect(res.status).toBe(404);
  });

  it("returns 401 on invalid token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await GET(makeGetRequest(""), params);

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/drafts/[id]/deck-state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves valid deck state", async () => {
    const deckState = { mainboard: ["Lightning Bolt"], sideboard: [] };
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockValidateDeckState.mockReturnValueOnce({ valid: true });
    mockUpsertWipDeck.mockResolvedValueOnce(undefined);

    const res = await PUT(makePutRequest(deckState), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(mockUpsertWipDeck).toHaveBeenCalled();
  });

  it("returns 400 on invalid deck state", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockValidateDeckState.mockReturnValueOnce({ valid: false });

    const res = await PUT(makePutRequest({ bad: "data" }), params);

    expect(res.status).toBe(400);
  });

  it("returns 401 on invalid token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(makePutRequest({ mainboard: [] }), params);

    expect(res.status).toBe(401);
  });
});
