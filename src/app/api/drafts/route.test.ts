import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL("http://localhost:3000/api/drafts");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

describe("GET /api/drafts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls listDrafts with no filters", async () => {
    vi.mocked(queries.listDrafts).mockResolvedValue([]);
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    expect(queries.listDrafts).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("passes date and name filters", async () => {
    vi.mocked(queries.listDrafts).mockResolvedValue([]);
    const res = await GET(
      makeRequest({
        date_from: "2025-01-01",
        date_to: "2025-12-31",
        draft_name: "tarkir",
      })
    );
    expect(res.status).toBe(200);
    expect(queries.listDrafts).toHaveBeenCalledWith(expect.anything(), {
      date_from: "2025-01-01",
      date_to: "2025-12-31",
      draft_name: "tarkir",
    });
  });
});
