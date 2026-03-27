import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getQueue,
  setQueue,
  removeCardFromAllQueues,
  getAutoPickCandidate,
} from "./pickQueue";

function createMockClient() {
  return {
    execute: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
  } as unknown as Client & { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };
}

describe("getQueue", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("returns ordered entries with card names", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { priority: 1, card_id: 10, name: "Lightning Bolt" },
        { priority: 2, card_id: 20, name: "Counterspell" },
        { priority: 3, card_id: 30, name: "Dark Ritual" },
      ],
    });

    const result = await getQueue(client, "draft-1", 1);

    expect(result).toEqual([
      { priority: 1, cardId: 10, cardName: "Lightning Bolt" },
      { priority: 2, cardId: 20, cardName: "Counterspell" },
      { priority: 3, cardId: 30, cardName: "Dark Ritual" },
    ]);
    expect(client.execute).toHaveBeenCalledOnce();
    expect(client.execute.mock.calls[0][0].args).toEqual(["draft-1", 1]);
  });
});

describe("setQueue", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("batches delete + inserts in correct priority order", async () => {
    await setQueue(client, "draft-1", 2, [10, 20, 30]);

    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(4);
    expect(statements[0].sql).toContain("DELETE");
    expect(statements[0].args).toEqual(["draft-1", 2]);
    expect(statements[1].args).toEqual(["draft-1", 2, 1, 10]);
    expect(statements[2].args).toEqual(["draft-1", 2, 2, 20]);
    expect(statements[3].args).toEqual(["draft-1", 2, 3, 30]);
  });
});

describe("removeCardFromAllQueues", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("deletes the card and batches renumbered entries", async () => {
    // First call: delete the card
    client.execute.mockResolvedValueOnce({ rows: [] });
    // Second call: fetch all remaining rows ordered by seat, priority
    client.execute.mockResolvedValueOnce({
      rows: [
        { seat: 1, card_id: 20 },
        { seat: 1, card_id: 30 },
      ],
    });

    await removeCardFromAllQueues(client, "draft-1", 10);

    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(client.execute.mock.calls[0][0].args).toEqual(["draft-1", 10]);
    expect(client.execute.mock.calls[1][0].sql).toContain("ORDER BY seat, priority");

    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(3);
    expect(statements[0].sql).toContain("DELETE");
    expect(statements[0].args).toEqual(["draft-1"]);
    expect(statements[1].args).toEqual(["draft-1", 1, 1, 20]);
    expect(statements[2].args).toEqual(["draft-1", 1, 2, 30]);
  });
});

describe("getAutoPickCandidate", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("returns the highest priority card_id that is in the available set", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { priority: 1, card_id: 10, name: "Lightning Bolt" },
        { priority: 2, card_id: 20, name: "Counterspell" },
        { priority: 3, card_id: 30, name: "Dark Ritual" },
      ],
    });

    const available = new Set([20, 30]);
    const result = await getAutoPickCandidate(client, "draft-1", 1, available);

    expect(result).toBe(20);
  });

  it("returns null when no queued cards are available", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { priority: 1, card_id: 10, name: "Lightning Bolt" },
        { priority: 2, card_id: 20, name: "Counterspell" },
      ],
    });

    const available = new Set([99, 100]);
    const result = await getAutoPickCandidate(client, "draft-1", 1, available);

    expect(result).toBeNull();
  });
});
