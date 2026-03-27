import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { AuthError, ConflictError, ValidationError } from "@/core/errors";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockProcessPick = vi.fn();
vi.mock("@/core/processPick", () => ({
  processPick: (...args: unknown[]) => mockProcessPick(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/pick"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Seat-Token": token,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/drafts/[id]/pick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns picks on success", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });
    mockProcessPick.mockResolvedValueOnce({
      picks: [{ pickN: 1, seat: 1, cardName: "Lightning Bolt" }],
    });

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.picks).toHaveLength(1);
    expect(body.picks[0].cardName).toBe("Lightning Bolt");
  });

  it("returns 400 for missing card_name", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(
      makeRequest({}),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown card", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const res = await POST(
      makeRequest({ card_name: "Not A Real Card" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  it("returns 401 when authentication fails", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }, ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("returns 409 on conflict", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });
    mockProcessPick.mockRejectedValueOnce(new ConflictError("Conflict: pick already made"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 when not your turn", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockExecute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });
    mockProcessPick.mockRejectedValueOnce(new ValidationError("Not your turn"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });
});
