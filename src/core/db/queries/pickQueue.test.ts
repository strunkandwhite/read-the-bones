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
  } as unknown as Client & { execute: ReturnType<typeof vi.fn> };
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

  beforeEach(() => {
    client = createMockClient();
  });

  it("deletes existing queue then inserts new entries in order", async () => {
    client.execute.mockResolvedValue({ rows: [] });

    await setQueue(client, "draft-1", 2, [10, 20, 30]);

    // First call: DELETE
    expect(client.execute).toHaveBeenCalledTimes(4); // 1 delete + 3 inserts
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE");
    expect(client.execute.mock.calls[0][0].args).toEqual(["draft-1", 2]);

    // Subsequent calls: INSERTs with correct priority ordering
    expect(client.execute.mock.calls[1][0].sql).toContain("INSERT");
    expect(client.execute.mock.calls[1][0].args).toEqual(["draft-1", 2, 1, 10]);
    expect(client.execute.mock.calls[2][0].args).toEqual(["draft-1", 2, 2, 20]);
    expect(client.execute.mock.calls[3][0].args).toEqual(["draft-1", 2, 3, 30]);
  });
});

describe("removeCardFromAllQueues", () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it("deletes the card and renumbers remaining entries", async () => {
    // Call 1: DELETE the card from all queues
    client.execute.mockResolvedValueOnce({ rows: [] });
    // Call 2: SELECT DISTINCT seats
    client.execute.mockResolvedValueOnce({
      rows: [{ seat: 1 }],
    });
    // Call 3: SELECT remaining cards for seat 1
    client.execute.mockResolvedValueOnce({
      rows: [{ card_id: 20 }, { card_id: 30 }],
    });
    // Call 4: DELETE seat 1 entries
    client.execute.mockResolvedValueOnce({ rows: [] });
    // Calls 5-6: INSERT renumbered entries
    client.execute.mockResolvedValueOnce({ rows: [] });
    client.execute.mockResolvedValueOnce({ rows: [] });

    await removeCardFromAllQueues(client, "draft-1", 10);

    // First call: delete the target card
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE");
    expect(client.execute.mock.calls[0][0].args).toEqual(["draft-1", 10]);

    // Second call: find affected seats
    expect(client.execute.mock.calls[1][0].sql).toContain("DISTINCT seat");

    // Third call: get remaining entries for seat 1
    expect(client.execute.mock.calls[2][0].args).toEqual(["draft-1", 1]);

    // Fourth call: delete seat 1 entries for re-insertion
    expect(client.execute.mock.calls[3][0].sql).toContain("DELETE");

    // Fifth and sixth calls: re-insert with renumbered priorities
    expect(client.execute.mock.calls[4][0].args).toEqual(["draft-1", 1, 1, 20]);
    expect(client.execute.mock.calls[5][0].args).toEqual(["draft-1", 1, 2, 30]);
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
