import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getPickHistory } from "./pickHistory";

function createMockClient() {
  return {
    execute: vi.fn(),
  } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

describe("getPickHistory", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    client = createMockClient();
  });

  it("returns per-draft pick positions ordered by date", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "d1", draft_name: "Tarkir", draft_date: "2026-01-15", num_seats: 10, pick_n: 12, pool_size: 540 },
        { draft_id: "d2", draft_name: "Innistrad", draft_date: "2026-02-01", num_seats: 10, pick_n: 5, pool_size: 540 },
      ],
    });

    const result = await getPickHistory(client, "Lightning Bolt");
    expect(result.pickHistory).toEqual([
      { draftId: "d1", draftName: "Tarkir", draftDate: "2026-01-15", pickPosition: 12, picked: true, numSeats: 10 },
      { draftId: "d2", draftName: "Innistrad", draftDate: "2026-02-01", pickPosition: 5, picked: true, numSeats: 10 },
    ]);
  });

  it("marks unpicked cards with poolSize as position", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "d1", draft_name: "Tarkir", draft_date: "2026-01-15", num_seats: 10, pick_n: null, pool_size: 540 },
      ],
    });

    const result = await getPickHistory(client, "Unplayed Card");
    expect(result.pickHistory[0].picked).toBe(false);
    expect(result.pickHistory[0].pickPosition).toBe(540);
  });

  it("computes 15-bucket pick distribution", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "d1", draft_name: "A", draft_date: "2026-01-01", num_seats: 10, pick_n: 5, pool_size: 540 },
        { draft_id: "d2", draft_name: "B", draft_date: "2026-01-02", num_seats: 10, pick_n: 35, pool_size: 540 },
        { draft_id: "d3", draft_name: "C", draft_date: "2026-01-03", num_seats: 10, pick_n: 8, pool_size: 540 },
      ],
    });

    const result = await getPickHistory(client, "Some Card");
    expect(result.pickDistribution).toHaveLength(15);
    // Bucket 0 (picks 1-30): 2 entries (pick 5, pick 8)
    expect(result.pickDistribution[0]).toBe(2);
    // Bucket 1 (picks 31-60): 1 entry (pick 35)
    expect(result.pickDistribution[1]).toBe(1);
  });

  it("returns empty results for card with no history", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });
    const result = await getPickHistory(client, "Unknown Card");
    expect(result.pickHistory).toEqual([]);
    expect(result.pickDistribution).toEqual(Array(15).fill(0));
  });

  it("accepts optional draftId filter", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    await getPickHistory(client, "Lightning Bolt", "draft-1");

    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("d.draft_id = ?");
    expect(call.args).toContain("draft-1");
  });

  it("clamps high pick positions to the last bucket", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { draft_id: "d1", draft_name: "A", draft_date: "2026-01-01", num_seats: 10, pick_n: null, pool_size: 540 },
      ],
    });

    const result = await getPickHistory(client, "Unpicked Card");
    // Unpicked: pickPosition = 540, bucket = floor((540-1)/30) = 17, clamped to 14
    expect(result.pickDistribution[14]).toBe(1);
    // No other buckets should have entries
    expect(result.pickDistribution.reduce((a, b) => a + b, 0)).toBe(1);
  });
});
