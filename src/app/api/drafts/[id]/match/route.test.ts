import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST, DELETE } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() =>
    Promise.resolve({ execute: (...args: unknown[]) => mockExecute(...args) })
  ),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockReportMatchResult = vi.fn();
const mockDeleteMatchResult = vi.fn();
vi.mock("@/core/db/queries/matches", () => ({
  reportMatchResult: (...args: unknown[]) => mockReportMatchResult(...args),
  deleteMatchResult: (...args: unknown[]) => mockDeleteMatchResult(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/match"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Seat-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

function makeDeleteRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/match"), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Seat-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Mock the draft query to return a given phase and num_seats */
function mockDraft(phase: string | null, numSeats: number | null = 10) {
  if (phase === null) {
    mockExecute.mockResolvedValueOnce({ rows: [] });
  } else {
    mockExecute.mockResolvedValueOnce({ rows: [{ phase, num_seats: numSeats }] });
  }
}

describe("POST /api/drafts/[id]/match", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves match result and returns normalized seats", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockDraft("playing");
    mockReportMatchResult.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest({ opponent_seat: 1, wins: 2, losses: 1 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.seat1).toBe(1);
    expect(body.seat2).toBe(3);
    expect(body.seat1Wins).toBe(1);
    expect(body.seat2Wins).toBe(2);
    expect(mockReportMatchResult).toHaveBeenCalledWith(expect.anything(), "test", 1, 3, 1, 2, 3);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await POST(makeRequest({ opponent_seat: 1, wins: 2, losses: 0 }, ""), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for missing fields", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(makeRequest({ opponent_seat: 2 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when reporting match against yourself", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await POST(makeRequest({ opponent_seat: 1, wins: 2, losses: 0 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("yourself");
  });

  it("returns 400 when draft is in wrong phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("drafting");

    const res = await POST(makeRequest({ opponent_seat: 2, wins: 2, losses: 1 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("drafting");
  });

  it("returns 404 when draft not found", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft(null);

    const res = await POST(makeRequest({ opponent_seat: 2, wins: 2, losses: 1 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(404);
  });

  it("allows match reporting in complete phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("complete");
    mockReportMatchResult.mockResolvedValueOnce(undefined);

    const res = await POST(makeRequest({ opponent_seat: 2, wins: 2, losses: 0 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(200);
  });

  it("returns 400 when opponent_seat exceeds num_seats", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("playing", 8);

    const res = await POST(makeRequest({ opponent_seat: 999, wins: 2, losses: 0 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("8");
  });
});

describe("DELETE /api/drafts/[id]/match", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the match using normalized seats", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockDraft("playing");
    mockDeleteMatchResult.mockResolvedValueOnce(true);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 1 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, seat1: 1, seat2: 3, deleted: true });
    expect(mockDeleteMatchResult).toHaveBeenCalledWith(expect.anything(), "test", 1, 3);
  });

  it("allows deletion in the complete phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 2, autoPick: false });
    mockDraft("complete");
    mockDeleteMatchResult.mockResolvedValueOnce(true);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 5 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(200);
    expect(mockDeleteMatchResult).toHaveBeenCalledWith(expect.anything(), "test", 2, 5);
  });

  it("reports deleted:false when the pairing had no result", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockDraft("playing");
    mockDeleteMatchResult.mockResolvedValueOnce(false);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 4 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toBe(false);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 1 }, ""), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(401);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat is missing", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await DELETE(makeDeleteRequest({}), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat is not an integer", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2.5 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when deleting a match against yourself", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 4, autoPick: false });

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 4 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 404 when the draft does not exist", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft(null);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 in a non-playing phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("drafting");

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("drafting");
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat exceeds the pod size", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("playing", 8);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 9 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });
});
