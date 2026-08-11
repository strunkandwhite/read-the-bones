import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  getQueue,
  setQueue,
  removeCardFromAllQueues,
  getAutoPickCandidate,
  trimExcessQueueEntries,
  fulfillGroupEntry,
  type QueueEntry,
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

  it("returns parsed queue entries from queue_json", async () => {
    const queueJson: QueueEntry[] = [
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      {
        mode: "flow-through",
        cards: [
          { id: 20, name: "Counterspell" },
          { id: 30, name: "Mana Drain" },
        ],
      },
    ];
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: JSON.stringify(queueJson) }],
    });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual(queueJson);
  });

  it("returns empty array when queue_json is null", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: null }],
    });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual([]);
  });

  it("returns empty array when no seat_token row exists", async () => {
    client.execute.mockResolvedValueOnce({ rows: [] });

    const result = await getQueue(client, "draft-1", 1);
    expect(result).toEqual([]);
  });
});

describe("setQueue", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("writes queue entries as JSON to seat_tokens", async () => {
    const entries: QueueEntry[] = [
      { mode: "pause", cards: [{ id: 10, name: "Lightning Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Counterspell" }] },
    ];
    await setQueue(client, "draft-1", 1, entries);

    expect(client.execute).toHaveBeenCalledOnce();
    const call = client.execute.mock.calls[0][0];
    expect(call.sql).toContain("UPDATE seat_tokens");
    expect(call.sql).toContain("queue_json");
    const storedJson = JSON.parse(call.args[0] as string);
    expect(storedJson).toEqual(entries);
  });

  it("writes empty array for empty queue", async () => {
    await setQueue(client, "draft-1", 1, []);

    const call = client.execute.mock.calls[0][0];
    expect(JSON.parse(call.args[0] as string)).toEqual([]);
  });
});

describe("removeCardFromAllQueues", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("removes card from single-card entries across all seats", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          ]),
        },
        {
          seat: 2,
          queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    // Should batch-update both seats
    expect(client.batch).toHaveBeenCalledOnce();
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(2);

    // Seat 1: Bolt removed, Recall remains
    const seat1Json = JSON.parse(statements[0].args[0] as string);
    expect(seat1Json).toEqual([{ mode: "pause", cards: [{ id: 20, name: "Recall" }] }]);

    // Seat 2: Bolt removed, queue empty
    const seat2Json = JSON.parse(statements[1].args[0] as string);
    expect(seat2Json).toEqual([]);

    // Returns pause triggers: both seats' first entries were exhausted in pause mode
    expect(result).toEqual({ pauseSeats: [1, 2] });
  });

  it("removes card from within a group without removing the group", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            {
              mode: "flow-through",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 20, name: "Chain" },
              ],
            },
          ]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([{ mode: "flow-through", cards: [{ id: 20, name: "Chain" }] }]);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("triggers pause when first entry top card removed and mode is pause", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          ]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [1] });
  });

  it("does not trigger pause when removed card is not in first entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          ]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("does not trigger pause when first entry group still has cards", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            {
              mode: "pause",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 20, name: "Chain" },
              ],
            },
          ]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    // Group still has Chain, so no pause even though Bolt was first card
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("does not pause when first entry mode is flow-through", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([{ mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);
    expect(result).toEqual({ pauseSeats: [] });
  });

  it("skips seats without the card in their queue", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 99, name: "Other" }] }]),
        },
        {
          seat: 2,
          queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    const result = await removeCardFromAllQueues(client, "draft-1", 10);

    // Only seat 2 should be updated
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1);
    expect(statements[0].args[1]).toBe("draft-1");
    expect(statements[0].args[2]).toBe(2);
    expect(result).toEqual({ pauseSeats: [2] });
  });
});

describe("getAutoPickCandidate", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("returns first available card from first entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          queue_json: JSON.stringify([
            {
              mode: "pause",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 20, name: "Chain" },
              ],
            },
          ]),
        },
      ],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([10, 20]));
    expect(result).toEqual({ kind: "candidate", cardId: 10, entryIndex: 0 });
  });

  it("skips unavailable cards within an entry", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          queue_json: JSON.stringify([
            {
              mode: "pause",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 20, name: "Chain" },
              ],
            },
          ]),
        },
      ],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "candidate", cardId: 20, entryIndex: 0 });
  });

  it("skips exhausted flow-through entries and continues", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          queue_json: JSON.stringify([
            { mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          ]),
        },
      ],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "candidate", cardId: 20, entryIndex: 1 });
  });

  it("returns paused when exhausted pause entry is reached", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
          ]),
        },
      ],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "paused" });
  });

  it("returns empty when all entries exhausted via flow-through", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          queue_json: JSON.stringify([{ mode: "flow-through", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([20]));
    expect(result).toEqual({ kind: "empty" });
  });

  it("returns empty when queue is empty", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ queue_json: "[]" }],
    });

    const result = await getAutoPickCandidate(client, "draft-1", 1, new Set([10]));
    expect(result).toEqual({ kind: "empty" });
  });
});

describe("trimExcessQueueEntries", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("removes excess card references from lowest-priority entries", async () => {
    // Seat 1 has the card in entries at index 0 and 2 (two refs), remaining=1
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          ]),
        },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    // Entry at index 2 (lowest priority) should be removed
    expect(json).toEqual([
      { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
      { mode: "pause", cards: [{ id: 20, name: "Recall" }] },
    ]);
  });

  it("removes card from within a group at lowest priority", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            {
              mode: "flow-through",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 20, name: "Chain" },
              ],
            },
          ]),
        },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([
      { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
      { mode: "flow-through", cards: [{ id: 20, name: "Chain" }] },
    ]);
  });

  it("delegates to removeCardFromAllQueues when remainingCopies is 0 — removes the card via batch UPDATE", async () => {
    // removeCardFromAllQueues SELECT
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 0);

    // The removeCardFromAllQueues path issues a batch UPDATE with empty queue
    expect(client.batch).toHaveBeenCalledTimes(1);
    const statements = client.batch.mock.calls[0][0];
    expect(statements).toHaveLength(1);
    const updatedQueue = JSON.parse(statements[0].args[0] as string);
    expect(updatedQueue).toEqual([]);
    // Confirm the UPDATE targets the right draft/seat
    expect(statements[0].args[1]).toBe("draft-1");
    expect(statements[0].args[2]).toBe(1);
  });

  it("removes only toRemove refs when an entry contains the same card id twice (multi-copy)", async () => {
    // Single entry with two refs to card 10 — remainingCopies=1, so only 1 should be removed
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            {
              mode: "pause",
              cards: [
                { id: 10, name: "Bolt" },
                { id: 10, name: "Bolt" },
              ],
            },
          ]),
        },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    // Entry should be kept with exactly one ref remaining, not dropped entirely
    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]);
  });

  it("does nothing when no seat has excess entries", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]),
        },
      ],
    });

    await trimExcessQueueEntries(client, "draft-1", 10, 2);

    expect(client.batch).not.toHaveBeenCalled();
  });

  it("never triggers a pause even if first entry is emptied", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [
        {
          seat: 1,
          queue_json: JSON.stringify([
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
            { mode: "pause", cards: [{ id: 10, name: "Bolt" }] },
          ]),
        },
      ],
    });

    // remainingCopies=1, so one Bolt ref stays, one gets trimmed. Bottom-up, so index 1 is trimmed.
    await trimExcessQueueEntries(client, "draft-1", 10, 1);

    const statements = client.batch.mock.calls[0][0];
    const json = JSON.parse(statements[0].args[0] as string);
    expect(json).toEqual([{ mode: "pause", cards: [{ id: 10, name: "Bolt" }] }]);
  });
});

describe("fulfillGroupEntry", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  const QUEUE = JSON.stringify([
    {
      mode: "flow-through",
      cards: [
        { id: 10, name: "Bolt" },
        { id: 20, name: "Chain" },
      ],
    },
    { mode: "pause", cards: [{ id: 30, name: "Recall" }] },
  ]);

  it("removes the entry at the given index and returns it", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 10);

    expect(removed).toEqual({
      mode: "flow-through",
      cards: [
        { id: 10, name: "Bolt" },
        { id: 20, name: "Chain" },
      ],
    });
    const call = client.execute.mock.calls[1][0]; // second call is the UPDATE
    expect(JSON.parse(call.args[0] as string)).toEqual([
      { mode: "pause", cards: [{ id: 30, name: "Recall" }] },
    ]);
  });

  it("finds the entry by card when the index has drifted", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    // Index 0 no longer holds Recall — a queue PUT reordered underneath us.
    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 30);

    expect(removed).toEqual({ mode: "pause", cards: [{ id: 30, name: "Recall" }] });
    const call = client.execute.mock.calls[1][0];
    expect(JSON.parse(call.args[0] as string)).toEqual([
      {
        mode: "flow-through",
        cards: [
          { id: 10, name: "Bolt" },
          { id: 20, name: "Chain" },
        ],
      },
    ]);
  });

  it("returns null and writes nothing when the card is already gone", async () => {
    client.execute.mockResolvedValueOnce({ rows: [{ queue_json: QUEUE }] });

    const removed = await fulfillGroupEntry(client, "draft-1", 1, 0, 999);

    expect(removed).toBeNull();
    expect(client.execute).toHaveBeenCalledTimes(1); // the SELECT only, no UPDATE
  });
});
