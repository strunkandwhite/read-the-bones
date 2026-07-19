// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getLocalDeckMode,
  loadLocalFloats,
  saveLocalFloats,
  loadLocalDeckState,
  saveLocalDeckState,
} from "./localDeck";
import { useDraftStore, _resetPollingState, type BoardData } from "../draftStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

function makeBoard(overrides: Partial<BoardData> = {}): BoardData {
  return {
    picks: [],
    numSeats: 10,
    picksPerPlayer: 45,
    phase: "drafting",
    seatNames: {},
    bannedCards: [],
    isSheetDraft: true,
    ...overrides,
  };
}

describe("getLocalDeckMode", () => {
  beforeEach(() => {
    localStorage.clear();
    useDraftStore.getState().stopPolling();
    _resetPollingState();
    useDraftStore.setState({ activeDraft: null, selectedSeat: null, board: null });
  });

  afterEach(() => {
    useDraftStore.getState().stopPolling();
  });

  it("is true for a sheet draft with a selected seat", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeBoard() });
    expect(getLocalDeckMode()).toBe(true);
  });

  it("is false for live drafts", () => {
    useDraftStore.setState({ activeDraft: "live-1", selectedSeat: 3, board: makeBoard({ isSheetDraft: false }) });
    expect(getLocalDeckMode()).toBe(false);
  });

  it("is false with no seat selected", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: null, board: makeBoard() });
    expect(getLocalDeckMode()).toBe(false);
  });

  it("is false before board data arrives", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: null });
    expect(getLocalDeckMode()).toBe(false);
  });
});

describe("local floats persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips floats per draft and seat", () => {
    saveLocalFloats("sheet-1", 3, ["Card A", "Card B"]);
    saveLocalFloats("sheet-1", 5, ["Card C"]);
    expect(loadLocalFloats("sheet-1", 3)).toEqual(["Card A", "Card B"]);
    expect(loadLocalFloats("sheet-1", 5)).toEqual(["Card C"]);
    expect(loadLocalFloats("sheet-2", 3)).toEqual([]);
  });

  it("returns [] for corrupt JSON", () => {
    localStorage.setItem("localFloats:sheet-1:3", "{not json");
    expect(loadLocalFloats("sheet-1", 3)).toEqual([]);
  });

  it("filters non-string entries", () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Card A", 42, null]));
    expect(loadLocalFloats("sheet-1", 3)).toEqual(["Card A"]);
  });
});

describe("local deck state persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a deck state keyed by its own identity", () => {
    const state = createEmptyDeckState("sheet-1", 3);
    state.zones.deck["mv-0-1"] = ["Sol Ring"];
    saveLocalDeckState(state);
    const loaded = loadLocalDeckState("sheet-1", 3);
    expect(loaded?.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
    expect(loaded?.draftId).toBe("sheet-1");
    expect(loaded?.seat).toBe(3);
  });

  it("refuses to save a deck with empty draftId", () => {
    saveLocalDeckState(createEmptyDeckState("", 0));
    expect(localStorage.length).toBe(0);
  });

  it("forces identity from the key on load", () => {
    const state = createEmptyDeckState("other-draft", 9);
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(state));
    const loaded = loadLocalDeckState("sheet-1", 3);
    expect(loaded?.draftId).toBe("sheet-1");
    expect(loaded?.seat).toBe(3);
  });

  it("returns null for corrupt or shapeless JSON", () => {
    localStorage.setItem("localDeckState:sheet-1:3", "{not json");
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify({ foo: 1 }));
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
  });
});
