import { describe, it, expect } from "vitest";
import { sessionsAgoByDraft } from "./draftSessions";

describe("sessionsAgoByDraft", () => {
  it("gives the most recent session ordinal 0", () => {
    const map = sessionsAgoByDraft([
      { draftId: "old", draftDate: "2026-01-01" },
      { draftId: "new", draftDate: "2026-07-17" },
    ]);
    expect(map.get("new")).toBe(0);
    expect(map.get("old")).toBe(1);
  });

  it("treats same-date pods as one session", () => {
    // Five parallel pods are one drafting occasion, not five.
    const map = sessionsAgoByDraft([
      { draftId: "a", draftDate: "2026-07-17" },
      { draftId: "b", draftDate: "2026-07-17" },
      { draftId: "c", draftDate: "2026-05-23" },
    ]);
    expect(map.get("a")).toBe(0);
    expect(map.get("b")).toBe(0);
    expect(map.get("c")).toBe(1);
  });

  it("counts sessions, not elapsed time", () => {
    // A four-month gap and a one-week gap are both one session.
    const map = sessionsAgoByDraft([
      { draftId: "x", draftDate: "2026-07-17" },
      { draftId: "y", draftDate: "2026-07-10" },
      { draftId: "z", draftDate: "2026-03-08" },
    ]);
    expect(map.get("y")).toBe(1);
    expect(map.get("z")).toBe(2);
  });

  it("returns an empty map for no drafts", () => {
    expect(sessionsAgoByDraft([]).size).toBe(0);
  });

  it("does not depend on input order", () => {
    const forward = sessionsAgoByDraft([
      { draftId: "a", draftDate: "2026-01-01" },
      { draftId: "b", draftDate: "2026-07-17" },
    ]);
    const reverse = sessionsAgoByDraft([
      { draftId: "b", draftDate: "2026-07-17" },
      { draftId: "a", draftDate: "2026-01-01" },
    ]);
    expect([...forward]).toEqual([...reverse].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  });
});
