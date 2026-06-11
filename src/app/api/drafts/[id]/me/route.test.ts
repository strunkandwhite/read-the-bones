import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({})),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

function makeRequest(url: string, headers?: Record<string, string>) {
  return new NextRequest(new URL(url, "http://localhost:3000"), { headers });
}

describe("GET /api/drafts/[id]/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns seat, autoPick, and displayName for valid token", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({
      seat: 3,
      autoPick: true,
      displayName: "Alice",
    });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "valid-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ seat: 3, autoPick: true, displayName: "Alice" });
    expect(mockAuthenticateSeat).toHaveBeenCalledWith(
      expect.anything(),
      req,
      "test-draft",
    );
  });

  it("returns 401 for missing token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const req = makeRequest("http://localhost:3000/api/drafts/test-draft/me");
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Invalid seat token"));

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "bad-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("returns 401 when token belongs to different draft", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Token does not match draft"));

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "wrong-draft-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("handles null displayName", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({
      seat: 5,
      autoPick: false,
      displayName: null,
    });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "valid-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ seat: 5, autoPick: false, displayName: null });
  });
});
