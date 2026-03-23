// src/core/db/sync/__tests__/card-cache.test.ts
import { describe, it, expect, vi } from "vitest";
import { CardCache } from "../card-cache";

describe("CardCache", () => {
  it("returns card_id for known cards after bulk load", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { card_id: 1, name: "Lightning Bolt" },
          { card_id: 2, name: "Counterspell" },
        ],
      }),
      batch: vi.fn().mockResolvedValue([]),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    expect(cache.get("Lightning Bolt")).toBe(1);
    expect(cache.get("Counterspell")).toBe(2);
    expect(cache.get("Unknown Card")).toBeUndefined();
  });

  it("performs case-insensitive lookups", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ card_id: 1, name: "Lightning Bolt" }],
      }),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    expect(cache.get("lightning bolt")).toBe(1);
    expect(cache.get("LIGHTNING BOLT")).toBe(1);
    expect(cache.get("Lightning Bolt")).toBe(1);
  });

  it("tracks missing cards and batch-inserts them", async () => {
    const mockClient = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [] }) // loadAll returns empty
        .mockResolvedValueOnce({ rows: [{ card_id: 10 }] }) // re-query card 1
        .mockResolvedValueOnce({ rows: [{ card_id: 11 }] }), // re-query card 2
      batch: vi.fn().mockResolvedValue([]),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    cache.markMissing("New Card", "generated:new-card", null);
    cache.markMissing("Other Card", "generated:other-card", null);

    await cache.flushMissing(mockClient as any);

    expect(mockClient.batch).toHaveBeenCalledTimes(1);
    const stmts = mockClient.batch.mock.calls[0][0];
    expect(stmts).toHaveLength(2);
    expect(stmts[0].sql).toContain("INSERT OR IGNORE INTO cards");

    // After flush, cards should be in cache
    expect(cache.get("New Card")).toBe(10);
    expect(cache.get("Other Card")).toBe(11);
  });

  it("skips markMissing for cards already in cache", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ card_id: 1, name: "Lightning Bolt" }],
      }),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    cache.markMissing("Lightning Bolt", "oracle:bolt", null);

    // flushMissing should be a no-op
    await cache.flushMissing(mockClient as any);
    // batch should not have been called (no missing cards)
    expect(mockClient.execute).toHaveBeenCalledTimes(1); // Only the loadAll call
  });

  it("does nothing when flushMissing is called with no missing cards", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      batch: vi.fn(),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);
    await cache.flushMissing(mockClient as any);

    expect(mockClient.batch).not.toHaveBeenCalled();
  });

  it("supports manual set", () => {
    const cache = new CardCache();
    cache.set("Test Card", 42);
    expect(cache.get("Test Card")).toBe(42);
    expect(cache.get("test card")).toBe(42);
  });

  it("indexes DFCs by front face for lookup", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { card_id: 638, name: "Brazen Borrower // Petty Theft" },
          { card_id: 100, name: "Lightning Bolt" },
        ],
      }),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    // Full DFC name lookup still works
    expect(cache.get("Brazen Borrower // Petty Theft")).toBe(638);
    // Front-face-only lookup also works
    expect(cache.get("Brazen Borrower")).toBe(638);
  });

  it("prefers front-face-only entry over DFC alias", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { card_id: 638, name: "Brazen Borrower // Petty Theft" },
          { card_id: 708, name: "Brazen Borrower" },
        ],
      }),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);

    // When both exist, front-face-only entry (loaded directly) wins
    expect(cache.get("Brazen Borrower")).toBe(708);
    expect(cache.get("Brazen Borrower // Petty Theft")).toBe(638);
  });

  it("reports size", async () => {
    const mockClient = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { card_id: 1, name: "Card A" },
          { card_id: 2, name: "Card B" },
        ],
      }),
    };

    const cache = new CardCache();
    await cache.loadAll(mockClient as any);
    expect(cache.size).toBe(2);
  });
});
