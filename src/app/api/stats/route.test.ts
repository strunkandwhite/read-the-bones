import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as getDraftStatsModule from "@/core/getDraftStats";

vi.mock("@/core/getDraftStats");

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/stats");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/stats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns overall stats with individual color breakdown", async () => {
    vi.mocked(getDraftStatsModule.getDraftStats).mockResolvedValue({
      winRateBySeat: [],
      winRateByColor: [
        { color: "RW", wins: 10, losses: 5, winRate: 0.667, ciLower: 0.4, ciUpper: 0.85 },
      ],
      ingestionHash: "abc",
    });
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.winRateByIndividualColor).toBeDefined();
    expect(body.winRateByColorPair).toBeDefined();
    expect(body.winRateBySeat).toBeDefined();
  });

  it("passes draft_ids filter", async () => {
    vi.mocked(getDraftStatsModule.getDraftStats).mockResolvedValue({
      winRateBySeat: [],
      winRateByColor: [],
      ingestionHash: "abc",
    });
    await GET(makeRequest({ draft_ids: "tarkir,birds" }));
    expect(getDraftStatsModule.getDraftStats).toHaveBeenCalledWith({
      draftIds: ["tarkir", "birds"],
    });
  });
});
