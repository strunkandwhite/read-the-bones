import { describe, it, expect, vi, beforeEach } from "vitest";
import { PUT } from "./route";
import { NextRequest } from "next/server";
import { AuthError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockUpdateAutoPick = vi.fn();
const mockUpdateDisplayName = vi.fn();
const mockGetSeatSettings = vi.fn();
vi.mock("@/core/db/queries/seatTokens", () => ({
  updateAutoPick: (...args: unknown[]) => mockUpdateAutoPick(...args),
  updateDisplayName: (...args: unknown[]) => mockUpdateDisplayName(...args),
  getSeatSettings: (...args: unknown[]) => mockGetSeatSettings(...args),
}));

function makeRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(
    new URL("http://localhost:3000/api/drafts/test/seat-settings"),
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

describe("PUT /api/drafts/[id]/seat-settings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates auto_pick and returns settings", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 2, autoPick: false });
    mockUpdateAutoPick.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: true, displayName: "Bob" });

    const res = await PUT(
      makeRequest({ auto_pick: true }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.seat).toBe(2);
    expect(body.autoPick).toBe(true);
    expect(body.displayName).toBe("Bob");
    expect(mockUpdateAutoPick).toHaveBeenCalledOnce();
  });

  it("updates display_name and returns settings", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: false, displayName: "Alice" });

    const res = await PUT(
      makeRequest({ display_name: "Alice" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.displayName).toBe("Alice");
    expect(mockUpdateDisplayName).toHaveBeenCalledOnce();
    expect(mockUpdateAutoPick).not.toHaveBeenCalled();
  });

  it("clears display_name when empty string is sent", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: false, displayName: null });

    const res = await PUT(
      makeRequest({ display_name: "" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.displayName).toBeNull();
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await PUT(
      makeRequest({ auto_pick: true }, ""),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(401);
  });

  it("updates both auto_pick and display_name together", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockUpdateAutoPick.mockResolvedValueOnce(undefined);
    mockUpdateDisplayName.mockResolvedValueOnce(undefined);
    mockGetSeatSettings.mockResolvedValueOnce({ autoPick: true, displayName: "Charlie" });

    const res = await PUT(
      makeRequest({ auto_pick: true, display_name: "Charlie" }),
      { params: Promise.resolve({ id: "test" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.autoPick).toBe(true);
    expect(body.displayName).toBe("Charlie");
    expect(mockUpdateAutoPick).toHaveBeenCalledOnce();
    expect(mockUpdateDisplayName).toHaveBeenCalledOnce();
  });
});
