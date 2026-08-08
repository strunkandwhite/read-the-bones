/**
 * Integration tests for the ranked-available worth-model extensions against
 * in-memory libsql: the worth-table join, horizon semantics (with and
 * without a seat), committed-colors flags, nulls-last score sorting, pair
 * supply, and the no-include_worth regression path.
 *
 * The worth table itself is A2's surface (worth.test.ts); here getWorthTable
 * is mocked with a hand-built table so every joined value is deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createMemDb,
  insertCard,
  insertCubeSnapshot,
  insertCubeCard,
  insertDraft,
  insertPickEvent,
  insertPrivacyOptOut,
} from "../../__tests__/testDb";
import { danger, pickCdf, type WorthCard } from "../../../worthModel";

// rankAvailableCards calls getClient() internally — redirect to the memdb.
vi.mock("../../client", () => ({
  getClient: vi.fn(),
}));
// The worth table is expensive to assemble and belongs to worth.test.ts —
// serve a canned table so joined fields are exact.
vi.mock("./worth", () => ({
  getWorthTable: vi.fn(),
}));
import { getClient } from "../../client";
import { getWorthTable } from "./worth";
import { rankAvailableCards } from "./rankedAvailable";

const SIGMA = 0.5;

function makeWorthCard(
  name: string,
  overrides: Partial<WorthCard> = {},
): WorthCard {
  return {
    card_name: name,
    colors: "",
    is_land: false,
    in_current_cube: true,
    geomean: 10,
    games: 200,
    wins: 100,
    losses: 100,
    wr: 0.5,
    se: 0.035,
    delta: 0,
    expected: 0,
    pvi: 0,
    worth: 0.01,
    prior_only: false,
    no_data: false,
    act_by: null,
    ...overrides,
  };
}

// Worth-table fixture joined against the cube below:
//   Alpha  (U) worth 0.05, geo 5    — early card, high worth
//   Beta   (R) worth 0.02, geo 100  — late card, low danger at pick 1
//   Gamma  (W) worth 0.04, geo 30
//   Nully  (U) worth 0.03, geo null — unpriced: danger/pick_value null
//   Delta  (G) absent from the worth table entirely
function worthTableFixture() {
  return {
    cards: [
      makeWorthCard("Alpha", { colors: "U", worth: 0.05, geomean: 5 }),
      makeWorthCard("Beta", { colors: "R", worth: 0.02, geomean: 100 }),
      makeWorthCard("Gamma", { colors: "W", worth: 0.04, geomean: 30 }),
      makeWorthCard("Nully", { colors: "U", worth: 0.03, geomean: null }),
    ],
    model: {
      a: 0,
      b: 0,
      tau: 0.02,
      tau0: 0.025,
      sigma: SIGMA,
      tauA: 0.01,
      grandMean: 0.5,
      kappa: 0.5,
      baselines: {},
      pairEdges: { UR: 0.03, WG: 0.01 },
    },
    computedAt: "2026-08-01T00:00:00.000Z",
    cardsFit: 4,
  };
}

let db: Client;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await createMemDb();
  vi.mocked(getClient).mockResolvedValue(db);
  vi.mocked(getWorthTable).mockResolvedValue(worthTableFixture());
});

// Five-card cube on a 10-seat, 45-picks-per-player draft. No picks are
// seeded, so every card is available at any before_pick_n.
async function seedDraft(): Promise<void> {
  await insertCard(db, 1, "Alpha");
  await insertCard(db, 2, "Beta");
  await insertCard(db, 3, "Gamma");
  await insertCard(db, 4, "Delta");
  await insertCard(db, 5, "Nully");
  await insertCubeSnapshot(db, 1);
  for (const cardId of [1, 2, 3, 4, 5]) {
    await insertCubeCard(db, 1, cardId);
  }
  await insertDraft(db, "d1", { numSeats: 10, cubeSnapshotId: 1 });
}

function findCard(
  result: Awaited<ReturnType<typeof rankAvailableCards>>,
  name: string,
) {
  const card = result.cards.find((c) => c.card_name === name);
  expect(card, `card ${name} missing from result`).toBeDefined();
  return card!;
}

describe("rankAvailableCards worth-model extensions", () => {
  it("does not fetch the worth table or emit worth fields when include_worth is not set (regression)", async () => {
    await seedDraft();

    const result = await rankAvailableCards({
      draft_id: "d1",
      before_pick_n: 1,
    });

    expect(getWorthTable).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("horizon");
    expect(result).not.toHaveProperty("pair_supply");
    expect(result.cards.length).toBe(5);
    for (const card of result.cards) {
      expect(card).not.toHaveProperty("worth");
      expect(card).not.toHaveProperty("danger");
      expect(card).not.toHaveProperty("pick_value");
      expect(card).not.toHaveProperty("color_flag");
      expect(card).not.toHaveProperty("first_pick_score");
    }
  });

  it("joins worth/danger/pick_value per card from the worth table", async () => {
    await seedDraft();

    const result = await rankAvailableCards({
      draft_id: "d1",
      before_pick_n: 1,
      seat: 1,
      include_worth: true,
    });

    expect(getWorthTable).toHaveBeenCalledTimes(1);

    const alpha = findCard(result, "Alpha");
    expect(alpha.worth).toBe(0.05);
    // Danger uses the worth table's geomean and sigma over the picks
    // strictly between now and the seat's next turn (horizon 19 -> window 18orizon.
    expect(alpha.danger).toBeCloseTo(danger(1, 18, 5, SIGMA), 10);
    expect(alpha.pick_value).toBeCloseTo(0.05 * alpha.danger!, 10);

    // Unpriced card: worth carries over but danger and pick_value are null.
    const nully = findCard(result, "Nully");
    expect(nully.worth).toBe(0.03);
    expect(nully.danger).toBeNull();
    expect(nully.pick_value).toBeNull();

    // Card absent from the worth table: all three fields null.
    const delta = findCard(result, "Delta");
    expect(delta.worth).toBeNull();
    expect(delta.danger).toBeNull();
    expect(delta.pick_value).toBeNull();

    // committed_colors was not provided — no flag fields, even with worth on.
    expect(alpha).not.toHaveProperty("color_flag");
    expect(alpha).not.toHaveProperty("first_pick_score");
  });

  it("floors danger at overdueness for a card past its window", async () => {
    await seedDraft();

    const result = await rankAvailableCards({
      draft_id: "d1",
      before_pick_n: 30,
      seat: 1,
      include_worth: true,
    });

    // Geo-5 Alpha still available at pick 30 is long overdue: F(30) ≈ 0.9998
    // dominates the sagging conditional hazard, so danger reports the floor.
    // Reverting the endpoint to raw danger() ("it wheeled, it'll wheel
    // again") must fail this assertion — this is the MCP recommendation path.
    const alpha = findCard(result, "Alpha");
    expect(alpha.danger).toBeCloseTo(pickCdf(30, 5, SIGMA), 10);
    expect(alpha.pick_value).toBeCloseTo(0.05 * alpha.danger!, 10);
  });

  describe("horizon", () => {
    it("measures to the seat's NEXT turn, counting before_pick_n as spent (off-by-one decision)", async () => {
      await seedDraft();

      // Seat 1 at before_pick_n = 1 with 10 seats is picking RIGHT NOW; the
      // danger window for cards it passes runs to its next turn at pick 20:
      // picksUntilNextTurn(1, 1) = 19 — not 0 and not 20.
      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 1,
        seat: 1,
        include_worth: true,
      });

      expect(result.horizon).toBe(19);
    });

    it("falls back to the remaining pick count when the seat never picks again", async () => {
      await seedDraft();

      // Pick 450 is the last pick of the draft (10 seats × 45): no seat has
      // a turn after it, so the horizon degrades to totalPicks − 450 = 0.
      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 450,
        seat: 1,
        include_worth: true,
      });

      expect(result.horizon).toBe(0);
    });

    it("defaults to one full snake turn (2 × numSeats) without a seat", async () => {
      await seedDraft();

      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 7,
        include_worth: true,
      });

      expect(result.horizon).toBe(20);
    });
  });

  describe("committed_colors", () => {
    it("adds color_flag and first_pick_score per row (empty string = uncommitted)", async () => {
      await seedDraft();

      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 1,
        seat: 1,
        committed_colors: "",
        include_worth: true,
      });

      // Alpha (U) fits the best pair UR: no commitment cost.
      const alpha = findCard(result, "Alpha");
      expect(alpha.color_flag).toBe(0);
      expect(alpha.first_pick_score).toBeCloseTo(alpha.pick_value!, 10);

      // Gamma (W) only fits WG: κ·(0.01 − 0.03) = −0.01.
      const gamma = findCard(result, "Gamma");
      expect(gamma.color_flag).toBeCloseTo(-0.01, 10);
      expect(gamma.first_pick_score).toBeCloseTo(gamma.pick_value! - 0.01, 10);

      // Card unknown to the worth table has no color identity: flag is null,
      // not zero.
      const delta = findCard(result, "Delta");
      expect(delta.color_flag).toBeNull();
      expect(delta.first_pick_score).toBeNull();
    });
  });

  describe("score sorting", () => {
    it("sorts by pick_value descending with nulls last", async () => {
      await seedDraft();

      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 1,
        seat: 1,
        sort_by: "pick_value",
        include_worth: true,
      });

      // pick_value at pick 1, horizon 19: Alpha ≈ .0499 > Gamma ≈ .0083 >
      // Beta ≈ 1e-5; Delta and Nully have null pick_value and sort last.
      const names = result.cards.map((card) => card.card_name);
      expect(names.slice(0, 3)).toEqual(["Alpha", "Gamma", "Beta"]);
      expect(names.slice(3).sort()).toEqual(["Delta", "Nully"]);
    });

    it("sorts by first_pick_score descending with nulls last", async () => {
      await seedDraft();

      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 1,
        seat: 1,
        committed_colors: "",
        sort_by: "first_pick_score",
        include_worth: true,
      });

      // Gamma's −0.01 flag drops it below Beta — a different order than
      // pick_value, proving the flag participates in the sort.
      const names = result.cards.map((card) => card.card_name);
      expect(names.slice(0, 3)).toEqual(["Alpha", "Beta", "Gamma"]);
      expect(names.slice(3).sort()).toEqual(["Delta", "Nully"]);
    });
  });

  describe("pair_supply", () => {
    it("counts obtainable positive-worth cards per pair at the seat's slots", async () => {
      await seedDraft();

      const result = await rankAvailableCards({
        draft_id: "d1",
        before_pick_n: 1,
        seat: 1,
        include_worth: true,
      });

      expect(Object.keys(result.pair_supply!).sort()).toEqual(
        ["WU", "WB", "WR", "WG", "UB", "UR", "UG", "BR", "BG", "RG"].sort(),
      );
      // Seat 1 slots are 1, 20, 21, 40, … With σ = 0.5 a card survives a
      // slot (p ≥ 0.5) iff slot ≤ geomean: UR takes Alpha (geo 5) at slot 1
      // and Beta (geo 100) at slot 20; nothing survives to slot 21+.
      expect(result.pair_supply!.UR).toBe(2);
      // No positive-worth B or G cards exist at all.
      expect(result.pair_supply!.BG).toBe(0);
    });
  });
});

describe("rankAvailableCards — pick-score inputs", () => {
  it("excludes in-progress drafts from geomean_pick", async () => {
    // A card untaken in a 'drafting' draft must not be scored as unwanted:
    // it may simply not have come up yet.
    await insertCubeSnapshot(db, 1);
    await insertCard(db, 1, "Alpha");
    await insertCubeCard(db, 1, 1);
    await insertDraft(db, "done", { phase: "complete", cubeSnapshotId: 1 });
    await insertDraft(db, "live", { phase: "drafting", cubeSnapshotId: 1 });
    await insertPickEvent(db, "done", 10, 1, 1);

    const result = await rankAvailableCards({
      draft_id: "live",
      before_pick_n: 5,
    });

    const card = result.cards.find((c) => c.card_name === "Alpha")!;
    // Only the completed draft counts, so the score is that single pick.
    expect(card.geomean_pick).toBeCloseTo(10, 1);
    expect(card.drafts_in_pool).toBe(1);
  });

  it("excludes opted-out seats from geomean_pick", async () => {
    await insertCubeSnapshot(db, 1);
    await insertCard(db, 1, "Alpha");
    await insertCubeCard(db, 1, 1);
    // The opted-out pick lives in a separate historical draft, not the one
    // being ranked: a pick inside "current" itself would remove the card
    // from availability entirely (Step 1's getAvailableCards is correctly
    // opt-out-blind — it reports real remaining supply), so it would never
    // reach result.cards to be scored at all.
    await insertDraft(db, "current", { phase: "complete", cubeSnapshotId: 1 });
    await insertDraft(db, "hist", { phase: "complete", cubeSnapshotId: 1 });
    await insertPickEvent(db, "hist", 10, 3, 1);
    await insertPrivacyOptOut(db, "hist", 3);

    const result = await rankAvailableCards({
      draft_id: "current",
      before_pick_n: 500,
    });

    const card = result.cards.find((c) => c.card_name === "Alpha")!;
    // The only pick was by an opted-out seat, so the card reads as untaken
    // in both drafts and takes the half-weight pool-size penalty in each.
    // The cube here holds a single card, so SUM(qty) makes the pool size 1
    // — not the 540-card production default.
    expect(card.geomean_pick).toBeCloseTo(1, 1);
    expect(card.times_picked).toBe(0);
  });

  it("keeps the real session gap for a card that sat out a session", async () => {
    // Four sessions; Beta is in the cube for sessions 1 and 3 only. Numbering
    // per card would compress that two-session gap to one and overweight the
    // older pick (18.84 instead of 17.76).
    await insertCubeSnapshot(db, 1); // sessions 0 and 2 — no Beta
    await insertCubeSnapshot(db, 2); // sessions 1 and 3 — Beta present
    await insertCard(db, 1, "Alpha");
    await insertCard(db, 2, "Beta");
    await insertCubeCard(db, 1, 1);
    await insertCubeCard(db, 2, 1);
    await insertCubeCard(db, 2, 2);
    await insertDraft(db, "s0", { date: "2026-07-17", cubeSnapshotId: 1 });
    await insertDraft(db, "s1", { date: "2026-05-23", cubeSnapshotId: 2 });
    await insertDraft(db, "s2", { date: "2026-03-30", cubeSnapshotId: 1 });
    await insertDraft(db, "s3", { date: "2026-03-08", cubeSnapshotId: 2 });
    await insertPickEvent(db, "s1", 10, 1, 2);
    await insertPickEvent(db, "s3", 40, 1, 2);

    // Rank against s1 rather than s0 (Beta isn't in s0's cube snapshot at
    // all — see the fixture comment above). before_pick_n must land before
    // s1's own pick_n 10, or Beta's remaining qty in s1 goes to zero and it
    // drops out of availability entirely; the historical geomean below draws
    // on all completed drafts regardless of this value.
    const result = await rankAvailableCards({
      draft_id: "s1",
      before_pick_n: 1,
    });

    // exp((0.5^(1/4)*ln(10) + 0.5^(3/4)*ln(40)) / (0.8409 + 0.5946)) = 17.76
    const beta = result.cards.find((c) => c.card_name === "Beta")!;
    expect(beta.geomean_pick).toBeCloseTo(17.8, 1);
  });
});
