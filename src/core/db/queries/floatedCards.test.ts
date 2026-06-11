import { describe, it, expect, vi, beforeEach } from "vitest";
import { getFloatedCards, addFloatedCard, removeFloatedCard, addFloatedCards, removeFloatedCards } from "./floatedCards";

describe("floatedCards queries", () => {
  let mockClient: { execute: ReturnType<typeof vi.fn>; batch: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { execute: vi.fn(), batch: vi.fn() };
  });

  describe("getFloatedCards", () => {
    it("returns floated card names for a draft and seat", async () => {
      mockClient.execute.mockResolvedValue({
        rows: [
          { card_name: "Lightning Bolt" },
          { card_name: "Counterspell" },
        ],
      });
      const result = await getFloatedCards(mockClient as any, "draft-1", 1);
      expect(result).toEqual(["Lightning Bolt", "Counterspell"]);
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("floated_cards"),
        })
      );
    });

    it("returns empty array when no floated cards", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      const result = await getFloatedCards(mockClient as any, "draft-1", 1);
      expect(result).toEqual([]);
    });
  });

  describe("addFloatedCard", () => {
    it("inserts a floated card row", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await addFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("INSERT"),
          args: expect.arrayContaining(["draft-1", 1, "Lightning Bolt"]),
        })
      );
    });

    it("uses INSERT OR IGNORE to handle duplicates", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await addFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("OR IGNORE"),
        })
      );
    });
  });

  describe("removeFloatedCard", () => {
    it("deletes a floated card row", async () => {
      mockClient.execute.mockResolvedValue({ rows: [] });
      await removeFloatedCard(mockClient as any, "draft-1", 1, "Lightning Bolt");
      expect(mockClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          sql: expect.stringContaining("DELETE"),
          args: expect.arrayContaining(["draft-1", 1, "Lightning Bolt"]),
        })
      );
    });
  });

  describe("addFloatedCards (batch)", () => {
    it("batches INSERT OR IGNORE for multiple cards", async () => {
      mockClient.batch.mockResolvedValue([]);
      await addFloatedCards(mockClient as any, "draft-1", 1, ["Lightning Bolt", "Counterspell"]);
      expect(mockClient.batch).toHaveBeenCalledWith([
        {
          sql: expect.stringContaining("INSERT OR IGNORE"),
          args: ["draft-1", 1, "Lightning Bolt"],
        },
        {
          sql: expect.stringContaining("INSERT OR IGNORE"),
          args: ["draft-1", 1, "Counterspell"],
        },
      ]);
    });

    it("does nothing when given an empty array", async () => {
      await addFloatedCards(mockClient as any, "draft-1", 1, []);
      expect(mockClient.batch).not.toHaveBeenCalled();
    });
  });

  describe("removeFloatedCards (batch)", () => {
    it("batches DELETE for multiple cards", async () => {
      mockClient.batch.mockResolvedValue([]);
      await removeFloatedCards(mockClient as any, "draft-1", 1, ["Lightning Bolt", "Counterspell"]);
      expect(mockClient.batch).toHaveBeenCalledWith([
        {
          sql: expect.stringContaining("DELETE"),
          args: ["draft-1", 1, "Lightning Bolt"],
        },
        {
          sql: expect.stringContaining("DELETE"),
          args: ["draft-1", 1, "Counterspell"],
        },
      ]);
    });

    it("does nothing when given an empty array", async () => {
      await removeFloatedCards(mockClient as any, "draft-1", 1, []);
      expect(mockClient.batch).not.toHaveBeenCalled();
    });
  });
});
