import { describe, it, expect } from "vitest";
import { computeMyDeckCardNames } from "./computeMyDeckCardNames";

const base = { picks: ["Sol Ring"], floatedCards: ["Sylvan Library"], queue: [] };

describe("computeMyDeckCardNames — local deck mode", () => {
  it("includes floats in local deck mode without auth", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: false, localDeckMode: true });
    expect(result).toEqual(["Sol Ring", "Sylvan Library"]);
  });

  it("excludes floats when neither authed nor local mode", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: false, localDeckMode: false });
    expect(result).toEqual(["Sol Ring"]);
  });

  it("still includes floats when authed (live path unchanged)", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: true, localDeckMode: false });
    expect(result).toEqual(["Sol Ring", "Sylvan Library"]);
  });

  it("never includes queued cards in local mode alone", () => {
    const result = computeMyDeckCardNames({
      picks: [],
      isAuthed: false,
      localDeckMode: true,
      floatedCards: [],
      queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Land Tax" }] }],
    });
    expect(result).toEqual([]);
  });

  it("dedupes floats against picks", () => {
    const result = computeMyDeckCardNames({
      picks: ["Sylvan Library"],
      isAuthed: false,
      localDeckMode: true,
      floatedCards: ["Sylvan Library"],
      queue: [],
    });
    expect(result).toEqual(["Sylvan Library"]);
  });
});
