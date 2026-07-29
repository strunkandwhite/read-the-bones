import { describe, it, expect } from "vitest";
import {
  isMatchesComplete,
  computeSyncTargetPhase,
  isSyncPhaseTransitionLegal,
} from "./draftPhases";

describe("isMatchesComplete", () => {
  it("is complete when every round-robin match is recorded", () => {
    expect(isMatchesComplete(45, 10)).toBe(true); // 10 seats → 45 matches
    expect(isMatchesComplete(28, 8)).toBe(true); // 8 seats → 28 matches
    expect(isMatchesComplete(1, 2)).toBe(true); // 2 seats → 1 match
  });

  it("is incomplete while matches are missing", () => {
    expect(isMatchesComplete(44, 10)).toBe(false);
    expect(isMatchesComplete(0, 10)).toBe(false);
  });

  it("tolerates extra matches (double round robin)", () => {
    expect(isMatchesComplete(66, 12)).toBe(true);
  });

  it("is never complete with fewer than 2 seats", () => {
    expect(isMatchesComplete(0, 1)).toBe(false);
    expect(isMatchesComplete(0, 0)).toBe(false);
  });
});

describe("computeSyncTargetPhase", () => {
  it("targets drafting while picks are unfinished", () => {
    expect(computeSyncTargetPhase(false, false)).toBe("drafting");
    // matches can exist before picks finish (partial early entry) — still drafting
    expect(computeSyncTargetPhase(false, true)).toBe("drafting");
  });

  it("targets playing when picks are done but matches are not", () => {
    expect(computeSyncTargetPhase(true, false)).toBe("playing");
  });

  it("targets complete when picks and matches are both done", () => {
    expect(computeSyncTargetPhase(true, true)).toBe("complete");
  });
});

describe("isSyncPhaseTransitionLegal", () => {
  it("always allows advancing to complete", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "complete")).toBe(true);
    expect(isSyncPhaseTransitionLegal("playing", "complete")).toBe(true);
    expect(isSyncPhaseTransitionLegal("complete", "complete")).toBe(true);
  });

  it("allows moving into playing from setup, drafting, or playing", () => {
    expect(isSyncPhaseTransitionLegal("setup", "playing")).toBe(true);
    expect(isSyncPhaseTransitionLegal("drafting", "playing")).toBe(true);
    expect(isSyncPhaseTransitionLegal("playing", "playing")).toBe(true);
  });

  it("never demotes complete back to playing or drafting", () => {
    expect(isSyncPhaseTransitionLegal("complete", "playing")).toBe(false);
    expect(isSyncPhaseTransitionLegal("complete", "drafting")).toBe(false);
  });

  it("never demotes playing back to drafting", () => {
    expect(isSyncPhaseTransitionLegal("playing", "drafting")).toBe(false);
  });

  it("allows drafting from setup or drafting only", () => {
    expect(isSyncPhaseTransitionLegal("setup", "drafting")).toBe(true);
    expect(isSyncPhaseTransitionLegal("drafting", "drafting")).toBe(true);
  });

  it("rejects unknown target phases", () => {
    expect(isSyncPhaseTransitionLegal("drafting", "setup")).toBe(false);
    expect(isSyncPhaseTransitionLegal("drafting", "bogus")).toBe(false);
  });
});
