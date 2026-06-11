import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock getDraftStats with the REAL response shape: winRateBySeat, winRateByColor, ingestionHash.
// (The previous version used { seatWinRates: [], colorWinRates: [] } — a shape the real
// function never produces — which meant toHaveProperty("seatWinRates") asserted a nonexistent
// contract. The sibling /api/stats route test already used the correct shape.)
vi.mock("@/core/getDraftStats", () => ({
  getDraftStats: vi.fn().mockResolvedValue({
    winRateBySeat: [],
    winRateByColor: [],
    ingestionHash: "abc123def456abcd",
  }),
}));

import { GET } from "./route";
import { getDraftStats } from "@/core/getDraftStats";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/draft-stats", () => {
  it("calls getDraftStats with parsed draft IDs", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/draft-stats?drafts=d1,d2"),
    );
    await GET(req);

    expect(getDraftStats).toHaveBeenCalledWith({ draftIds: ["d1", "d2"] });
  });

  it("passes undefined draftIds when no drafts param", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/draft-stats"),
    );
    await GET(req);

    expect(getDraftStats).toHaveBeenCalledWith({ draftIds: undefined });
  });

  it("returns JSON response with the real getDraftStats shape and cache headers", async () => {
    vi.mocked(getDraftStats).mockResolvedValueOnce({
      winRateBySeat: [
        { seat: 1, wins: 5, losses: 3, winRate: 0.625, ciLower: 0.3, ciUpper: 0.9 },
      ],
      winRateByColor: [
        { color: "UB", wins: 4, losses: 2, winRate: 0.667, ciLower: 0.3, ciUpper: 0.9 },
      ],
      ingestionHash: "abc123def456abcd",
    });

    const req = new NextRequest(
      new URL("http://localhost:3000/api/draft-stats"),
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=31536000, stale-while-revalidate=60",
    );

    const body = await res.json();
    // Assert the REAL shape the route passes through from getDraftStats
    expect(body).toHaveProperty("winRateBySeat");
    expect(body).toHaveProperty("winRateByColor");
    expect(body).toHaveProperty("ingestionHash");
    // The route is a passthrough — the mocked data must appear verbatim
    expect(body.winRateBySeat[0].seat).toBe(1);
    expect(body.winRateByColor[0].color).toBe("UB");
    expect(body.ingestionHash).toBe("abc123def456abcd");
  });

  it("returns 500 on error", async () => {
    vi.mocked(getDraftStats).mockRejectedValueOnce(new Error("fail"));

    const req = new NextRequest(
      new URL("http://localhost:3000/api/draft-stats"),
    );
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to load draft stats");
  });
});
