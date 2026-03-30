// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { getCardStatus, getImageUrl } from "./selectors";
import { useDraftStore } from "./draftStore";
import { useCardStore, EMPTY_CARD_DATA, EMPTY_DRAFT_STATS } from "./cardStore";
import { useLiveStore } from "./liveStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

function resetStores() {
  useDraftStore.setState({
    selectedDrafts: new Set(),
    activeDraft: null,
    selectedSeat: null,
    hideTaken: true,
    completedDraftIds: [],
    hydrated: false,
    dataVersion: 0,
    liveDraftStatus: null,
    board: null,
    poolAsOfDraft: null,
    syncStatus: { lastSyncedAt: "0", syncInProgress: false, activeDrafts: [] },
    manualSyncInFlight: false,
  });

  useCardStore.setState({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,
    searchQuery: "",
    colorFilter: [],
    colorFilterMode: "inclusive",
    scryfallMatchNames: null,
    scryfallDataMap: new Map(),
    cardStatsMap: new Map(),
    takenCardNamesSet: undefined,
    takenCardCounts: undefined,
    seatCardNames: undefined,
    seatCardList: undefined,
    bannedCardNamesSet: undefined,
    displayCards: [],
    searchFilteredCards: [],
    availableCount: 0,
    drafts: [],
    selectedCard: null,
    cardStatsDetail: null,
    cardStatsLoading: false,
  });

  useLiveStore.setState({
    seatToken: null,
    mySeat: null,
    autoPick: true,
    autoPickMode: "resilient",
    displayName: null,
    queue: [],
    queuedCards: new Map(),
    queueLoading: false,
    queueError: null,
    floatedCards: [],
    floatedCardsSet: new Set<string>(),
    pickError: null,
    isMyTurn: false,
    consecutivePicks: 0,
    deckState: createEmptyDeckState("", 0),
    deckReady: false,
    deckSaveStatus: "idle",
    deckBuilderActive: false,
  });
}

// ---------------------------------------------------------------------------
// getCardStatus
// ---------------------------------------------------------------------------

describe("getCardStatus", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns 'picked' when card is in seatCardNames", () => {
    useCardStore.setState({ seatCardNames: new Set(["Lightning Bolt"]) });
    expect(getCardStatus("Lightning Bolt")).toEqual({ status: "picked" });
  });

  it("returns 'queued' with position when authed and card is in queuedCards", () => {
    useDraftStore.setState({ selectedSeat: 2 });
    useLiveStore.setState({
      mySeat: 2,
      queuedCards: new Map([["Counterspell", 1]]),
    });
    expect(getCardStatus("Counterspell")).toEqual({
      status: "queued",
      queuePosition: 1,
    });
  });

  it("returns 'floated' when authed and card is in floatedCards", () => {
    useDraftStore.setState({ selectedSeat: 3 });
    useLiveStore.setState({
      mySeat: 3,
      floatedCards: ["Dark Ritual"],
      floatedCardsSet: new Set(["Dark Ritual"]),
    });
    expect(getCardStatus("Dark Ritual")).toEqual({ status: "floated" });
  });

  it("returns 'taken' when card is in takenCardNamesSet but not picked", () => {
    useCardStore.setState({ takenCardNamesSet: new Set(["Brainstorm"]) });
    expect(getCardStatus("Brainstorm")).toEqual({ status: "taken" });
  });

  it("returns 'none' for an unknown card", () => {
    expect(getCardStatus("Unknown Card")).toEqual({ status: "none" });
  });

  it("does not return 'queued' when mySeat differs from selectedSeat", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: 2,
      queuedCards: new Map([["Force of Will", 0]]),
    });
    expect(getCardStatus("Force of Will")).toEqual({ status: "none" });
  });

  it("does not return 'floated' when not authed (mySeat is null)", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: null,
      floatedCards: ["Ponder"],
      floatedCardsSet: new Set(["Ponder"]),
    });
    expect(getCardStatus("Ponder")).toEqual({ status: "none" });
  });

  it("'picked' takes priority over 'queued'", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: 1,
      queuedCards: new Map([["Swords to Plowshares", 0]]),
    });
    useCardStore.setState({
      seatCardNames: new Set(["Swords to Plowshares"]),
    });
    expect(getCardStatus("Swords to Plowshares")).toEqual({ status: "picked" });
  });

  it("'queued' takes priority over 'taken'", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: 1,
      queuedCards: new Map([["Thoughtseize", 2]]),
    });
    useCardStore.setState({
      takenCardNamesSet: new Set(["Thoughtseize"]),
    });
    expect(getCardStatus("Thoughtseize")).toEqual({
      status: "queued",
      queuePosition: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// getImageUrl
// ---------------------------------------------------------------------------

describe("getImageUrl", () => {
  beforeEach(() => {
    resetStores();
  });

  it("returns imageUri from scryfallDataMap", () => {
    useCardStore.setState({
      scryfallDataMap: new Map([
        [
          "Lightning Bolt",
          {
            name: "Lightning Bolt",
            imageUri: "https://cards.scryfall.io/lightning-bolt.jpg",
            manaCost: "{R}",
            manaValue: 1,
            typeLine: "Instant",
            colors: ["R"],
            colorIdentity: ["R"],
            oracleText: "Deal 3 damage.",
          },
        ],
      ]),
    });
    expect(getImageUrl("Lightning Bolt")).toBe(
      "https://cards.scryfall.io/lightning-bolt.jpg",
    );
  });

  it("returns undefined for null cardName", () => {
    expect(getImageUrl(null)).toBeUndefined();
  });

  it("returns undefined for an unknown card", () => {
    expect(getImageUrl("Nonexistent Card")).toBeUndefined();
  });
});
