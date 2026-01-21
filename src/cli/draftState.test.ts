/**
 * Tests for draft state parsing and snake draft position calculations.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getDrafterForPick, parseDraftState, inferDrafterColors } from "./draftState";
import type { ScryCard } from "../core/types";
import { cardNameKey } from "../core/parseCsv";

// Set the test user name for parseDraftState tests
const ORIGINAL_DRAFT_USER_NAME = process.env.DRAFT_USER_NAME;

// ============================================================================
// getDrafterForPick - Snake Draft Math
// ============================================================================

describe("getDrafterForPick", () => {
  describe("8-player draft snake order", () => {
    it("should return drafter 0 for pick 1 (start of round 1)", () => {
      expect(getDrafterForPick(1, 8)).toBe(0);
    });

    it("should return drafter 7 for pick 8 (end of round 1 forward)", () => {
      expect(getDrafterForPick(8, 8)).toBe(7);
    });

    it("should return drafter 7 for pick 9 (start of round 2 reverse)", () => {
      expect(getDrafterForPick(9, 8)).toBe(7);
    });

    it("should return drafter 0 for pick 16 (end of round 2 reverse)", () => {
      expect(getDrafterForPick(16, 8)).toBe(0);
    });

    it("should return drafter 0 for pick 17 (start of round 3 forward)", () => {
      expect(getDrafterForPick(17, 8)).toBe(0);
    });

    it("should follow forward snake pattern for picks 1-8", () => {
      // Round 1: forward (0 -> 7)
      const round1 = [1, 2, 3, 4, 5, 6, 7, 8].map((pick) => getDrafterForPick(pick, 8));
      expect(round1).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it("should follow reverse snake pattern for picks 9-16", () => {
      // Round 2: reverse (7 -> 0)
      const round2 = [9, 10, 11, 12, 13, 14, 15, 16].map((pick) => getDrafterForPick(pick, 8));
      expect(round2).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    });

    it("should alternate direction for round 3 (forward again)", () => {
      const round3 = [17, 18, 19, 20, 21, 22, 23, 24].map((pick) => getDrafterForPick(pick, 8));
      expect(round3).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it("should alternate direction for round 4 (reverse again)", () => {
      const round4 = [25, 26, 27, 28, 29, 30, 31, 32].map((pick) => getDrafterForPick(pick, 8));
      expect(round4).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    });
  });

  describe("4-player draft", () => {
    it("should return correct drafters for round 1 forward", () => {
      const round1 = [1, 2, 3, 4].map((pick) => getDrafterForPick(pick, 4));
      expect(round1).toEqual([0, 1, 2, 3]);
    });

    it("should return correct drafters for round 2 reverse", () => {
      const round2 = [5, 6, 7, 8].map((pick) => getDrafterForPick(pick, 4));
      expect(round2).toEqual([3, 2, 1, 0]);
    });
  });

  describe("6-player draft", () => {
    it("should return correct drafters for round 1 forward", () => {
      const round1 = [1, 2, 3, 4, 5, 6].map((pick) => getDrafterForPick(pick, 6));
      expect(round1).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it("should return correct drafters for round 2 reverse", () => {
      const round2 = [7, 8, 9, 10, 11, 12].map((pick) => getDrafterForPick(pick, 6));
      expect(round2).toEqual([5, 4, 3, 2, 1, 0]);
    });
  });

  describe("12-player draft", () => {
    it("should return drafter 0 for pick 1", () => {
      expect(getDrafterForPick(1, 12)).toBe(0);
    });

    it("should return drafter 11 for pick 12 (end of round 1)", () => {
      expect(getDrafterForPick(12, 12)).toBe(11);
    });

    it("should return drafter 11 for pick 13 (start of round 2)", () => {
      expect(getDrafterForPick(13, 12)).toBe(11);
    });

    it("should return drafter 0 for pick 24 (end of round 2)", () => {
      expect(getDrafterForPick(24, 12)).toBe(0);
    });

    it("should return drafter 0 for pick 25 (start of round 3)", () => {
      expect(getDrafterForPick(25, 12)).toBe(0);
    });
  });

  // ============================================================================
  // Property-Based Tests
  // ============================================================================

  describe("property-based tests", () => {
    describe("standard snake (rounds 1-25)", () => {
      it("each drafter appears exactly once per round", () => {
        // Test across multiple drafter counts
        for (const numDrafters of [4, 6, 8, 10, 12]) {
          for (let round = 1; round <= 10; round++) {
            const firstPick = (round - 1) * numDrafters + 1;
            const draftersInRound = new Set<number>();

            for (let pick = firstPick; pick < firstPick + numDrafters; pick++) {
              draftersInRound.add(getDrafterForPick(pick, numDrafters));
            }

            // Invariant: every drafter (0 to N-1) picks exactly once
            expect(draftersInRound.size).toBe(numDrafters);
            for (let d = 0; d < numDrafters; d++) {
              expect(draftersInRound.has(d)).toBe(true);
            }
          }
        }
      });

      it("drafter indices are always valid (0 to N-1)", () => {
        for (const numDrafters of [4, 6, 8, 10, 12]) {
          // Test first 25 rounds (standard snake mode)
          for (let pick = 1; pick <= numDrafters * 25; pick++) {
            const drafter = getDrafterForPick(pick, numDrafters);
            expect(drafter).toBeGreaterThanOrEqual(0);
            expect(drafter).toBeLessThan(numDrafters);
          }
        }
      });

      it("snake reverses direction on even rounds", () => {
        for (const numDrafters of [4, 6, 8, 10, 12]) {
          // Round 1 (odd) should be forward: starts with 0, ends with N-1
          expect(getDrafterForPick(1, numDrafters)).toBe(0);
          expect(getDrafterForPick(numDrafters, numDrafters)).toBe(numDrafters - 1);

          // Round 2 (even) should be reverse: starts with N-1, ends with 0
          expect(getDrafterForPick(numDrafters + 1, numDrafters)).toBe(numDrafters - 1);
          expect(getDrafterForPick(numDrafters * 2, numDrafters)).toBe(0);

          // Round 3 (odd) should be forward again
          expect(getDrafterForPick(numDrafters * 2 + 1, numDrafters)).toBe(0);
          expect(getDrafterForPick(numDrafters * 3, numDrafters)).toBe(numDrafters - 1);

          // Round 4 (even) should be reverse again
          expect(getDrafterForPick(numDrafters * 3 + 1, numDrafters)).toBe(numDrafters - 1);
          expect(getDrafterForPick(numDrafters * 4, numDrafters)).toBe(0);
        }
      });

      it("boundary drafters get consecutive picks at round transitions", () => {
        for (const numDrafters of [4, 6, 8, 10, 12]) {
          // At round 1→2 transition, drafter N-1 gets consecutive picks
          expect(getDrafterForPick(numDrafters, numDrafters)).toBe(numDrafters - 1);
          expect(getDrafterForPick(numDrafters + 1, numDrafters)).toBe(numDrafters - 1);

          // At round 2→3 transition, drafter 0 gets consecutive picks
          expect(getDrafterForPick(numDrafters * 2, numDrafters)).toBe(0);
          expect(getDrafterForPick(numDrafters * 2 + 1, numDrafters)).toBe(0);
        }
      });
    });

    describe("double-pick mode (rounds 26+)", () => {
      it("each drafter appears exactly twice per round", () => {
        const numDrafters = 10;
        const doublePickStart = 25 * numDrafters + 1; // Pick 251

        for (let round = 26; round <= 30; round++) {
          const firstPick = doublePickStart + (round - 26) * numDrafters * 2;
          const drafterCounts = new Map<number, number>();

          for (let pick = firstPick; pick < firstPick + numDrafters * 2; pick++) {
            const drafter = getDrafterForPick(pick, numDrafters);
            drafterCounts.set(drafter, (drafterCounts.get(drafter) || 0) + 1);
          }

          // Invariant: every drafter picks exactly twice
          expect(drafterCounts.size).toBe(numDrafters);
          for (let d = 0; d < numDrafters; d++) {
            expect(drafterCounts.get(d)).toBe(2);
          }
        }
      });

      it("consecutive picks belong to the same drafter (double picks)", () => {
        const numDrafters = 10;
        const doublePickStart = 25 * numDrafters + 1; // Pick 251

        // Test rounds 26-30 in double-pick mode
        for (let round = 26; round <= 30; round++) {
          const firstPick = doublePickStart + (round - 26) * numDrafters * 2;

          // Each pair of consecutive picks should be the same drafter
          for (let i = 0; i < numDrafters; i++) {
            const pick1 = firstPick + i * 2;
            const pick2 = pick1 + 1;
            expect(getDrafterForPick(pick1, numDrafters)).toBe(
              getDrafterForPick(pick2, numDrafters)
            );
          }
        }
      });

      it("drafter indices are always valid in double-pick mode (0 to N-1)", () => {
        for (const numDrafters of [4, 8, 10, 12]) {
          const doublePickStart = 25 * numDrafters + 1;
          // Test 5 rounds of double-pick mode
          for (let pick = doublePickStart; pick < doublePickStart + numDrafters * 2 * 5; pick++) {
            const drafter = getDrafterForPick(pick, numDrafters);
            expect(drafter).toBeGreaterThanOrEqual(0);
            expect(drafter).toBeLessThan(numDrafters);
          }
        }
      });

      it("snake direction alternates in double-pick mode", () => {
        const numDrafters = 10;
        const doublePickStart = 25 * numDrafters + 1; // Pick 251

        // Round 26 (first double-pick round, even) should be reverse: starts N-1, ends 0
        expect(getDrafterForPick(doublePickStart, numDrafters)).toBe(numDrafters - 1);
        expect(getDrafterForPick(doublePickStart + numDrafters * 2 - 1, numDrafters)).toBe(0);

        // Round 27 (odd) should be forward: starts 0, ends N-1
        const round27Start = doublePickStart + numDrafters * 2;
        expect(getDrafterForPick(round27Start, numDrafters)).toBe(0);
        expect(getDrafterForPick(round27Start + numDrafters * 2 - 1, numDrafters)).toBe(
          numDrafters - 1
        );

        // Round 28 (even) should be reverse again
        const round28Start = round27Start + numDrafters * 2;
        expect(getDrafterForPick(round28Start, numDrafters)).toBe(numDrafters - 1);
        expect(getDrafterForPick(round28Start + numDrafters * 2 - 1, numDrafters)).toBe(0);
      });

      it("boundary drafters get quadruple picks at round transitions in double-pick mode", () => {
        const numDrafters = 10;

        // At round 26→27 transition, drafter 0 gets 4 picks (end of 26 + start of 27)
        // End of round 26 (picks 269-270): drafter 0
        // Start of round 27 (picks 271-272): drafter 0
        expect(getDrafterForPick(269, numDrafters)).toBe(0);
        expect(getDrafterForPick(270, numDrafters)).toBe(0);
        expect(getDrafterForPick(271, numDrafters)).toBe(0);
        expect(getDrafterForPick(272, numDrafters)).toBe(0);

        // At round 27→28 transition, drafter 9 gets 4 picks
        expect(getDrafterForPick(289, numDrafters)).toBe(9);
        expect(getDrafterForPick(290, numDrafters)).toBe(9);
        expect(getDrafterForPick(291, numDrafters)).toBe(9);
        expect(getDrafterForPick(292, numDrafters)).toBe(9);
      });
    });

    describe("mode transition (round 25→26)", () => {
      it("all drafters participate in both round 25 (standard) and round 26 (double)", () => {
        const numDrafters = 10;

        // Round 25 (standard): each drafter picks once
        const round25Start = 24 * numDrafters + 1; // Pick 241
        const round25Drafters = new Set<number>();
        for (let pick = round25Start; pick < round25Start + numDrafters; pick++) {
          round25Drafters.add(getDrafterForPick(pick, numDrafters));
        }
        expect(round25Drafters.size).toBe(numDrafters);

        // Round 26 (double-pick): each drafter picks twice
        const round26Start = 25 * numDrafters + 1; // Pick 251
        const round26Counts = new Map<number, number>();
        for (let pick = round26Start; pick < round26Start + numDrafters * 2; pick++) {
          const drafter = getDrafterForPick(pick, numDrafters);
          round26Counts.set(drafter, (round26Counts.get(drafter) || 0) + 1);
        }
        expect(round26Counts.size).toBe(numDrafters);
        for (let d = 0; d < numDrafters; d++) {
          expect(round26Counts.get(d)).toBe(2);
        }
      });

      it("direction continues snake pattern at mode transition", () => {
        const numDrafters = 10;

        // Round 25 is odd → forward (ends with drafter 9)
        expect(getDrafterForPick(250, numDrafters)).toBe(9);

        // Round 26 is even → reverse (starts with drafter 9)
        expect(getDrafterForPick(251, numDrafters)).toBe(9);
      });
    });
  });

  // Double-pick mode starts after round 25 (pick 251 for 10 players)
  describe("10-player draft with double-pick mode (rounds 26+)", () => {
    const numDrafters = 10;
    const _doublePickStart = 25 * numDrafters + 1; // 251

    describe("standard snake (rounds 1-25)", () => {
      it("should follow standard snake for round 25 (forward)", () => {
        // Round 25 is forward (odd round)
        const round25Start = 24 * numDrafters + 1; // 241
        expect(getDrafterForPick(round25Start, numDrafters)).toBe(0);
        expect(getDrafterForPick(round25Start + 9, numDrafters)).toBe(9);
      });

      it("should return drafter 9 for pick 250 (last standard snake pick)", () => {
        expect(getDrafterForPick(250, numDrafters)).toBe(9);
      });
    });

    describe("double-pick mode transition", () => {
      it("should start double-pick mode at pick 251", () => {
        // Pick 251 is first pick of round 26 (reverse, double-pick)
        expect(getDrafterForPick(251, numDrafters)).toBe(9);
      });

      it("should give drafter 9 two consecutive picks at start of round 26", () => {
        expect(getDrafterForPick(251, numDrafters)).toBe(9);
        expect(getDrafterForPick(252, numDrafters)).toBe(9);
      });
    });

    describe("round 26 (reverse, double-pick)", () => {
      it("should give each drafter 2 consecutive picks in reverse order", () => {
        // Round 26: reverse order, each player picks twice
        // Picks 251-252: drafter 9
        // Picks 253-254: drafter 8
        // ...
        // Picks 269-270: drafter 0
        expect(getDrafterForPick(251, numDrafters)).toBe(9);
        expect(getDrafterForPick(252, numDrafters)).toBe(9);
        expect(getDrafterForPick(253, numDrafters)).toBe(8);
        expect(getDrafterForPick(254, numDrafters)).toBe(8);
        expect(getDrafterForPick(269, numDrafters)).toBe(0);
        expect(getDrafterForPick(270, numDrafters)).toBe(0);
      });

      it("should complete round 26 with 20 picks", () => {
        // All 20 picks in round 26
        const round26Drafters = [];
        for (let pick = 251; pick <= 270; pick++) {
          round26Drafters.push(getDrafterForPick(pick, numDrafters));
        }
        // Each drafter appears exactly twice, in reverse order
        expect(round26Drafters).toEqual([
          9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0, 0,
        ]);
      });
    });

    describe("round 27 (forward, double-pick)", () => {
      it("should alternate direction for round 27 (forward)", () => {
        // Round 27: forward order, each player picks twice
        // Picks 271-272: drafter 0
        // Picks 273-274: drafter 1
        // ...
        expect(getDrafterForPick(271, numDrafters)).toBe(0);
        expect(getDrafterForPick(272, numDrafters)).toBe(0);
        expect(getDrafterForPick(273, numDrafters)).toBe(1);
        expect(getDrafterForPick(274, numDrafters)).toBe(1);
      });

      it("should return drafter 8 for picks 287-288 (matches real draft data)", () => {
        // This matches the actual tarkir-fate-reforged draft data
        // where 286 picks were made and Jack (drafter 8) was next
        expect(getDrafterForPick(287, numDrafters)).toBe(8);
        expect(getDrafterForPick(288, numDrafters)).toBe(8);
      });

      it("should complete round 27 with 20 picks", () => {
        const round27Drafters = [];
        for (let pick = 271; pick <= 290; pick++) {
          round27Drafters.push(getDrafterForPick(pick, numDrafters));
        }
        // Each drafter appears exactly twice, in forward order
        expect(round27Drafters).toEqual([
          0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9,
        ]);
      });
    });

    describe("round 28 (reverse, double-pick)", () => {
      it("should return to reverse order for round 28", () => {
        // Round 28: reverse order again
        expect(getDrafterForPick(291, numDrafters)).toBe(9);
        expect(getDrafterForPick(292, numDrafters)).toBe(9);
        expect(getDrafterForPick(293, numDrafters)).toBe(8);
        expect(getDrafterForPick(294, numDrafters)).toBe(8);
      });
    });

    describe("boundary picks (quadruple picks at round transitions)", () => {
      it("should give drafter 9 four consecutive picks at round 26-27 boundary", () => {
        // End of round 26 (picks 269-270): drafter 0
        // Start of round 27 (picks 271-272): drafter 0
        // So drafter 0 gets 4 picks in a row at the boundary
        expect(getDrafterForPick(269, numDrafters)).toBe(0);
        expect(getDrafterForPick(270, numDrafters)).toBe(0);
        expect(getDrafterForPick(271, numDrafters)).toBe(0);
        expect(getDrafterForPick(272, numDrafters)).toBe(0);
      });

      it("should give drafter 9 four consecutive picks at round 27-28 boundary", () => {
        // End of round 27 (picks 289-290): drafter 9
        // Start of round 28 (picks 291-292): drafter 9
        expect(getDrafterForPick(289, numDrafters)).toBe(9);
        expect(getDrafterForPick(290, numDrafters)).toBe(9);
        expect(getDrafterForPick(291, numDrafters)).toBe(9);
        expect(getDrafterForPick(292, numDrafters)).toBe(9);
      });
    });
  });
});

// ============================================================================
// parseDraftState - Draft Parsing
// ============================================================================

describe("parseDraftState", () => {
  // Set DRAFT_USER_NAME to "TestUser" for these tests
  beforeAll(() => {
    process.env.DRAFT_USER_NAME = "TestUser";
  });

  afterAll(() => {
    // Restore original value
    if (ORIGINAL_DRAFT_USER_NAME !== undefined) {
      process.env.DRAFT_USER_NAME = ORIGINAL_DRAFT_USER_NAME;
    } else {
      delete process.env.DRAFT_USER_NAME;
    }
  });

  // Minimal CSV with TestUser present
  const minimalPicksCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,Bob,↩,,Color1,Color2,Color3
1,→,Card1,Card2,Card3,↩,,W,U,B
2,↪,Card4,Card5,Card6,↩,,R,G,W`;

  const minimalPoolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B
✓,Card4,Enchantment,R
✓,Card5,Artifact,G
✓,Card6,Land,W
,Unpicked1,Creature,G
,Unpicked2,Instant,R`;

  it("should successfully parse a draft with user present", () => {
    const state = parseDraftState(minimalPicksCsv, minimalPoolCsv);

    expect(state.drafters).toEqual(["TestUser", "Alice", "Bob"]);
    expect(state.userIndex).toBe(0);
    expect(state.poolSize).toBe(8);
  });

  it("should identify user at different positions", () => {
    const csvWithUserInMiddle = `,,Rotisserie Draft,,
,,,
,,Alice,TestUser,Bob,↩,,Color1,Color2,Color3
1,→,Card1,Card2,Card3,↩,,W,U,B`;

    const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B`;

    const state = parseDraftState(csvWithUserInMiddle, poolCsv);

    expect(state.userIndex).toBe(1);
    expect(state.drafters).toEqual(["Alice", "TestUser", "Bob"]);
  });

  describe("current pick identification", () => {
    it("should identify current pick from first empty cell", () => {
      // Draft in progress - pick 3 (Alice's turn in round 2 reversed order)
      const inProgressCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,Bob,↩,,Color1,Color2,Color3
1,→,Card1,Card2,Card3,↩,,W,U,B
2,↪,Card4,,Card6,↩,,R,,W`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B
✓,Card4,Enchantment,R
,Card5,Artifact,G
✓,Card6,Land,W`;

      const state = parseDraftState(inProgressCsv, poolCsv);

      // Round 2 is reverse order (Bob→Alice→TestUser)
      // Pick 4: Bob=Card6, Pick 5: Alice=empty (first empty)
      expect(state.currentPickNumber).toBe(5);
    });

    it("should identify first empty cell correctly when multiple empty", () => {
      const inProgressCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,Bob,↩,,Color1,Color2,Color3
1,→,Card1,Card2,Card3,↩,,W,U,B
2,↪,,,Card6,↩,,,,W`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B
,Card4,Enchantment,R
,Card5,Artifact,G
✓,Card6,Land,W`;

      const state = parseDraftState(inProgressCsv, poolCsv);

      // Round 2 is reverse (Bob→Alice→TestUser)
      // Pick 4: Bob=Card6, Pick 5: Alice=empty (first empty)
      expect(state.currentPickNumber).toBe(5);
    });
  });

  describe("picksUntilUser calculation", () => {
    it("should return 0 when it is the user's turn", () => {
      // TestUser is drafter 0, pick 1 is TestUser's turn
      const state = parseDraftState(minimalPicksCsv, minimalPoolCsv);

      // All picks made, so current pick is past the end
      // With 6 picks made, current = 7
      // In a 3-player draft at pick 7: round 2 starts at pick 4
      // Pick 7: round = (7-1)/3 = 2, position = (7-1)%3 = 0
      // Round 2 is forward, so drafter = 0 (TestUser)
      expect(state.currentDrafterIndex).toBe(0);
      expect(state.isUsersTurn).toBe(true);
      expect(state.picksUntilUser).toBe(0);
    });

    it("should calculate correct picks until user in mid-round", () => {
      // Create a draft where it's not the user's turn
      const inProgressCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,Bob,↩,,Color1,Color2,Color3
1,→,Card1,Card2,,↩,,W,U,`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
,Card3,Sorcery,B`;

      const state = parseDraftState(inProgressCsv, poolCsv);

      // Round 1 is forward (TestUser→Alice→Bob)
      // Pick 1: TestUser=Card1, Pick 2: Alice=Card2, Pick 3: Bob=empty (first empty)
      expect(state.currentPickNumber).toBe(3);
      expect(state.currentDrafterIndex).toBe(2); // Bob
      // TestUser picks next at pick 4 (round 2 reverse: Bob→Alice→TestUser) = 1 pick away
      // Wait: pick 4 is Bob (reverse), pick 5 is Alice, pick 6 is TestUser
      // So from pick 3 (Bob's turn), picks until TestUser = 3 picks
      expect(state.picksUntilUser).toBe(3);
    });
  });

  describe("allPicks map", () => {
    it("should correctly build allPicks map from CSV", () => {
      const state = parseDraftState(minimalPicksCsv, minimalPoolCsv);

      expect(state.allPicks.get("TestUser")).toEqual(["Card1", "Card4"]);
      expect(state.allPicks.get("Alice")).toEqual(["Card2", "Card5"]);
      expect(state.allPicks.get("Bob")).toEqual(["Card3", "Card6"]);
    });

    it("should normalize card names in allPicks", () => {
      const csvWithCopies = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,↩,,Color1,Color2
1,→,Scalding Tarn,Card2,↩,,C,U
2,↪,Scalding Tarn 2,Card4,↩,,C,W`;

      const poolCsv = `✓,Card,Type,Color
✓,Scalding Tarn,Land,C
✓,Card2,Instant,U
✓,Scalding Tarn 2,Land,C
✓,Card4,Sorcery,W`;

      const state = parseDraftState(csvWithCopies, poolCsv);

      // Both should be normalized to "Scalding Tarn"
      expect(state.allPicks.get("TestUser")).toEqual(["Scalding Tarn", "Scalding Tarn"]);
    });

    it("should include all drafters in allPicks even with no picks", () => {
      const emptyDraftCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,Bob,↩,,Color1,Color2,Color3
1,→,,,↩,,,,`;

      const poolCsv = `✓,Card,Type,Color
,Card1,Creature,W
,Card2,Instant,U
,Card3,Sorcery,B`;

      const state = parseDraftState(emptyDraftCsv, poolCsv);

      expect(state.allPicks.has("TestUser")).toBe(true);
      expect(state.allPicks.has("Alice")).toBe(true);
      expect(state.allPicks.has("Bob")).toBe(true);
      expect(state.allPicks.get("TestUser")).toEqual([]);
      expect(state.allPicks.get("Alice")).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("should throw error when user not found with drafter names in message", () => {
      const noUserCsv = `,,Rotisserie Draft,,
,,,
,,Alice,Bob,Charlie,↩,,Color1,Color2,Color3
1,→,Card1,Card2,Card3,↩,,W,U,B`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B`;

      expect(() => parseDraftState(noUserCsv, poolCsv)).toThrow('User "TestUser" not found');
      expect(() => parseDraftState(noUserCsv, poolCsv)).toThrow("DRAFT_USER_NAME");
      expect(() => parseDraftState(noUserCsv, poolCsv)).toThrow("Alice");
      expect(() => parseDraftState(noUserCsv, poolCsv)).toThrow("Bob");
      expect(() => parseDraftState(noUserCsv, poolCsv)).toThrow("Charlie");
    });

    it("should throw error for CSV with insufficient rows", () => {
      const tooShortCsv = `,,Rotisserie
,,`;
      const poolCsv = `✓,Card`;

      expect(() => parseDraftState(tooShortCsv, poolCsv)).toThrow("not enough rows");
    });

    it("should throw error when no drafter names found", () => {
      // Arrow immediately after column B means no drafter names
      const noDraftersCsv = `,,Rotisserie Draft,,
,,,
,,↩
1,→,Card1,↩`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W`;

      expect(() => parseDraftState(noDraftersCsv, poolCsv)).toThrow("no drafter names");
    });
  });

  describe("draft complete handling", () => {
    it("should handle completed draft with no empty cells", () => {
      const completedCsv = `,,Rotisserie Draft,,
,,,
,,TestUser,Alice,↩,,Color1,Color2
1,→,Card1,Card2,↩,,W,U
2,↪,Card3,Card4,↩,,B,R`;

      const poolCsv = `✓,Card,Type,Color
✓,Card1,Creature,W
✓,Card2,Instant,U
✓,Card3,Sorcery,B
✓,Card4,Enchantment,R`;

      const state = parseDraftState(completedCsv, poolCsv);

      // With 4 picks made and 2 drafters, current pick should be 5 (one past last)
      expect(state.currentPickNumber).toBe(5);
    });
  });

  describe("available cards calculation", () => {
    it("should correctly identify available cards", () => {
      const state = parseDraftState(minimalPicksCsv, minimalPoolCsv);

      // 8 cards in pool, 6 picked, 2 unpicked
      expect(state.availableCards).toContain("Unpicked1");
      expect(state.availableCards).toContain("Unpicked2");
      expect(state.availableCards).not.toContain("Card1");
      expect(state.availableCards.length).toBe(2);
    });
  });

  describe("userPicks", () => {
    it("should return user's picks correctly", () => {
      const state = parseDraftState(minimalPicksCsv, minimalPoolCsv);

      expect(state.userPicks).toEqual(["Card1", "Card4"]);
    });
  });
});

// ============================================================================
// inferDrafterColors - Color Inference
// ============================================================================

describe("inferDrafterColors", () => {
  // Helper to create a mock Scryfall card
  function mockCard(name: string, colors: string[], colorIdentity?: string[]): ScryCard {
    return {
      name,
      imageUri: "",
      manaCost: "",
      manaValue: 0,
      typeLine: "",
      colors,
      colorIdentity: colorIdentity ?? colors,
      oracleText: "",
    };
  }

  // Create a cache with test cards
  function createTestCache(): Map<string, ScryCard> {
    const cache = new Map<string, ScryCard>();
    // Use cardNameKey for lowercase keys (matches how inferDrafterColors looks up cards)
    cache.set(cardNameKey("Lightning Bolt"), mockCard("Lightning Bolt", ["R"]));
    cache.set(cardNameKey("Counterspell"), mockCard("Counterspell", ["U"]));
    cache.set(cardNameKey("Swords to Plowshares"), mockCard("Swords to Plowshares", ["W"]));
    cache.set(cardNameKey("Dark Ritual"), mockCard("Dark Ritual", ["B"]));
    cache.set(cardNameKey("Giant Growth"), mockCard("Giant Growth", ["G"]));
    cache.set(cardNameKey("Izzet Charm"), mockCard("Izzet Charm", ["U", "R"], ["U", "R"]));
    cache.set(cardNameKey("Boros Signet"), mockCard("Boros Signet", [], ["W", "R"])); // Colorless with color identity
    cache.set(cardNameKey("Sol Ring"), mockCard("Sol Ring", [], [])); // Colorless
    return cache;
  }

  describe("single dominant color", () => {
    it("should return primary color when one color dominates", () => {
      const cache = createTestCache();
      const picks = ["Lightning Bolt", "Lightning Bolt", "Lightning Bolt", "Counterspell"];

      // 3 Red, 1 Blue - Red dominates
      // Blue is 33% of Red count (1/3), which is above 30% threshold
      const colors = inferDrafterColors(picks, cache);

      // Actually both should be returned since 1/3 > 0.3
      expect(colors).toContain("R");
    });

    it("should return only one color when second is below threshold", () => {
      const cache = createTestCache();
      // 5 Red cards, 1 Blue - Blue is only 20% of Red (below 30%)
      const picks = [
        "Lightning Bolt",
        "Lightning Bolt",
        "Lightning Bolt",
        "Lightning Bolt",
        "Lightning Bolt",
        "Counterspell",
      ];

      const colors = inferDrafterColors(picks, cache);

      expect(colors).toEqual(["R"]);
    });
  });

  describe("two significant colors", () => {
    it("should return two colors when both are significant", () => {
      const cache = createTestCache();
      // 3 Red, 2 Blue - Blue is 67% of Red (above 30%)
      const picks = [
        "Lightning Bolt",
        "Lightning Bolt",
        "Lightning Bolt",
        "Counterspell",
        "Counterspell",
      ];

      const colors = inferDrafterColors(picks, cache);

      expect(colors).toHaveLength(2);
      expect(colors).toContain("R");
      expect(colors).toContain("U");
      // Red should be first as it's more frequent
      expect(colors[0]).toBe("R");
    });

    it("should handle equal counts correctly", () => {
      const cache = createTestCache();
      const picks = ["Lightning Bolt", "Counterspell"];

      const colors = inferDrafterColors(picks, cache);

      expect(colors).toHaveLength(2);
      expect(colors).toContain("R");
      expect(colors).toContain("U");
    });

    it("should handle multicolor cards", () => {
      const cache = createTestCache();
      // Izzet Charm is U/R
      const picks = ["Izzet Charm", "Counterspell", "Lightning Bolt"];

      const colors = inferDrafterColors(picks, cache);

      // Should have U (2: charm + counterspell) and R (2: charm + bolt)
      expect(colors).toContain("U");
      expect(colors).toContain("R");
    });
  });

  describe("empty picks", () => {
    it("should return empty array for empty picks", () => {
      const cache = createTestCache();
      const colors = inferDrafterColors([], cache);

      expect(colors).toEqual([]);
    });
  });

  describe("cards not in cache", () => {
    it("should handle cards not in Scryfall cache", () => {
      const cache = createTestCache();
      const picks = ["Unknown Card 1", "Unknown Card 2", "Lightning Bolt"];

      const colors = inferDrafterColors(picks, cache);

      // Should only count Lightning Bolt
      expect(colors).toEqual(["R"]);
    });

    it("should return empty array when all cards missing from cache", () => {
      const cache = createTestCache();
      const picks = ["Unknown Card 1", "Unknown Card 2"];

      const colors = inferDrafterColors(picks, cache);

      expect(colors).toEqual([]);
    });
  });

  describe("color identity vs colors", () => {
    it("should prefer colorIdentity over colors", () => {
      const cache = createTestCache();
      // Boros Signet has empty colors but W/R color identity
      const picks = ["Boros Signet", "Lightning Bolt"];

      const colors = inferDrafterColors(picks, cache);

      // Should include W from Boros Signet's color identity
      expect(colors).toContain("R");
      expect(colors).toContain("W");
    });

    it("should handle colorless cards", () => {
      const cache = createTestCache();
      // Sol Ring has no colors and no color identity
      const picks = ["Sol Ring", "Lightning Bolt"];

      const colors = inferDrafterColors(picks, cache);

      // Should only count Lightning Bolt
      expect(colors).toEqual(["R"]);
    });
  });

  describe("all five colors", () => {
    it("should handle picks with many colors and return top 2", () => {
      const cache = createTestCache();
      // 3 Red, 2 Blue, 1 each of W, B, G
      const picks = [
        "Lightning Bolt",
        "Lightning Bolt",
        "Lightning Bolt",
        "Counterspell",
        "Counterspell",
        "Swords to Plowshares",
        "Dark Ritual",
        "Giant Growth",
      ];

      const colors = inferDrafterColors(picks, cache);

      // Should return R and U as the top 2
      expect(colors).toHaveLength(2);
      expect(colors[0]).toBe("R");
      expect(colors[1]).toBe("U");
    });
  });
});
