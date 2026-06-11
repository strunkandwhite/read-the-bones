// src/core/__tests__/draftPhases.test.ts
import { describe, it, expect } from "vitest";
import {
  STATS_COMPLETE_PHASES,
  isCompletedForStats,
  statsPhaseFilter,
  isSyncPhaseTransitionLegal,
} from "../draftPhases";

describe("STATS_COMPLETE_PHASES", () => {
  it("includes complete and playing", () => {
    expect(STATS_COMPLETE_PHASES).toContain("complete");
    expect(STATS_COMPLETE_PHASES).toContain("playing");
    expect(STATS_COMPLETE_PHASES).toHaveLength(2);
  });
});

describe("isCompletedForStats", () => {
  it("returns true for complete", () => {
    expect(isCompletedForStats("complete")).toBe(true);
  });

  it("returns true for playing", () => {
    expect(isCompletedForStats("playing")).toBe(true);
  });

  it("returns false for drafting", () => {
    expect(isCompletedForStats("drafting")).toBe(false);
  });

  it("returns false for setup", () => {
    expect(isCompletedForStats("setup")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isCompletedForStats("")).toBe(false);
  });

  it("returns false for unknown phase", () => {
    expect(isCompletedForStats("unknown")).toBe(false);
  });
});

describe("statsPhaseFilter", () => {
  it("generates IN fragment with two placeholders", () => {
    const { fragment, args } = statsPhaseFilter("d.phase");
    expect(fragment).toBe("d.phase IN (?, ?)");
    expect(args).toEqual(["complete", "playing"]);
  });

  it("uses the supplied column name", () => {
    const { fragment } = statsPhaseFilter("drafts.phase");
    expect(fragment).toBe("drafts.phase IN (?, ?)");
  });

  it("args match STATS_COMPLETE_PHASES", () => {
    const { args } = statsPhaseFilter("phase");
    expect(args).toEqual([...STATS_COMPLETE_PHASES]);
  });
});

describe("isSyncPhaseTransitionLegal", () => {
  it("allows drafting → complete (picks finished)", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "complete")).toBe(true);
  });

  it("allows drafting → drafting (no-op, still in progress)", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "drafting")).toBe(true);
  });

  it("allows playing → complete (picks were already done)", () => {
    expect(isSyncPhaseTransitionLegal("playing", "complete")).toBe(true);
  });

  it("allows complete → complete (idempotent)", () => {
    expect(isSyncPhaseTransitionLegal("complete", "complete")).toBe(true);
  });

  it("blocks playing → drafting (would demote admin-set phase)", () => {
    expect(isSyncPhaseTransitionLegal("playing", "drafting")).toBe(false);
  });

  it("blocks complete → drafting (would demote terminal phase)", () => {
    expect(isSyncPhaseTransitionLegal("complete", "drafting")).toBe(false);
  });

  it("allows setup → drafting (first sync of a new Sheets draft)", () => {
    // draft:create inserts Sheets drafts in 'setup'; the first sync with
    // in-progress picks must be able to promote them to 'drafting'.
    expect(isSyncPhaseTransitionLegal("setup", "drafting")).toBe(true);
  });

  it("allows setup → complete", () => {
    // Unusual but not harmful — picks complete is always safe to mark
    expect(isSyncPhaseTransitionLegal("setup", "complete")).toBe(true);
  });
});
