import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/core/getDraftStats", () => ({
  getDraftStats: vi.fn().mockResolvedValue({ seatWinRates: [], colorWinRates: [] }),
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

  it("returns JSON response with cache headers", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/draft-stats"),
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=31536000, stale-while-revalidate=60",
    );
    const body = await res.json();
    expect(body).toHaveProperty("seatWinRates");
    expect(body).toHaveProperty("colorWinRates");
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
