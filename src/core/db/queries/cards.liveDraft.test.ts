import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { resolveCardId } from "./cards";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("resolveCardId", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns card_id for an existing card", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ card_id: 42 }] });

    const result = await resolveCardId(client, "Lightning Bolt");

    expect(result).toBe(42);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT card_id FROM cards WHERE name = ?"),
        args: ["Lightning Bolt"],
      })
    );
  });

  it("returns null for a nonexistent card", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await resolveCardId(client, "Not A Real Card");

    expect(result).toBeNull();
  });
});
