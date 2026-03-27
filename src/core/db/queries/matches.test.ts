import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getMatchCount, reportMatchResult } from "./matches";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

describe("getMatchCount", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the count of matches", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 7 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(7);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("COUNT(*)"),
        args: ["draft-1"],
      })
    );
  });

  it("returns 0 when no matches exist", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const result = await getMatchCount(client, "draft-1");

    expect(result).toBe(0);
  });
});

describe("reportMatchResult", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("executes INSERT OR REPLACE with correct args", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    await reportMatchResult(client, "draft-1", 1, 3, 2, 1, 3);

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("INSERT OR REPLACE INTO match_events"),
        args: ["draft-1", 1, 3, 2, 1, 3],
      })
    );
  });
});
