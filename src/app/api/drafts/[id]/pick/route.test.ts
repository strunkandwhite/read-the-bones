import { describe, it, expect, vi, beforeEach } from "vitest";
import { POST } from "./route";
import { NextRequest } from "next/server";
import { AuthError, ConflictError, ValidationError } from "@/core/errors";

vi.mock("@/core/db/client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

const mockAuthenticateSeat = vi.fn();
vi.mock("@/core/tokenAuth", () => ({
  authenticateSeat: (...args: unknown[]) => mockAuthenticateSeat(...args),
}));

const mockProcessPick = vi.fn();
const mockTriggerAutoPickOnDemand = vi.fn();
vi.mock("@/core/processPick", () => ({
  processPick: (...args: unknown[]) => mockProcessPick(...args),
  triggerAutoPickOnDemand: (...args: unknown[]) => mockTriggerAutoPickOnDemand(...args),
}));

const mockResolveCardId = vi.fn();
vi.mock("@/core/db/queries/cards", () => ({
  resolveCardId: (...args: unknown[]) => mockResolveCardId(...args),
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
    mockResolveCardId.mockResolvedValueOnce(42);
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
    mockResolveCardId.mockResolvedValueOnce(null);

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
    mockResolveCardId.mockResolvedValueOnce(42);
    mockProcessPick.mockRejectedValueOnce(new ConflictError("Conflict: pick already made"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(409);
  });

  it("returns 400 when not your turn", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockResolveCardId.mockResolvedValueOnce(42);
    mockProcessPick.mockRejectedValueOnce(new ValidationError("Not your turn"));

    const res = await POST(
      makeRequest({ card_name: "Lightning Bolt" }),
      { params: Promise.resolve({ id: "test" }) },
    );

    expect(res.status).toBe(400);
  });

  // ---------------------------------------------------------------------------
  // auto: true path — delegates to triggerAutoPickOnDemand
  // ---------------------------------------------------------------------------

  describe("auto: true", () => {
    it("calls triggerAutoPickOnDemand and returns the result", async () => {
      mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3 });
      mockTriggerAutoPickOnDemand.mockResolvedValueOnce({
        pickedCard: { pickN: 5, cardId: 77, cardName: "Lightning Bolt" },
        autoPickDisabled: false,
        phaseChanged: false,
        newPhase: null,
      });

      const res = await POST(
        makeRequest({ auto: true }),
        { params: Promise.resolve({ id: "draft-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(mockTriggerAutoPickOnDemand).toHaveBeenCalledWith(
        expect.anything(), "draft-1", 3,
      );
      expect(mockProcessPick).not.toHaveBeenCalled();
      expect(mockResolveCardId).not.toHaveBeenCalled();
      expect(body.pickedCard.cardName).toBe("Lightning Bolt");
    });

    it("returns autoPickDisabled: true when pause-mode exhausted queue", async () => {
      mockAuthenticateSeat.mockResolvedValueOnce({ seat: 2 });
      mockTriggerAutoPickOnDemand.mockResolvedValueOnce({
        pickedCard: null,
        autoPickDisabled: true,
        phaseChanged: false,
        newPhase: null,
      });

      const res = await POST(
        makeRequest({ auto: true }),
        { params: Promise.resolve({ id: "draft-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.pickedCard).toBeNull();
      expect(body.autoPickDisabled).toBe(true);
    });

    it("returns 409 on conflict (cascade already fired)", async () => {
      mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
      mockTriggerAutoPickOnDemand.mockRejectedValueOnce(
        new ConflictError("Conflict: pick_n already exists — retry"),
      );

      const res = await POST(
        makeRequest({ auto: true }),
        { params: Promise.resolve({ id: "draft-1" }) },
      );

      expect(res.status).toBe(409);
    });

    it("returns 400 when it is not this seat's turn", async () => {
      mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1 });
      mockTriggerAutoPickOnDemand.mockRejectedValueOnce(
        new ValidationError("It's seat 3's turn, not seat 1's"),
      );

      const res = await POST(
        makeRequest({ auto: true }),
        { params: Promise.resolve({ id: "draft-1" }) },
      );

      expect(res.status).toBe(400);
    });

    it("returns 200 with null pickedCard when queue is empty (flow-through exhausted)", async () => {
      mockAuthenticateSeat.mockResolvedValueOnce({ seat: 4 });
      mockTriggerAutoPickOnDemand.mockResolvedValueOnce({
        pickedCard: null,
        autoPickDisabled: false,
        phaseChanged: false,
        newPhase: null,
      });

      const res = await POST(
        makeRequest({ auto: true }),
        { params: Promise.resolve({ id: "draft-1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.pickedCard).toBeNull();
      expect(body.autoPickDisabled).toBe(false);
    });
  });
});
