/**
 * Integration tests for getCardStats against a real in-memory libsql database.
 *
 * getCardStats is entirely module-mocked in route tests, meaning the
 * deck-colors fallback, Wilson CI computation, and low-sample flagging
 * never execute in any existing test. This file exercises all of those
 * paths against a real SQL engine via in-memory libsql.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import { createMemDb, insertCard, insertCubeSnapshot, insertCubeCard, insertDraft, insertPickEvent, insertMatch, insertDeckCard, insertPrivacyOptOut } from "../../__tests__/testDb";
import { MIN_SAMPLE_SIZE } from "../../../constants";

// getCardStats calls getClient() internally — redirect to the in-memory instance.
vi.mock("../../client", () => ({
  getClient: vi.fn(),
}));
import { getClient } from "../../client";
import { getCardStats } from "./cardStats";

let db: Client;

beforeEach(async () => {
  db = await createMemDb();
  vi.mocked(getClient).mockResolvedValue(db);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedBasicCard(
  cardId: number,
  name: string,
  colors: string[] = [],
  extraScryfall: object = {}
): Promise<void> {
  await insertCard(db, cardId, name, {
    scryfallJson: {
      oracle_text: "Test oracle text.",
      type_line: "Instant",
      mana_cost: "{R}",
      color_identity: colors,
      ...extraScryfall,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getCardStats", () => {
  it("returns null when the card does not exist in the database", async () => {
    const result = await getCardStats({ card_name: "Nonexistent Card" });
    expect(result).toBeNull();
  });

  it("returns zero pick stats when the card exists but has no draft history", async () => {
    await seedBasicCard(1, "Lightning Bolt", ["R"]);
    // No cube snapshots, drafts, or pick events

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    expect(result).not.toBeNull();
    expect(result!.card_name).toBe("Lightning Bolt");
    expect(result!.pick.drafts_in_pool).toBe(0);
    expect(result!.pick.times_picked).toBe(0);
    expect(result!.play).toBeNull();
    expect(result!.wins).toBeNull();
  });

  it("includes scryfall fields from the stored JSON blob", async () => {
    await seedBasicCard(1, "Lightning Bolt", ["R"], {
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      type_line: "Instant",
      mana_cost: "{R}",
    });

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    expect(result!.oracle_text).toBe("Lightning Bolt deals 3 damage to any target.");
    expect(result!.type_line).toBe("Instant");
    expect(result!.mana_cost).toBe("{R}");
    expect(result!.color_identity).toEqual(["R"]);
  });

  it("returns pick stats when the card has been picked in a draft", async () => {
    await seedBasicCard(1, "Lightning Bolt");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540); // 540 copies in cube
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 5, 1, 1); // picked at position 5

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    expect(result!.pick.drafts_in_pool).toBe(1);
    expect(result!.pick.times_picked).toBe(1);
    expect(result!.pick.avg_pick).toBe(5);
  });

  it("computes play rate when decklist data is available", async () => {
    await seedBasicCard(1, "Lightning Bolt");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 5, 1, 1);
    // Seat 1 maindecked it
    await insertDeckCard(db, "d1", 1, 1, "deck");

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    expect(result!.play).not.toBeNull();
    // 1 pool with decklist, 1 maindecked → play_rate = 1.0
    expect(result!.play!.play_rate).toBeCloseTo(1.0);
    expect(result!.play!.filtered).toBe(false);
  });

  it("falls back to overall play stats when deck_colors filter yields no data", async () => {
    // Set up two drafts: one with a UR deck, one with a RW deck.
    // The card is maindecked in both. Requesting deck_colors=G (no green decks)
    // should trigger the fallback and return overall stats with filtered=false.
    await seedBasicCard(1, "Lightning Bolt", ["R"]);
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 5, 1, 1);
    // Seat 1 maindecked Lightning Bolt; insert a red card so the deck is inferred as R
    await insertDeckCard(db, "d1", 1, 1, "deck");

    const result = await getCardStats({
      card_name: "Lightning Bolt",
      deck_colors: "G", // No green decks exist
    });

    // Filtered stats will be empty → fallback to overall
    expect(result!.play).not.toBeNull();
    expect(result!.play!.filtered).toBe(false);
  });

  it("computes win rate when match data is available", async () => {
    await seedBasicCard(1, "Lightning Bolt");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 5, 1, 1);
    await insertDeckCard(db, "d1", 1, 1, "deck");
    // Seat 1 goes 2-1 against seat 2
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    expect(result!.wins).not.toBeNull();
    expect(result!.wins!.game_wins).toBe(2);
    expect(result!.wins!.game_losses).toBe(1);
    // win_rate = 2/(2+1) ≈ 0.667
    expect(result!.wins!.win_rate).toBeCloseTo(2 / 3, 3);
    // Wilson CI: lower ≤ center ≤ upper
    const ci = result!.wins!.win_rate_ci;
    expect(ci.lower).toBeLessThanOrEqual(ci.center);
    expect(ci.center).toBeLessThanOrEqual(ci.upper);
  });

  it("flags low_sample when the card is maindecked fewer than MIN_SAMPLE_SIZE times", async () => {
    await seedBasicCard(1, "Rare Card");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 3, 1, 1);
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const result = await getCardStats({ card_name: "Rare Card" });

    // seats_maindecked = 1, which is < MIN_SAMPLE_SIZE (5)
    expect(result!.wins).not.toBeNull();
    expect(result!.wins!.seats_maindecked).toBe(1);
    expect(result!.wins!.low_sample).toBe(true);
    expect(MIN_SAMPLE_SIZE).toBeGreaterThan(1); // Sanity: ensure constant is meaningful
  });

  it("does not flag low_sample when maindecked count meets MIN_SAMPLE_SIZE", async () => {
    // Create MIN_SAMPLE_SIZE drafts, each with the card maindecked
    await seedBasicCard(1, "Popular Card");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);

    for (let i = 0; i < MIN_SAMPLE_SIZE; i++) {
      const draftId = `d${i + 1}`;
      await insertDraft(db, draftId, { cubeSnapshotId: 1 });
      await insertPickEvent(db, draftId, 5, 1, 1);
      await insertDeckCard(db, draftId, 1, 1, "deck");
      await insertMatch(db, draftId, 1, 2, 2, 1);
    }

    const result = await getCardStats({ card_name: "Popular Card" });

    expect(result!.wins).not.toBeNull();
    expect(result!.wins!.seats_maindecked).toBe(MIN_SAMPLE_SIZE);
    expect(result!.wins!.low_sample).toBe(false);
  });

  it("excludes opted-out seats from win stats", async () => {
    await seedBasicCard(1, "Lightning Bolt");
    await insertCubeSnapshot(db, 1);
    await insertCubeCard(db, 1, 1, 540);
    await insertDraft(db, "d1", { cubeSnapshotId: 1 });
    await insertPickEvent(db, "d1", 5, 1, 1);
    await insertPickEvent(db, "d1", 6, 2, 1); // seat 2 also picked it (same card_id, different pick)
    // Give seat 2 its own pick slot
    await db.execute({
      sql: `UPDATE pick_events SET seat = 2 WHERE draft_id = 'd1' AND pick_n = 6`,
      args: [],
    });
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertDeckCard(db, "d1", 2, 1, "deck");
    // Seat 2 opted out
    await insertPrivacyOptOut(db, "d1", 2);
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const result = await getCardStats({ card_name: "Lightning Bolt" });

    // Seat 2's win data should be excluded
    expect(result!.wins).not.toBeNull();
    // Only seat 1's match contribution counts
    expect(result!.wins!.seats_maindecked).toBe(1);
  });
});
