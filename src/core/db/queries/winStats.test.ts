/**
 * Integration tests for getAllCardWinStats against a real in-memory libsql
 * database. The bulk query pre-aggregates match results per (draft_id, seat)
 * so the planner can seek deck_cards on its full key; these tests pin the
 * aggregation semantics that rewrite must preserve.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createMemDb,
  insertCard,
  insertDraft,
  insertDeckCard,
  insertMatch,
} from "../__tests__/testDb";
import { getAllCardWinStats } from "./winStats";

let db: Client;

beforeEach(async () => {
  db = await createMemDb();
});

describe("getAllCardWinStats", () => {
  it("returns an empty map when there is no decklist data", async () => {
    const result = await getAllCardWinStats(db);
    expect(result.size).toBe(0);
  });

  it("sums a seat's wins and losses across all its matches", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // Seat 1 appears as seat1 in one match and seat2 in another.
    await insertMatch(db, "d1", 1, 2, 2, 1); // seat1 wins 2, loses 1
    await insertMatch(db, "d1", 1, 3, 0, 2); // seat1 wins 0, loses 2
    await insertMatch(db, "d1", 2, 3, 2, 0); // does not involve seat 1

    const result = await getAllCardWinStats(db);
    const bolt = result.get("bolt");
    expect(bolt).toBeDefined();
    // 2 wins vs 3 losses -> 0.4
    expect(bolt!.win_rate).toBe(0.4);
    expect(bolt!.sample_size).toBe(1);
  });

  it("counts one sample per (draft, seat) that maindecked the card", async () => {
    await insertDraft(db, "d1");
    await insertDraft(db, "d2");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertDeckCard(db, "d1", 2, 1, "deck");
    await insertDeckCard(db, "d2", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 0);
    await insertMatch(db, "d2", 1, 2, 1, 1);

    const result = await getAllCardWinStats(db);
    // d1 seat1, d1 seat2, d2 seat1 = 3 samples.
    expect(result.get("bolt")!.sample_size).toBe(3);
    // wins 2+0+1 = 3, losses 0+2+1 = 3 -> 0.5
    expect(result.get("bolt")!.win_rate).toBe(0.5);
  });

  it("ignores sideboard cards", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "sideboard");
    await insertMatch(db, "d1", 1, 2, 2, 0);

    const result = await getAllCardWinStats(db);
    expect(result.has("bolt")).toBe(false);
  });

  it("excludes seats with no match data", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // No matches at all.

    const result = await getAllCardWinStats(db);
    expect(result.has("bolt")).toBe(false);
  });

  it("aggregates two cards independently", async () => {
    await insertDraft(db, "d1");
    await insertCard(db, 1, "Bolt");
    await insertCard(db, 2, "Counterspell");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertDeckCard(db, "d1", 2, 2, "deck");
    await insertMatch(db, "d1", 1, 2, 3, 1);

    const result = await getAllCardWinStats(db);
    expect(result.get("bolt")!.win_rate).toBe(0.75);
    expect(result.get("counterspell")!.win_rate).toBe(0.25);
  });
});
