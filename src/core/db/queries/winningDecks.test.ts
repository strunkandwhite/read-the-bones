/**
 * Integration tests for getWinningDecksByColor against a real in-memory libsql database.
 *
 * The function is entirely module-mocked in route tests, meaning its
 * opt-out exclusion, two-key ranking, top-4 cut, and overlap computation
 * never execute in any existing test. This file exercises all of those
 * paths against a real SQL engine via in-memory libsql.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createMemDb,
  insertCard,
  insertDraft,
  insertDeckCard,
  insertMatch,
  insertPrivacyOptOut,
} from "../__tests__/testDb";
import { getWinningDecksByColor } from "./winningDecks";

let db: Client;

beforeEach(async () => {
  db = await createMemDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert a card with color identity suitable for deck-color inference. */
async function insertColorCard(
  cardId: number,
  colors: string[],
  cardName = `Card${cardId}`
): Promise<void> {
  await insertCard(db, cardId, cardName, {
    scryfallJson: { color_identity: colors },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWinningDecksByColor", () => {
  it("returns empty result when no decklist data exists", async () => {
    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    expect(result.color_pair).toBe("UB");
    expect(result.decks).toHaveLength(0);
    expect(result.overlap_cards).toHaveLength(0);
  });

  it("returns empty result when no seats match the requested color pair", async () => {
    // Seat 1 has a pure red deck
    await insertColorCard(1, ["R"]);
    await insertDraft(db, "d1");
    await insertDeckCard(db, "d1", 1, 1, "deck");
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    expect(result.decks).toHaveLength(0);
  });

  it("includes a seat that matches the requested color pair", async () => {
    // Seat 1: UB deck (blue + black cards in roughly equal proportions)
    // Insert 5 blue cards and 5 black cards so inferDeckColor returns "UB"
    for (let i = 1; i <= 5; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 10, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "d1");
    for (let i = 1; i <= 5; i++) {
      await insertDeckCard(db, "d1", 1, i, "deck");
      await insertDeckCard(db, "d1", 1, i + 10, "deck");
    }
    await insertMatch(db, "d1", 1, 2, 2, 1);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    expect(result.decks).toHaveLength(1);
    expect(result.decks[0].seat).toBe(1);
    expect(result.decks[0].draft_id).toBe("d1");
    expect(result.decks[0].record.match_wins).toBe(1);
    expect(result.decks[0].record.game_wins).toBe(2);
  });

  it("excludes opted-out seats", async () => {
    // Two UB seats; seat 2 opts out
    for (let i = 1; i <= 5; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 10, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "d1");
    for (let i = 1; i <= 5; i++) {
      await insertDeckCard(db, "d1", 1, i, "deck");
      await insertDeckCard(db, "d1", 2, i, "deck");
      await insertDeckCard(db, "d1", 1, i + 10, "deck");
      await insertDeckCard(db, "d1", 2, i + 10, "deck");
    }
    await insertMatch(db, "d1", 1, 2, 2, 1);
    await insertPrivacyOptOut(db, "d1", 2);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    // Seat 2 opted out; only seat 1 should appear
    const seatNums = result.decks.map((d) => d.seat);
    expect(seatNums).not.toContain(2);
    expect(seatNums).toContain(1);
  });

  it("ranks by match wins descending then game win rate descending", async () => {
    // Three UB seats with different records:
    //   Seat 1: 2 match wins, 4 game wins, 2 game losses (GWR = 0.667)
    //   Seat 2: 2 match wins, 3 game wins, 2 game losses (GWR = 0.600)
    //   Seat 3: 1 match win
    for (let i = 1; i <= 5; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 10, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "d1");
    for (let seat = 1; seat <= 3; seat++) {
      for (let i = 1; i <= 5; i++) {
        await insertDeckCard(db, "d1", seat, i, "deck");
        await insertDeckCard(db, "d1", seat, i + 10, "deck");
      }
    }
    // Seat 1 vs 4: seat1 wins 2-1 (match win)
    await insertMatch(db, "d1", 1, 4, 2, 1);
    // Seat 1 vs 5: seat1 wins 2-1 (match win)
    await insertMatch(db, "d1", 1, 5, 2, 1);
    // Seat 2 vs 4: seat2 wins 2-0 (match win, but fewer game wins when normalized isn't needed here)
    await insertMatch(db, "d1", 2, 4, 2, 0);
    // Seat 2 vs 5: seat2 wins 1-0 — actually let's set to give 3 game wins, 2 losses total
    await insertMatch(db, "d1", 2, 5, 1, 2);
    // Seat 3 vs 4: seat3 wins 2-1
    await insertMatch(db, "d1", 3, 4, 2, 1);
    // Seat 3 vs 5: seat3 loses 0-2
    await insertMatch(db, "d1", 3, 5, 0, 2);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });

    // Seat 1: 2 match wins, game record: (2+2)/(2+1+2+1)=4/6≈0.667
    // Seat 2: 1 match win (2-0) + 1 loss (1-2) = 1 match win, game: 3/5=0.6
    // Seat 3: 1 match win, game: 2/5=0.4
    // Expected order by match wins: seat1 (2) > seat2 (1) = seat3 (1)
    // Within 1-match-win group: seat2 (GWR 0.6) > seat3 (GWR 0.4)
    expect(result.decks[0].seat).toBe(1);
    expect(result.decks[1].seat).toBe(2);
    expect(result.decks[2].seat).toBe(3);
  });

  it("takes only the top 4 decks", async () => {
    // Create 5 UB seats all with 1 match win each
    for (let i = 1; i <= 20; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 100, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "d1");
    // 5 UB seats (1-5), 5 non-UB opponents (6-10)
    for (let seat = 1; seat <= 5; seat++) {
      for (let i = seat; i <= seat + 3; i++) {
        await insertDeckCard(db, "d1", seat, i, "deck");
        await insertDeckCard(db, "d1", seat, i + 100, "deck");
      }
    }
    // Each UB seat beats a non-UB opponent
    for (let seat = 1; seat <= 5; seat++) {
      const opponent = seat + 5;
      await insertMatch(db, "d1", seat, opponent, 2, 0);
    }

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    expect(result.decks).toHaveLength(4);
  });

  it("computes overlap cards appearing in 2+ of the top decks", async () => {
    // Two UB seats that both maindeck "Drown in the Loch" (card 99)
    await insertColorCard(99, ["U", "B"], "Drown in the Loch");
    // Fill out the rest with seat-unique cards
    for (let i = 1; i <= 9; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 10, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "d1");
    for (let seat = 1; seat <= 2; seat++) {
      // Shared card
      await insertDeckCard(db, "d1", seat, 99, "deck");
      // 5 blue + 5 black unique per seat to establish UB color
      for (let i = (seat - 1) * 5 + 1; i <= (seat - 1) * 5 + 5; i++) {
        await insertDeckCard(db, "d1", seat, i, "deck");
        await insertDeckCard(db, "d1", seat, i + 10, "deck");
      }
    }
    await insertMatch(db, "d1", 1, 3, 2, 1);
    await insertMatch(db, "d1", 2, 3, 2, 0);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });

    // Both seats should appear in the top decks
    expect(result.decks.length).toBeGreaterThanOrEqual(2);
    // "Drown in the Loch" should be in overlap (count = 2)
    const drowned = result.overlap_cards.find((c) => c.name === "Drown in the Loch");
    expect(drowned).toBeDefined();
    expect(drowned!.count).toBe(2);
  });

  it("returns no overlap when all top deck cards are unique across decks", async () => {
    // Two UB seats each with entirely different cards
    for (let i = 1; i <= 10; i++) {
      await insertColorCard(i, ["U"], `UniqueBlue${i}`);
      await insertColorCard(i + 100, ["B"], `UniqueBlack${i}`);
    }
    await insertDraft(db, "d1");
    // Seat 1: cards 1-5 (blue) + cards 101-105 (black)
    for (let i = 1; i <= 5; i++) {
      await insertDeckCard(db, "d1", 1, i, "deck");
      await insertDeckCard(db, "d1", 1, i + 100, "deck");
    }
    // Seat 2: cards 6-10 (blue) + cards 106-110 (black) — completely different cards
    for (let i = 6; i <= 10; i++) {
      await insertDeckCard(db, "d1", 2, i, "deck");
      await insertDeckCard(db, "d1", 2, i + 100, "deck");
    }
    await insertMatch(db, "d1", 1, 3, 2, 1);
    await insertMatch(db, "d1", 2, 3, 2, 1);

    const result = await getWinningDecksByColor(db, { color_pair: "UB" });
    expect(result.overlap_cards).toHaveLength(0);
  });

  it("filters to the requested draft_ids when provided", async () => {
    // Two UB seats in different drafts
    for (let i = 1; i <= 5; i++) {
      await insertColorCard(i, ["U"], `Island${i}`);
      await insertColorCard(i + 10, ["B"], `Swamp${i}`);
    }
    await insertDraft(db, "draft-included");
    await insertDraft(db, "draft-excluded");
    for (let i = 1; i <= 5; i++) {
      await insertDeckCard(db, "draft-included", 1, i, "deck");
      await insertDeckCard(db, "draft-included", 1, i + 10, "deck");
      await insertDeckCard(db, "draft-excluded", 1, i, "deck");
      await insertDeckCard(db, "draft-excluded", 1, i + 10, "deck");
    }
    await insertMatch(db, "draft-included", 1, 2, 2, 1);
    await insertMatch(db, "draft-excluded", 1, 2, 2, 1);

    const result = await getWinningDecksByColor(db, {
      color_pair: "UB",
      draft_ids: ["draft-included"],
    });

    const draftIds = result.decks.map((d) => d.draft_id);
    expect(draftIds.every((id) => id === "draft-included")).toBe(true);
    expect(draftIds).not.toContain("draft-excluded");
  });
});
