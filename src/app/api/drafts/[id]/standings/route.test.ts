import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");

describe("GET /api/drafts/[id]/standings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns standings for a draft", async () => {
    vi.mocked(queries.getStandings).mockResolvedValue({ standings: [] });
    const res = await GET(
      new NextRequest(new URL("http://localhost:3000/api/drafts/tarkir/standings")),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(200);
    expect(queries.getStandings).toHaveBeenCalledWith("tarkir");
    const body = await res.json();
    expect(body).toHaveProperty("standings");
    expect(Array.isArray(body.standings)).toBe(true);
  });

  it("returns 500 when query throws", async () => {
    vi.mocked(queries.getStandings).mockRejectedValueOnce(new Error("DB error"));
    const res = await GET(
      new NextRequest(new URL("http://localhost:3000/api/drafts/tarkir/standings")),
      { params: Promise.resolve({ id: "tarkir" }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty("error");
  });
});
