import { describe, it, expect, vi, beforeEach } from "vitest";
import { filterRedactedPicks, reconcileRedactedRows } from "./redaction";
import type { CardPick } from "../../types";

function pick(seat: number, pickPosition: number, cardName: string): CardPick {
  return { cardName, pickPosition, copyNumber: 1, wasPicked: true, draftId: "d1", seat, color: "" };
}

describe("filterRedactedPicks", () => {
  it("drops picks whose 1-indexed seat is opted out", () => {
    // seat 4 (0-indexed) is seat 5 (1-indexed)
    const picks = [pick(3, 4, "Bolt"), pick(4, 5, "Swords"), pick(5, 6, "Ragavan")];
    const result = filterRedactedPicks(picks, new Set([5]));
    expect(result.map((p) => p.cardName)).toEqual(["Bolt", "Ragavan"]);
  });

  it("returns the input unchanged when nothing is opted out", () => {
    const picks = [pick(0, 1, "Bolt"), pick(1, 2, "Swords")];
    expect(filterRedactedPicks(picks, new Set())).toHaveLength(2);
  });

  it("drops every pick when the only drafter is opted out", () => {
    expect(filterRedactedPicks([pick(0, 1, "Bolt")], new Set([1]))).toEqual([]);
  });

  it("does not confuse 0-indexed seat 5 with 1-indexed seat 5", () => {
    // 0-indexed seat 5 is 1-indexed seat 6 — must survive an opt-out on seat 5
    const result = filterRedactedPicks([pick(5, 1, "Bolt")], new Set([5]));
    expect(result).toHaveLength(1);
  });
});

describe("reconcileRedactedRows", () => {
  let mockClient: { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn(), batch: vi.fn() };
  });

  it("deletes pick_events and deck_cards for opted-out seats and reports counts", async () => {
    mockClient.execute
      .mockResolvedValueOnce({ rows: [{ seat: 5 }] })                 // getOptedOutSeats
      .mockResolvedValueOnce({ rowsAffected: 45 })                    // pick_events delete
      .mockResolvedValueOnce({ rowsAffected: 44 });                   // deck_cards delete

    const result = await reconcileRedactedRows(mockClient as never, "d1");

    expect(result).toEqual({ picksDeleted: 45, deckCardsDeleted: 44 });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM pick_events"),
        args: ["d1", 5],
      }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM deck_cards"),
        args: ["d1", 5],
      }),
    );
  });

  it("deletes for every opted-out seat when there are multiple", async () => {
    mockClient.execute
      .mockResolvedValueOnce({ rows: [{ seat: 3 }, { seat: 7 }] })    // getOptedOutSeats
      .mockResolvedValueOnce({ rowsAffected: 12 })                    // pick_events delete
      .mockResolvedValueOnce({ rowsAffected: 9 });                    // deck_cards delete

    const result = await reconcileRedactedRows(mockClient as never, "d1");

    expect(result).toEqual({ picksDeleted: 12, deckCardsDeleted: 9 });
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM pick_events"),
        args: ["d1", 3, 7],
      }),
    );
    expect(mockClient.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM deck_cards"),
        args: ["d1", 3, 7],
      }),
    );
  });

  it("issues no deletes when the draft has no opt-outs", async () => {
    mockClient.execute.mockResolvedValueOnce({ rows: [] });
    const result = await reconcileRedactedRows(mockClient as never, "d1");
    expect(result).toEqual({ picksDeleted: 0, deckCardsDeleted: 0 });
    expect(mockClient.execute).toHaveBeenCalledTimes(1);
  });
});
