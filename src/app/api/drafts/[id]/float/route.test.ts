import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PUT, DELETE } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockGetFloatedCards = vi.fn();
const mockAddFloatedCard = vi.fn();
const mockRemoveFloatedCard = vi.fn();
vi.mock("@/core/db/queries/floatedCards", () => ({
  getFloatedCards: (...args: unknown[]) => mockGetFloatedCards(...args),
  addFloatedCard: (...args: unknown[]) => mockAddFloatedCard(...args),
  removeFloatedCard: (...args: unknown[]) => mockRemoveFloatedCard(...args),
}));

const mockResolveCardId = vi.fn();
vi.mock("@/core/db/queries/cards", () => ({
  resolveCardId: (...args: unknown[]) => mockResolveCardId(...args),
}));

function makeGetRequest(token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/float"), {
    headers: token ? { "X-Seat-Token": token } : {},
  });
}

function makeRequest(method: string, body: unknown, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/float"), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Seat-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("GET /api/drafts/[id]/float", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns floated cards for authenticated seat", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockGetFloatedCards.mockResolvedValueOnce(["Lightning Bolt", "Counterspell"]);

    const res = await GET(makeGetRequest(), { params: Promise.resolve({ id: "test" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cards).toEqual(["Lightning Bolt", "Counterspell"]);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await GET(makeGetRequest(""), { params: Promise.resolve({ id: "test" }) });

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/drafts/[id]/float", () => {
  beforeEach(() => vi.clearAllMocks());

  it("adds a floated card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockResolveCardId.mockResolvedValueOnce(42);
    mockAddFloatedCard.mockResolvedValueOnce(undefined);

    const res = await PUT(makeRequest("PUT", { card_name: "Lightning Bolt" }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockAddFloatedCard).toHaveBeenCalledWith(expect.anything(), "test", 1, "Lightning Bolt");
  });

  it("returns 400 without card_name", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });

    const res = await PUT(makeRequest("PUT", {}), { params: Promise.resolve({ id: "test" }) });

    expect(res.status).toBe(400);
  });

  it("returns 400 when card_name exceeds 200 characters", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });

    const res = await PUT(makeRequest("PUT", { card_name: "A".repeat(201) }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("card_name too long");
  });

  it("returns 400 when card_name is not in the cards table", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockResolveCardId.mockResolvedValueOnce(null); // card not found

    const res = await PUT(makeRequest("PUT", { card_name: "Totally Fake Card" }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/Card not found/);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(makeRequest("PUT", { card_name: "Lightning Bolt" }, ""), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/drafts/[id]/float", () => {
  beforeEach(() => vi.clearAllMocks());

  it("removes a floated card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
    mockRemoveFloatedCard.mockResolvedValueOnce(undefined);

    const res = await DELETE(makeRequest("DELETE", { card_name: "Lightning Bolt" }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(mockRemoveFloatedCard).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      1,
      "Lightning Bolt"
    );
  });

  it("returns 400 without card_name", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });

    const res = await DELETE(makeRequest("DELETE", {}), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when card_name exceeds 200 characters", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });

    const res = await DELETE(makeRequest("DELETE", { card_name: "B".repeat(201) }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("card_name too long");
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await DELETE(makeRequest("DELETE", { card_name: "Lightning Bolt" }, ""), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(401);
  });
});
