import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/core/getCards", () => ({
  getCards: vi.fn().mockResolvedValue({ cards: [], drafts: [] }),
}));

import { GET } from "./route";
import { getCards } from "@/core/getCards";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/cards", () => {
  it("parses comma-separated draft IDs from query param", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/cards?drafts=draft-1,draft-2"),
    );
    await GET(req);

    expect(getCards).toHaveBeenCalledWith({
      draftIds: ["draft-1", "draft-2"],
      activeDraft: undefined,
      poolAsOfDraft: undefined,
    });
  });

  it("passes activeDraft and poolAsOfDraft params", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/cards?activeDraft=active-1&poolAsOfDraft=pool-1"),
    );
    await GET(req);

    expect(getCards).toHaveBeenCalledWith({
      draftIds: undefined,
      activeDraft: "active-1",
      poolAsOfDraft: "pool-1",
    });
  });

  it("sets long cache-control when no activeDraft", async () => {
    const req = new NextRequest(
      new URL("http://localhost:3000/api/cards?drafts=draft-1"),
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=31536000, stale-while-revalidate=60",
    );
  });

  it("sets long cache-control even when activeDraft is present (taken state is now client-derived from board.picks)", async () => {
    // Previously activeDraft triggered no-store because takenCards changed per pick.
    // Now the client derives taken state from board.picks, so the payload only
    // changes on ingestion — same long-cache policy applies to both paths.
    const req = new NextRequest(
      new URL("http://localhost:3000/api/cards?activeDraft=active-1"),
    );
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(
      "public, s-maxage=31536000, stale-while-revalidate=60",
    );
  });

  it("returns 500 on error", async () => {
    vi.mocked(getCards).mockRejectedValueOnce(new Error("DB error"));

    const req = new NextRequest(
      new URL("http://localhost:3000/api/cards"),
    );
    const res = await GET(req);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Failed to load card data");
  });
});
