import { describe, it, expect, vi } from "vitest";
import {
  detectNewPicks,
  detectDivergence,
  isRateLimited,
  getDbMaxPickN,
  resolveCardNameToId,
} from "../sync";
import type { CardPick } from "../types";

// Mock Scryfall fetch to avoid network calls in tests
vi.mock("../../build/scryfall", () => ({
  fetchCard: vi.fn().mockResolvedValue(null),
  fetchCardFuzzy: vi.fn().mockResolvedValue(null),
}));

// Helper to create a CardPick with required fields
function pick(name: string, position: number, seat: number): CardPick {
  return {
    cardName: name,
    pickPosition: position,
    seat,
    copyNumber: 1,
    wasPicked: true,
    draftId: "test-draft",
    color: "",
  };
}

describe("detectNewPicks", () => {
  it("returns only picks with pickPosition greater than currentMax", () => {
    const allPicks: CardPick[] = [
      pick("Lightning Bolt", 1, 0),
      pick("Counterspell", 2, 1),
      pick("Swords to Plowshares", 3, 0),
    ];
    const result = detectNewPicks(allPicks, 1);
    expect(result).toHaveLength(2);
    expect(result[0].cardName).toBe("Counterspell");
    expect(result[1].cardName).toBe("Swords to Plowshares");
  });

  it("returns all picks when currentMax is 0", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 0);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no new picks", () => {
    const allPicks: CardPick[] = [pick("Lightning Bolt", 1, 0)];
    const result = detectNewPicks(allPicks, 5);
    expect(result).toHaveLength(0);
  });
});

describe("detectDivergence", () => {
  it("detects when CSV has fewer picks than database", () => {
    expect(detectDivergence(3, 5)).toBe(true);
  });

  it("no divergence when CSV has more picks", () => {
    expect(detectDivergence(5, 3)).toBe(false);
  });

  it("no divergence when counts are equal", () => {
    expect(detectDivergence(3, 3)).toBe(false);
  });
});

describe("isRateLimited", () => {
  it("returns false when no last_synced_at exists", async () => {
    const client = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
    expect(await isRateLimited(client as any)).toBe(false);
  });

  it("returns true when synced recently", async () => {
    const recentTimestamp = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ value: String(recentTimestamp) }],
      }),
    };
    expect(await isRateLimited(client as any)).toBe(true);
  });

  it("returns false when synced long ago", async () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 60; // 60 seconds ago
    const client = {
      execute: vi.fn().mockResolvedValue({
        rows: [{ value: String(oldTimestamp) }],
      }),
    };
    expect(await isRateLimited(client as any)).toBe(false);
  });
});

describe("getDbMaxPickN", () => {
  it("returns 0 when no picks exist", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ max_pick: null }] }),
    };
    expect(await getDbMaxPickN(client as any, "draft-1")).toBe(0);
  });

  it("returns max pick number", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ max_pick: 42 }] }),
    };
    expect(await getDbMaxPickN(client as any, "draft-1")).toBe(42);
  });
});

describe("resolveCardNameToId", () => {
  it("returns card_id for exact match", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [{ card_id: 123 }] }),
    };
    expect(await resolveCardNameToId(client as any, "Lightning Bolt")).toBe(123);
  });

  it("falls back to front-face DFC match", async () => {
    const client = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [{ card_id: 456 }] }), // front-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Fable of the Mirror-Breaker")).toBe(456);
    expect(client.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to back-face DFC match", async () => {
    const client = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
        .mockResolvedValueOnce({ rows: [{ card_id: 789 }] }), // back-face DFC
    };
    expect(await resolveCardNameToId(client as any, "Death")).toBe(789);
    expect(client.execute).toHaveBeenCalledTimes(3);
  });

  it("falls back to alias table lookup", async () => {
    const client = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // exact match fails
        .mockResolvedValueOnce({ rows: [] }) // front-face DFC fails
        .mockResolvedValueOnce({ rows: [] }) // back-face DFC fails
        .mockResolvedValueOnce({ rows: [{ card_id: 101 }] }), // alias match
    };
    expect(await resolveCardNameToId(client as any, "troll of khazad-dum")).toBe(101);
    expect(client.execute).toHaveBeenCalledTimes(4);
  });

  it("returns null when all lookups fail", async () => {
    const client = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    expect(await resolveCardNameToId(client as any, "Not A Card")).toBeNull();
    // 4 DB queries: exact, front-face DFC, back-face DFC, alias table
    expect(client.execute).toHaveBeenCalledTimes(4);
  });
});
