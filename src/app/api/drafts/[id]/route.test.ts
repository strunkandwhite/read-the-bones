import { describe, it, expect, vi, beforeEach } from "vitest";
import { GET } from "./route";
import { NextRequest } from "next/server";
import * as queries from "@/core/db/queries";

vi.mock("@/core/db/queries");
vi.mock("@/core/db/client", () => ({
  getClient: vi.fn().mockResolvedValue({}),
}));

function makeRequest(id: string) {
  return new NextRequest(new URL(`http://localhost:3000/api/drafts/${id}`));
}

describe("GET /api/drafts/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns draft details", async () => {
    vi.mocked(queries.getDraft).mockResolvedValue({
      draft_id: "tarkir",
      draft_name: "Tarkir",
      draft_date: "2025-06-01",
      num_seats: 10,
      banned_cards: ["Lightning Bolt"],
    });
    const res = await GET(makeRequest("tarkir"), { params: Promise.resolve({ id: "tarkir" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft_id).toBe("tarkir");
  });

  it("returns 404 when draft not found", async () => {
    vi.mocked(queries.getDraft).mockResolvedValue(null);
    const res = await GET(makeRequest("missing"), { params: Promise.resolve({ id: "missing" }) });
    expect(res.status).toBe(404);
  });
});
