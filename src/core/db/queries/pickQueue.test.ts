import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getQueue,
  setQueue,
  removeCardFromAllQueues,
  getAutoPickCandidate,
  trimExcessQueueEntries,
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

describe("trimExcessQueueEntries", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("removes only excess entries per seat when remainingCopies > 0", async () => {
    // Seat 1 has card queued at priority 2 and 4 (2 entries, excess = 1 when remaining = 1)
    // Seat 2 has card queued at priority 1 (1 entry, no excess)
    client.execute.mockResolvedValueOnce({
      rows: [
        { seat: 1, priority: 2, card_id: 10 },
        { seat: 1, priority: 4, card_id: 10 },
        { seat: 2, priority: 1, card_id: 10 },
      ],
    });
    // After delete batch, query remaining for seat 1 renumbering
    client.execute.mockResolvedValueOnce({
      rows: [
        { card_id: 20 },  // was priority 1
        { card_id: 10 },  // was priority 2 (kept)
        { card_id: 30 },  // was priority 3
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    // Should have: 1 execute (SELECT entries) + 1 batch (delete excess) + 1 execute (SELECT remaining for seat 1) + 1 batch (renumber seat 1)
    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(client.batch).toHaveBeenCalledTimes(2);

    // First batch: delete the excess entry (seat 1, priority 4)
    const deleteBatch = client.batch.mock.calls[0][0];
    expect(deleteBatch).toHaveLength(1);
    expect(deleteBatch[0].args).toEqual(["draft-1", 1, 4]);

    // Second batch: renumber seat 1 (delete + 3 inserts)
    const renumberBatch = client.batch.mock.calls[1][0];
    expect(renumberBatch).toHaveLength(4); // 1 delete + 3 inserts
    expect(renumberBatch[0].sql).toContain("DELETE");
  });

  it("does nothing when no seat has excess entries", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        { seat: 1, priority: 2, card_id: 10 },
        { seat: 2, priority: 1, card_id: 10 },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 2);

    // Only the initial SELECT, no batches
    expect(client.execute).toHaveBeenCalledTimes(1);
    expect(client.batch).not.toHaveBeenCalled();
  });

  it("delegates to removeCardFromAllQueues when remainingCopies is 0", async () => {
    // removeCardFromAllQueues expects: execute (DELETE), execute (SELECT remaining)
    client.execute.mockResolvedValueOnce({ rows: [] }); // DELETE
    client.execute.mockResolvedValueOnce({ rows: [] }); // SELECT remaining

    await trimExcessQueueEntries(client, "draft-1", 10, 0);

    // Should have called execute for the removeCardFromAllQueues path
    expect(client.execute).toHaveBeenCalledTimes(2);
    expect(client.execute.mock.calls[0][0].sql).toContain("DELETE");
  });
});
