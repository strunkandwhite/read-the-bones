/**
 * Tests for getDraftStats against a real in-memory libsql database.
 *
 * Rationale: the previous version mocked client.execute and re-derived
 * aggregation logic in JavaScript, meaning the tests verified the mock's
 * arithmetic rather than the production SQL (CTE, num_seats filter, etc.).
 * Deleting the WHERE num_seats = 10 clause would NOT have failed those tests.
 *
 * This version injects a real in-memory libsql client so the CTEs and JOINs
 * actually execute, making the tests meaningful regression guards.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient, type Client } from "@libsql/client";

// --- In-memory DB setup ---

let memClient: Client;

vi.mock("./db/client", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "./db/client";
import { getDraftStats } from "./getDraftStats";

async function createSchema(client: Client): Promise<void> {
  // Minimal schema needed by getDraftStats + inferSeatColors
  await client.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id TEXT PRIMARY KEY,
      draft_name TEXT NOT NULL DEFAULT '',
      draft_date TEXT NOT NULL DEFAULT '',
      cube_snapshot_id INTEGER NOT NULL DEFAULT 0,
      pool_hash TEXT,
      picks_hash TEXT,
      matches_hash TEXT,
      num_seats INTEGER NOT NULL DEFAULT 10,
      phase TEXT NOT NULL DEFAULT 'complete',
      in_app INTEGER NOT NULL DEFAULT 0
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS match_events (
      draft_id TEXT NOT NULL,
      seat1 INTEGER NOT NULL,
      seat2 INTEGER NOT NULL,
      seat1_wins INTEGER NOT NULL,
      seat2_wins INTEGER NOT NULL,
      PRIMARY KEY (draft_id, seat1, seat2)
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS cards (
      card_id INTEGER PRIMARY KEY,
      oracle_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      scryfall_json TEXT
    )
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      card_id INTEGER NOT NULL,
      zone TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (draft_id, seat, card_id, zone)
    )
  `);
}

async function insertDraft(
  client: Client,
  draftId: string,
  opts: {
    numSeats?: number;
    phase?: string;
    poolHash?: string;
    picksHash?: string;
    matchesHash?: string;
  } = {}
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO drafts (draft_id, num_seats, phase, pool_hash, picks_hash, matches_hash)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      draftId,
      opts.numSeats ?? 10,
      opts.phase ?? "complete",
      opts.poolHash ?? "ph1",
      opts.picksHash ?? "pi1",
      opts.matchesHash ?? "mh1",
    ],
  });
}

async function insertMatch(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number,
  seat1Wins: number,
  seat2Wins: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO match_events (draft_id, seat1, seat2, seat1_wins, seat2_wins)
          VALUES (?, ?, ?, ?, ?)`,
    args: [draftId, seat1, seat2, seat1Wins, seat2Wins],
  });
}

async function insertCardWithColor(
  client: Client,
  cardId: number,
  colors: string[]
): Promise<void> {
  const scryfallJson = JSON.stringify({ color_identity: colors });
  await client.execute({
    sql: `INSERT INTO cards (card_id, oracle_id, name, scryfall_json)
          VALUES (?, ?, ?, ?)`,
    args: [cardId, `oracle-${cardId}`, `Card ${cardId}`, scryfallJson],
  });
}

async function insertDeckCard(
  client: Client,
  draftId: string,
  seat: number,
  cardId: number
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO deck_cards (draft_id, seat, card_id, zone) VALUES (?, ?, ?, 'deck')`,
    args: [draftId, seat, cardId],
  });
}

// --- Tests ---

beforeEach(async () => {
  memClient = createClient({ url: ":memory:" });
  await createSchema(memClient);
  vi.mocked(getClient).mockResolvedValue(memClient);
});

describe("getDraftStats", () => {
  it("returns win rate by seat across all 10-seat drafts — SQL aggregation", async () => {
    await insertDraft(memClient, "d1");
    await insertMatch(memClient, "d1", 1, 2, 2, 1);
    await insertMatch(memClient, "d1", 1, 3, 1, 2);
    await insertMatch(memClient, "d1", 2, 3, 2, 0);

    const result = await getDraftStats();

    expect(result.winRateBySeat.length).toBe(3);

    const seat1 = result.winRateBySeat.find((s) => s.seat === 1)!;
    expect(seat1.wins).toBe(3); // 2+1
    expect(seat1.losses).toBe(3); // 1+2
    expect(seat1.winRate).toBeCloseTo(0.5);

    const seat2 = result.winRateBySeat.find((s) => s.seat === 2)!;
    expect(seat2.wins).toBe(3); // 1+2
    expect(seat2.losses).toBe(2); // 2+0
    expect(seat2.winRate).toBeCloseTo(0.6);

    const seat3 = result.winRateBySeat.find((s) => s.seat === 3)!;
    expect(seat3.wins).toBe(2); // 0+2
    expect(seat3.losses).toBe(3); // 2+1
    expect(seat3.winRate).toBeCloseTo(0.4);

    // Wilson CI sanity
    for (const seat of result.winRateBySeat) {
      expect(seat.ciLower).toBeGreaterThanOrEqual(0);
      expect(seat.ciUpper).toBeLessThanOrEqual(1);
      expect(seat.ciLower).toBeLessThanOrEqual(seat.winRate);
      expect(seat.ciUpper).toBeGreaterThanOrEqual(seat.winRate);
    }
  });

  it("excludes non-10-seat drafts from seat win rate via production SQL WHERE num_seats = 10", async () => {
    // d1: 10-seat (should be included), d2: 12-seat (should be excluded from seat stats)
    await insertDraft(memClient, "d1", { numSeats: 10 });
    await insertDraft(memClient, "d2", { numSeats: 12 });

    await insertMatch(memClient, "d1", 1, 2, 2, 1); // 10-seat: seat1 wins 2, seat2 wins 1
    await insertMatch(memClient, "d2", 1, 2, 0, 3); // 12-seat: should NOT appear in seat stats

    const result = await getDraftStats();

    // Only d1 matches should appear in seat stats
    expect(result.winRateBySeat.length).toBe(2); // seats 1 and 2 from d1 only
    const seat1 = result.winRateBySeat.find((s) => s.seat === 1)!;
    expect(seat1.wins).toBe(2);
    expect(seat1.losses).toBe(1);

    const seat2 = result.winRateBySeat.find((s) => s.seat === 2)!;
    expect(seat2.wins).toBe(1);
    expect(seat2.losses).toBe(2);
  });

  it("draftIds filtering restricts color win rate to selected drafts (SQL WHERE IN)", async () => {
    // Both drafts are 'complete', but we only request stats for d1.
    // inferSeatColors is called with ["d1"] only, so d2 deck_cards are excluded.
    await insertDraft(memClient, "d1");
    await insertDraft(memClient, "d2");

    // card 1 = UB colors, card 2 = RG colors
    await insertCardWithColor(memClient, 1, ["U", "B"]);
    await insertCardWithColor(memClient, 2, ["R", "G"]);

    // d1: seat 1 (card 1 = UB), seat 2 (card 2 = RG)
    await insertDeckCard(memClient, "d1", 1, 1);
    await insertDeckCard(memClient, "d1", 2, 2);
    await insertMatch(memClient, "d1", 1, 2, 2, 1);

    // d2: seat 1 = RG (card 2), seat 2 = UB (card 1)
    await insertDeckCard(memClient, "d2", 1, 2);
    await insertDeckCard(memClient, "d2", 2, 1);
    await insertMatch(memClient, "d2", 1, 2, 0, 3);

    // Request only d1
    const result = await getDraftStats({ draftIds: ["d1"] });

    // Color stats should only include d1 data
    const ub = result.winRateByColor.find((c) => c.color === "UB");
    const rg = result.winRateByColor.find((c) => c.color === "RG");
    expect(ub).toBeDefined();
    expect(rg).toBeDefined();
    // d1 only: UB (seat1) wins 2, loses 1; RG (seat2) wins 1, loses 2
    expect(ub!.wins).toBe(2);
    expect(ub!.losses).toBe(1);
    expect(rg!.wins).toBe(1);
    expect(rg!.losses).toBe(2);
  });

  it("returns win rate by color using deck_cards + inferSeatColors", async () => {
    await insertDraft(memClient, "d1");

    // card 1 = UB colors, card 2 = RG colors
    await insertCardWithColor(memClient, 1, ["U", "B"]);
    await insertCardWithColor(memClient, 2, ["R", "G"]);

    await insertDeckCard(memClient, "d1", 1, 1); // seat1 has UB card
    await insertDeckCard(memClient, "d1", 2, 2); // seat2 has RG card

    await insertMatch(memClient, "d1", 1, 2, 2, 1);

    const result = await getDraftStats();

    const ub = result.winRateByColor.find((c) => c.color === "UB")!;
    expect(ub).toBeDefined();
    expect(ub.wins).toBe(2);
    expect(ub.losses).toBe(1);
    expect(ub.winRate).toBeCloseTo(2 / 3);

    const rg = result.winRateByColor.find((c) => c.color === "RG")!;
    expect(rg).toBeDefined();
    expect(rg.wins).toBe(1);
    expect(rg.losses).toBe(2);
    expect(rg.winRate).toBeCloseTo(1 / 3);

    // Sorted by win rate descending
    expect(result.winRateByColor[0].winRate).toBeGreaterThanOrEqual(
      result.winRateByColor[1].winRate
    );
  });

  it("computes ingestionHash as a 16-char hex string from draft domain hashes", async () => {
    await insertDraft(memClient, "d1", {
      poolHash: "abc",
      picksHash: "def",
      matchesHash: "ghi",
    });

    const result = await getDraftStats();

    expect(result.ingestionHash).toMatch(/^[a-f0-9]+$/);
    expect(result.ingestionHash.length).toBe(16);
  });

  it("handles empty data (no completed drafts)", async () => {
    const result = await getDraftStats();

    expect(result.winRateBySeat).toEqual([]);
    expect(result.winRateByColor).toEqual([]);
    expect(result.ingestionHash).toBeDefined();
    expect(typeof result.ingestionHash).toBe("string");
  });

  it("phase filter applies to color stats but NOT to seat stats (seat CTE queries all 10-seat drafts)", async () => {
    // The seat win-rate CTE uses: SELECT draft_id FROM drafts WHERE num_seats = 10
    // It does NOT filter by phase — seat position stats include all 10-seat drafts
    // regardless of phase. Only color stats use the completedDraftIds phase filter.
    await insertDraft(memClient, "d1", { phase: "drafting" });
    await insertMatch(memClient, "d1", 1, 2, 2, 1);

    const result = await getDraftStats();

    // Seat stats include the drafting-phase draft because the CTE has no phase filter
    expect(result.winRateBySeat.length).toBe(2);

    // But color stats are empty: completedDraftIds excludes 'drafting'-phase drafts
    expect(result.winRateByColor.length).toBe(0);
  });

  it("includes 'playing' phase drafts in color stats (same as 'complete')", async () => {
    await insertDraft(memClient, "d1", { phase: "playing" });

    await insertCardWithColor(memClient, 1, ["U", "B"]);
    await insertCardWithColor(memClient, 2, ["R", "G"]);
    await insertDeckCard(memClient, "d1", 1, 1);
    await insertDeckCard(memClient, "d1", 2, 2);
    await insertMatch(memClient, "d1", 1, 2, 2, 0);

    const result = await getDraftStats();

    // playing-phase drafts count toward color stats
    expect(result.winRateByColor.length).toBe(2);
    // and toward seat stats (as always — no phase filter in CTE)
    expect(result.winRateBySeat.length).toBe(2);
    const seat1 = result.winRateBySeat.find((s) => s.seat === 1)!;
    expect(seat1.wins).toBe(2);
  });
});
