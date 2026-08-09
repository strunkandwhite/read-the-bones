/**
 * Integration tests for the worth-table assembly against in-memory libsql.
 *
 * Exercises the data-hygiene rules (stats-phase filtering, land exclusion,
 * prior-only/no-data states), the module-level cache, and the
 * excludeDraftId LODO escape hatch.
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
  insertMatch,
  insertDeckCard,
} from "../../__tests__/testDb";

// getWorthTable calls getClient() internally — redirect to the memdb.
vi.mock("../../client", () => ({
  getClient: vi.fn(),
}));
import { getClient } from "../../client";
import { getWorthTable, _resetWorthCache } from "./worth";

let db: Client;

beforeEach(async () => {
  db = await createMemDb();
  vi.mocked(getClient).mockResolvedValue(db);
  _resetWorthCache();
});

// ---------------------------------------------------------------------------
// Fixture
//
// Two stats-phase drafts (d1 complete, d2 playing) sharing cube snapshot 1,
// plus an in-progress draft d3 on snapshot 2 (the "current cube"). Seats:
// seat 1 drafts UR both times, seat 2 drafts WG. Matches give the UR seat a
// 140-60 record and the WG seat 60-140, so U/R baselines are 0.70 and W/G
// baselines are 0.30.
//
// Cards (snapshot 1 unless noted):
//   1 Alpha Strike   (R)         picked d1@2,  d2@3;  both s1 decks → 200 games
//   2 Beta Blocker   (W)         picked d1@20, d2@30; both s2 decks → 200 games
//   3 Gamma Field    (Land, C)   picked d1@10, d2@12; both s1 decks → 200 games
//   4 Delta Sleeper  (G)         picked d1@15, unpicked in d2; no decks → 0 games
//   5 Epsilon Ghost  (W)         snapshot 2 only → no pick history at all
//   7 Ultramarine    (U)         picked d1@5,  d2@6;  both s1 decks → 200 games
//   8 Greenwood      (G)         picked d1@25, d2@35; both s2 decks → 200 games
//   9 Nullstone      (Artifact)  picked d1@40, d2@41; both s1 decks → 200 games
// ---------------------------------------------------------------------------

async function seedWorthFixture(): Promise<void> {
  await insertCard(db, 1, "Alpha Strike", {
    scryfallJson: { type_line: "Creature — Human", color_identity: ["R"] },
  });
  await insertCard(db, 2, "Beta Blocker", {
    scryfallJson: { type_line: "Creature — Wall", color_identity: ["W"] },
  });
  await insertCard(db, 3, "Gamma Field", {
    scryfallJson: { type_line: "Land — Island", color_identity: [] },
  });
  await insertCard(db, 4, "Delta Sleeper", {
    scryfallJson: { type_line: "Sorcery", color_identity: ["G"] },
  });
  await insertCard(db, 5, "Epsilon Ghost", {
    scryfallJson: { type_line: "Creature — Spirit", color_identity: ["W"] },
  });
  await insertCard(db, 7, "Ultramarine", {
    scryfallJson: { type_line: "Instant", color_identity: ["U"] },
  });
  await insertCard(db, 8, "Greenwood", {
    scryfallJson: { type_line: "Creature — Elf", color_identity: ["G"] },
  });
  await insertCard(db, 9, "Nullstone", {
    scryfallJson: { type_line: "Artifact", color_identity: [] },
  });

  await insertCubeSnapshot(db, 1);
  for (const cardId of [1, 2, 3, 4, 7, 8, 9]) {
    await insertCubeCard(db, 1, cardId);
  }
  await insertCubeSnapshot(db, 2);
  for (const cardId of [1, 2, 5, 7, 8]) {
    await insertCubeCard(db, 2, cardId);
  }

  await insertDraft(db, "d1", { date: "2026-01-01", phase: "complete", cubeSnapshotId: 1 });
  await insertDraft(db, "d2", { date: "2026-02-01", phase: "playing", cubeSnapshotId: 1 });
  // Most recent draft by date; still drafting, so its picks/games must not
  // leak into the model — but its cube defines in_current_cube.
  await insertDraft(db, "d3", { date: "2026-03-01", phase: "drafting", cubeSnapshotId: 2 });

  // d1 picks
  await insertPickEvent(db, "d1", 2, 1, 1);
  await insertPickEvent(db, "d1", 5, 1, 7);
  await insertPickEvent(db, "d1", 10, 1, 3);
  await insertPickEvent(db, "d1", 15, 2, 4);
  await insertPickEvent(db, "d1", 20, 2, 2);
  await insertPickEvent(db, "d1", 25, 2, 8);
  await insertPickEvent(db, "d1", 40, 1, 9);
  // d2 picks (Delta Sleeper deliberately unpicked)
  await insertPickEvent(db, "d2", 3, 1, 1);
  await insertPickEvent(db, "d2", 6, 1, 7);
  await insertPickEvent(db, "d2", 12, 1, 3);
  await insertPickEvent(db, "d2", 30, 2, 2);
  await insertPickEvent(db, "d2", 35, 2, 8);
  await insertPickEvent(db, "d2", 41, 1, 9);
  // d3 picks — an in-progress draft that must be excluded from stats.
  await insertPickEvent(db, "d3", 1, 1, 1);

  // Decks (seat 1 = UR, seat 2 = WG in both stats drafts)
  for (const draftId of ["d1", "d2"]) {
    for (const cardId of [1, 7, 3, 9]) {
      await insertDeckCard(db, draftId, 1, cardId);
    }
    for (const cardId of [2, 8]) {
      await insertDeckCard(db, draftId, 2, cardId);
    }
  }
  await insertDeckCard(db, "d3", 1, 1);

  await insertMatch(db, "d1", 1, 2, 60, 40);
  await insertMatch(db, "d2", 1, 2, 80, 20);
  await insertMatch(db, "d3", 1, 2, 10, 0);
}

function findCard(result: Awaited<ReturnType<typeof getWorthTable>>, name: string) {
  const card = result.cards.find((c) => c.card_name === name);
  expect(card, `card ${name} missing from table`).toBeDefined();
  return card!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getWorthTable", () => {
  it("computes a sane table and model from the fixture", async () => {
    await seedWorthFixture();
    const result = await getWorthTable();

    // Model params: curve fitted over the five eligible non-land cards.
    expect(result.cardsFit).toBe(5);
    expect(Number.isFinite(result.model.a)).toBe(true);
    expect(Number.isFinite(result.model.b)).toBe(true);
    expect(result.model.tau).toBeGreaterThanOrEqual(0);
    expect(result.model.tau0).toBeGreaterThanOrEqual(0);
    expect(result.model.sigma).toBeGreaterThan(0);
    expect(result.model.kappa).toBe(0.5);
    expect(result.model.baselines).toEqual({
      U: 0.7,
      R: 0.7,
      W: 0.3,
      G: 0.3,
    });
    expect(Object.keys(result.model.pairEdges).sort()).toEqual(["UR", "WG"]);
    expect(result.model.pairEdges.UR).toBeGreaterThan(result.model.pairEdges.WG);
    expect(result.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const alpha = findCard(result, "Alpha Strike");
    expect(alpha.colors).toBe("R");
    expect(alpha.is_land).toBe(false);
    expect(alpha.in_current_cube).toBe(true);
    // d1 (2026-01-01) is one session behind d2 (2026-02-01), so its pick of 2
    // counts for weight 0.5^(1/4) against d2's full-weight pick of 3:
    // exp((0.8409·ln2 + ln3) / 1.8409) ≈ 2.493, rounded to a tenth.
    expect(alpha.geomean).toBeCloseTo(2.5, 5);
    expect(alpha.games).toBe(200);
    expect(alpha.wins).toBe(140);
    expect(alpha.wr).toBeCloseTo(0.7, 10);
    expect(alpha.delta).toBeCloseTo(0, 10); // wr equals the R baseline
    expect(alpha.expected).not.toBeNull();
    expect(alpha.pvi).not.toBeNull();
    expect(alpha.worth).not.toBeNull();
    expect(alpha.prior_only).toBe(false);
    expect(alpha.no_data).toBe(false);
    // Early-geo card in the current cube: danger crosses 0.5 immediately.
    expect(alpha.act_by).toBe(1);

    // Nullstone over-delivers against a colorless 0.5 baseline.
    const nullstone = findCard(result, "Nullstone");
    expect(nullstone.colors).toBe("");
    expect(nullstone.delta).toBeCloseTo(0.2, 10);
    expect(nullstone.pvi).not.toBeNull();
    expect(nullstone.pvi!).toBeGreaterThan(0);
    // Zero-prior shrinkage: worth = w·delta with w from tau0 and the card's
    // se — the price curve plays no part in a data-driven worth.
    const zeroPriorWeight =
      result.model.tau0 ** 2 / (result.model.tau0 ** 2 + nullstone.se! ** 2);
    expect(nullstone.worth!).toBeCloseTo(zeroPriorWeight * nullstone.delta!, 10);
    // Not in the current cube → no act_by even though it has a geomean.
    expect(nullstone.act_by).toBeNull();
  });

  it("excludes in-progress drafts from picks, games, and geomean", async () => {
    await seedWorthFixture();
    const result = await getWorthTable();

    const alpha = findCard(result, "Alpha Strike");
    // d3 has a pick of Alpha Strike at position 1, a deck entry, and a 10-0
    // match. None of it may count: geomean stays session-weighted over
    // d1/d2 only (see the recency-weighting note above) and games stay 200.
    expect(alpha.geomean).toBeCloseTo(2.5, 5);
    expect(alpha.games).toBe(200);
    expect(alpha.wins).toBe(140);
  });

  it("marks priced cards below the games threshold as prior_only", async () => {
    await seedWorthFixture();
    const result = await getWorthTable();

    const sleeper = findCard(result, "Delta Sleeper");
    expect(sleeper.prior_only).toBe(true);
    expect(sleeper.no_data).toBe(false);
    expect(sleeper.games).toBe(0);
    expect(sleeper.wr).toBeNull();
    expect(sleeper.geomean).not.toBeNull();
    // Prior-only worth IS the price expectation; pvi is undefined.
    expect(sleeper.worth).toBe(sleeper.expected);
    expect(sleeper.pvi).toBeNull();
  });

  it("marks cards with no pick history at all as no_data", async () => {
    await seedWorthFixture();
    const result = await getWorthTable();

    const ghost = findCard(result, "Epsilon Ghost");
    expect(ghost.no_data).toBe(true);
    expect(ghost.prior_only).toBe(false);
    expect(ghost.geomean).toBeNull();
    expect(ghost.worth).toBeNull();
    expect(ghost.pvi).toBeNull();
    expect(ghost.expected).toBeNull();
    expect(ghost.act_by).toBeNull();
    expect(ghost.in_current_cube).toBe(true);
  });

  it("flags lands and excludes them from the price-curve fit", async () => {
    await seedWorthFixture();
    const result = await getWorthTable();

    const land = findCard(result, "Gamma Field");
    expect(land.is_land).toBe(true);
    // Lands still get a worth number — consumers see the flag instead.
    expect(land.worth).not.toBeNull();
    // 6 cards have ≥100 games and a geomean, but the land is excluded.
    expect(result.cardsFit).toBe(5);
  });

  describe("caching", () => {
    it("invalidates when a newer draft changes the current cube, without any stats-phase change", async () => {
      await seedWorthFixture();
      const first = await getWorthTable();

      // A freshly created live pod: not stats-eligible (phase drafting), but
      // it IS the new latest draft, so in_current_cube/act_by must follow it.
      await insertCard(db, 90, "Brand New Card", {
        scryfallJson: { type_line: "Instant", color_identity: ["R"] },
      });
      await insertCubeSnapshot(db, 9);
      await insertCubeCard(db, 9, 90);
      await insertDraft(db, "new-pod", {
        date: "2026-12-01",
        phase: "drafting",
        cubeSnapshotId: 9,
      });

      const second = await getWorthTable();
      expect(second).not.toBe(first);
      expect(findCard(second, "Brand New Card").in_current_cube).toBe(true);
    });

    it("serves warm calls from the memo without re-querying", async () => {
      await seedWorthFixture();
      const first = await getWorthTable();

      const executeSpy = vi.spyOn(db, "execute");
      const second = await getWorthTable();

      // Only the fingerprint queries (stats-draft hashes + latest-draft
      // cube identity) run on a warm call.
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(second).toBe(first);
    });

    it("recomputes after _resetWorthCache", async () => {
      await seedWorthFixture();
      const first = await getWorthTable();

      _resetWorthCache();
      const executeSpy = vi.spyOn(db, "execute");
      const second = await getWorthTable();

      expect(executeSpy.mock.calls.length).toBeGreaterThan(1);
      expect(second).not.toBe(first);
      expect(second.cards).toEqual(first.cards);
    });

    it("recomputes when a draft's domain hash changes", async () => {
      await seedWorthFixture();
      const first = await getWorthTable();

      await db.execute({
        sql: `UPDATE drafts SET picks_hash = 'changed' WHERE draft_id = 'd1'`,
        args: [],
      });
      const executeSpy = vi.spyOn(db, "execute");
      const second = await getWorthTable();

      expect(executeSpy.mock.calls.length).toBeGreaterThan(1);
      expect(second).not.toBe(first);
    });
  });

  describe("excludeDraftId (leave-one-draft-out)", () => {
    it("drops the draft from all aggregation and bypasses the cache", async () => {
      await seedWorthFixture();
      const cached = await getWorthTable();

      // Exclusion changes the inputs: only d1 remains for Alpha Strike.
      const excluded = await getWorthTable({ excludeDraftId: "d2" });
      const alpha = findCard(excluded, "Alpha Strike");
      expect(alpha.games).toBe(100);
      expect(alpha.wins).toBe(60);
      expect(alpha.geomean).toBeCloseTo(2, 5); // single pick at position 2

      // The LODO call neither read nor overwrote the plain-call memo.
      const executeSpy = vi.spyOn(db, "execute");
      const plainAgain = await getWorthTable();
      expect(executeSpy).toHaveBeenCalledTimes(2);
      expect(plainAgain).toBe(cached);
    });
  });

  describe("session ordinals under leave-one-draft-out", () => {
    it("does not renumber older sessions when a fold removes a single-pod session", async () => {
      // Sessions: 2026-07-17 (newest), 2026-03-08 (one pod), 2026-01-01.
      // Dropping the lone 2026-03-08 pod must not promote 2026-01-01 from two
      // sessions back to one, or LODO folds stop being comparable.
      await insertCubeSnapshot(db, 1);
      await insertCard(db, 1, "Alpha");
      await insertCubeCard(db, 1, 1);
      await insertDraft(db, "newest", { date: "2026-07-17", cubeSnapshotId: 1 });
      await insertDraft(db, "solo", { date: "2026-03-08", cubeSnapshotId: 1 });
      await insertDraft(db, "oldest", { date: "2026-01-01", cubeSnapshotId: 1 });
      await insertPickEvent(db, "newest", 10, 1, 1);
      await insertPickEvent(db, "oldest", 40, 1, 1);

      _resetWorthCache();
      const withoutSolo = await getWorthTable({ excludeDraftId: "solo" });
      const geomean = withoutSolo.cards.find((c) => c.card_name === "Alpha")!.geomean!;

      // 'oldest' stays two sessions back: weight 0.5^(2/4) = 0.7071.
      // exp((1*ln(10) + 0.7071*ln(40)) / 1.7071) = 17.76
      // Had it been renumbered to one session back (weight 0.8409) the score
      // would be 18.84, so this distinguishes the two orderings.
      expect(geomean).toBeCloseTo(17.8, 1);
    });
  });

  describe("cache invalidation on draft_date change", () => {
    it("recomputes session ordinals when a draft's date changes with no other data touched", async () => {
      // d1 and d2 start in different sessions, so d1's pick (5) counts at
      // weight 0.5^(1/4) against d2's full-weight pick (15):
      // exp((0.8409·ln5 + ln15) / 1.8409) ≈ 9.081 → 9.1.
      await insertCubeSnapshot(db, 1);
      await insertCard(db, 1, "Alpha");
      await insertCubeCard(db, 1, 1);
      await insertDraft(db, "d1", { date: "2026-01-01", cubeSnapshotId: 1 });
      await insertDraft(db, "d2", { date: "2026-02-01", cubeSnapshotId: 1 });
      await insertPickEvent(db, "d1", 5, 1, 1);
      await insertPickEvent(db, "d2", 15, 1, 1);

      const first = await getWorthTable();
      const firstGeomean = first.cards.find((c) => c.card_name === "Alpha")!.geomean!;
      expect(firstGeomean).toBeCloseTo(9.1, 5);

      // Correct d1's date onto d2's, merging them into one session — no
      // pick/pool/match hash changes, only draft_date. computeIngestionHash
      // alone can't see this, so the cache key must fold draft_date in too,
      // or this second call would wrongly serve the stale first result.
      await db.execute({
        sql: `UPDATE drafts SET draft_date = '2026-02-01' WHERE draft_id = 'd1'`,
        args: [],
      });

      const second = await getWorthTable();
      const secondGeomean = second.cards.find((c) => c.card_name === "Alpha")!.geomean!;
      // Both picks now sit in the same session (weight 1 each):
      // exp((ln5 + ln15) / 2) = sqrt(75) ≈ 8.660 → 8.7.
      expect(secondGeomean).toBeCloseTo(8.7, 5);
      expect(secondGeomean).not.toBe(firstGeomean);
    });
  });
});
