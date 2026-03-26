import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";

// Mock getClient
const mockExecute = vi.fn();
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: mockExecute })),
}));

function makeRequest(url: string, headers?: Record<string, string>) {
  return new NextRequest(new URL(url, "http://localhost:3000"), { headers });
}

describe("GET /api/drafts/[id]/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns seat for valid token", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ seat: 3, auto_pick: 1, display_name: "Alice", draft_id: "test-draft" }],
    });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "valid-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ seat: 3, autoPick: true, displayName: "Alice" });
  });

  it("returns 401 for missing token", async () => {
    const req = makeRequest("http://localhost:3000/api/drafts/test-draft/me");
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("returns 401 for invalid token", async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "bad-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("returns 401 when token belongs to different draft", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ seat: 1, auto_pick: 0, display_name: null, draft_id: "other-draft" }],
    });

    const req = makeRequest(
      "http://localhost:3000/api/drafts/test-draft/me",
      { "X-Seat-Token": "wrong-draft-token" },
    );
    const res = await GET(req, { params: Promise.resolve({ id: "test-draft" }) });

    expect(res.status).toBe(401);
  });

  it("handles null display_name", async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ seat: 5, auto_pick: 0, display_name: null, draft_id: "test-draft" }],
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
