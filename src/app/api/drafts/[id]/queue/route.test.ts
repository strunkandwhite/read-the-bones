import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET, PUT } from "./route";
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

const mockGetQueue = vi.fn();
const mockSetQueue = vi.fn();
vi.mock("@/core/db/queries/pickQueue", () => ({
  getQueue: (...args: unknown[]) => mockGetQueue(...args),
  setQueue: (...args: unknown[]) => mockSetQueue(...args),
}));

function makeGetRequest(token = "test-token") {
  return new NextRequest(
    new URL("http://localhost:3000/api/drafts/test/queue"),
    { headers: token ? { "X-Seat-Token": token } : {} },
  );
}

function makePutRequest(body: unknown, token = "test-token") {
  return new NextRequest(
    new URL("http://localhost:3000/api/drafts/test/queue"),
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "X-Seat-Token": token } : {}),
      },
      body: JSON.stringify(body),
    },
  );
}

describe("GET /api/drafts/[id]/queue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns queue for authenticated seat", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockGetQueue.mockResolvedValueOnce([
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ]);

    const res = await GET(
      makeGetRequest(),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queue).toHaveLength(2);
    expect(body.queue[0].cardName).toBe("Lightning Bolt");
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await GET(
      makeGetRequest(""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });
});

describe("PUT /api/drafts/[id]/queue", () => {
  beforeEach(() => vi.clearAllMocks());

  it("replaces queue and returns updated queue", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    mockSetQueue.mockResolvedValueOnce(undefined);
    mockGetQueue.mockResolvedValueOnce([
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
    ]);

    const res = await PUT(
      makePutRequest([
        { card_name: "Lightning Bolt" },
        { card_name: "Counterspell" },
      ]),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queue).toHaveLength(2);
  });

  it("returns 400 for unknown card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await PUT(
      makePutRequest([{ card_name: "Not Real" }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(
      makePutRequest([{ card_name: "Lightning Bolt" }], ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });
});
