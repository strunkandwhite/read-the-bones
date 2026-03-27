import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { getDraftPhase } from "./drafts";

function createMockClient() {
  return { execute: vi.fn() } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
}

vi.mock("../client", () => ({
  getClient: vi.fn(() => Promise.resolve({ execute: vi.fn() })),
}));

describe("getDraftPhase", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns the phase for an existing draft", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ phase: "drafting" }] });

    const result = await getDraftPhase(client, "draft-1");

    expect(result).toBe("drafting");
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("SELECT phase FROM drafts"),
        args: ["draft-1"],
      })
    );
  });

  it("returns null for a missing draft", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getDraftPhase(client, "nonexistent");

    expect(result).toBeNull();
  });
});
