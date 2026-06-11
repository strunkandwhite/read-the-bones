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

const mockGetRemainingCopies = vi.fn();
vi.mock("@/core/db/queries/helpers", () => ({
  getRemainingCopies: (...args: unknown[]) => mockGetRemainingCopies(...args),
  placeholders: (n: number) => Array(n).fill("?").join(", "),
}));

const mockAddFloatedCards = vi.fn();
const mockRemoveFloatedCards = vi.fn();
vi.mock("@/core/db/queries/floatedCards", () => ({
  addFloatedCards: (...args: unknown[]) => mockAddFloatedCards(...args),
  removeFloatedCards: (...args: unknown[]) => mockRemoveFloatedCards(...args),
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
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "pause", cards: [{ id: 20, name: "Counterspell" }] },
    ]);

    const res = await GET(
      makeGetRequest(),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queue).toHaveLength(2);
    expect(body.queue[0].cards[0].name).toBe("Lightning Bolt");
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
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all cards have ample remaining copies
    mockGetRemainingCopies.mockResolvedValue(new Map([[10, 4], [20, 4], [30, 4], [99, 4]]));
    mockAddFloatedCards.mockResolvedValue(undefined);
    mockRemoveFloatedCards.mockResolvedValue(undefined);
  });

  it("replaces queue with structured entries and returns updated queue", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    // First getQueue call: old queue (before set)
    mockGetQueue.mockResolvedValueOnce([]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    // Second getQueue call: new queue (after set)
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Counterspell" }] },
    ]);

    const res = await PUT(
      makePutRequest([
        { mode: "pause", cards: ["Lightning Bolt"] },
        { mode: "flow-through", cards: ["Counterspell"] },
      ]),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.queue).toHaveLength(2);
  });

  it("accepts object-style card entries { cardName }", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    mockGetQueue.mockResolvedValueOnce([]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
    ]);

    const res = await PUT(
      makePutRequest([
        { mode: "pause", cards: [{ cardName: "Lightning Bolt" }] },
      ]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
  });

  it("defaults mode to pause when omitted", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    mockGetQueue.mockResolvedValueOnce([]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
    ]);

    const res = await PUT(
      makePutRequest([{ cards: ["Lightning Bolt"] }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
    expect(mockSetQueue).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      1,
      [{ mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] }],
    );
  });

  it("returns 400 for invalid mode", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });

    const res = await PUT(
      makePutRequest([{ mode: "invalid", cards: ["Lightning Bolt"] }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for entry missing cards array", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });

    const res = await PUT(
      makePutRequest([{ mode: "pause" }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await PUT(
      makePutRequest([{ mode: "pause", cards: ["Not Real"] }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(
      makePutRequest([{ mode: "pause", cards: ["Lightning Bolt"] }], ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("auto-floats cards removed from queue via addFloatedCards", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 20, name: "Counterspell" }],
    });
    // Old queue had Lightning Bolt and Counterspell
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "pause", cards: [{ id: 20, name: "Counterspell" }] },
    ]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    // New queue only has Counterspell
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 20, name: "Counterspell" }] },
    ]);

    const res = await PUT(
      makePutRequest([{ mode: "pause", cards: ["Counterspell"] }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
    // Lightning Bolt was removed, so it should be auto-floated
    expect(mockAddFloatedCards).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      1,
      ["Lightning Bolt"],
    );
  });

  it("auto-unfloats cards added to queue via removeFloatedCards", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [
        { card_id: 10, name: "Lightning Bolt" },
        { card_id: 20, name: "Counterspell" },
      ],
    });
    // Old queue had only Lightning Bolt
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
    ]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    // New queue has both
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "pause", cards: [{ id: 20, name: "Counterspell" }] },
    ]);

    const res = await PUT(
      makePutRequest([
        { mode: "pause", cards: ["Lightning Bolt"] },
        { mode: "pause", cards: ["Counterspell"] },
      ]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
    // Counterspell was added, so it should be auto-unfloated
    expect(mockRemoveFloatedCards).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      1,
      ["Counterspell"],
    );
  });

  it("returns 400 when queued count exceeds remaining copies", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    // Only 1 copy remaining
    mockGetRemainingCopies.mockResolvedValueOnce(new Map([[10, 1]]));

    const res = await PUT(
      makePutRequest([
        { mode: "pause", cards: ["Lightning Bolt"] },
        { mode: "pause", cards: ["Lightning Bolt"] },
      ]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Lightning Bolt/);
  });

  it("returns 400 when card is not in the cube (0 remaining)", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockExecute.mockResolvedValueOnce({
      rows: [{ card_id: 10, name: "Lightning Bolt" }],
    });
    // Card not found in cube snapshot — returns empty map
    mockGetRemainingCopies.mockResolvedValueOnce(new Map());

    const res = await PUT(
      makePutRequest([{ mode: "pause", cards: ["Lightning Bolt"] }]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/0 remaining/);
  });

  it("accepts an empty queue array (clears the queue)", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false, displayName: null });
    mockGetQueue.mockResolvedValueOnce([
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
    ]);
    mockSetQueue.mockResolvedValueOnce(undefined);
    mockGetQueue.mockResolvedValueOnce([]);

    const res = await PUT(
      makePutRequest([]),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queue).toHaveLength(0);
    expect(mockSetQueue).toHaveBeenCalledWith(expect.anything(), "test", 1, []);
    // Clearing the queue auto-floats the removed card
    expect(mockAddFloatedCards).toHaveBeenCalledWith(
      expect.anything(),
      "test",
      1,
      ["Lightning Bolt"],
    );
  });
});
