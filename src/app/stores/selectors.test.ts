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
    displayName: null,
    queue: [],
    queuedCardCounts: new Map(),
    queueLoading: false,
    queueError: null,
    floatedCards: [],
    floatedCardsSet: new Set<string>(),
    pickError: null,
    isMyTurn: false,
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

  it("returns 'picked' with remainingCopies when card is in seatCardNames", () => {
    useCardStore.setState({ seatCardNames: new Set(["Lightning Bolt"]) });
    // cubeCopies defaults to 1, takenCount is 0 → remainingCopies = 1
    expect(getCardStatus("Lightning Bolt")).toEqual({ status: "picked", remainingCopies: 1 });
  });

  it("returns 'picked' with remainingCopies=0 when single-copy card is fully taken (Fury case)", () => {
    useCardStore.setState({
      seatCardNames: new Set(["Fury"]),
      cardData: {
        ...useCardStore.getState().cardData,
        cubeCopies: { Fury: 1 },
      },
      takenCardCounts: new Map([["Fury", 1]]),
    });
    // You own Fury, all 1 copy is taken → remainingCopies = 0, no action buttons should show
    expect(getCardStatus("Fury")).toEqual({ status: "picked", remainingCopies: 0 });
  });

  it("returns 'queued' with position when authed and card is in queuedCardCounts", () => {
    useDraftStore.setState({ selectedSeat: 2 });
    useLiveStore.setState({
      mySeat: 2,
      queuedCardCounts: new Map([["Counterspell", 1]]),
      queue: [{ mode: 'pause', cards: [{ cardId: 0, cardName: "Counterspell" }] }],
    });
    expect(getCardStatus("Counterspell")).toEqual({
      status: "queued",
      queuePosition: 1,
      queuedCount: 1,
      remainingCopies: 1,
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
      queuedCardCounts: new Map([["Force of Will", 1]]),
      queue: [{ mode: 'pause', cards: [{ cardId: 0, cardName: "Force of Will" }] }],
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

  it("'queued' takes priority over 'picked' (allows queuing a card already in pool)", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: 1,
      queuedCardCounts: new Map([["Swords to Plowshares", 1]]),
      queue: [{ mode: 'pause', cards: [{ cardId: 0, cardName: "Swords to Plowshares" }] }],
    });
    useCardStore.setState({
      seatCardNames: new Set(["Swords to Plowshares"]),
    });
    // "queued" wins so the queue/pick buttons remain available (multi-copy scenario)
    expect(getCardStatus("Swords to Plowshares")).toMatchObject({ status: "queued" });
  });

  it("'queued' takes priority over 'taken'", () => {
    useDraftStore.setState({ selectedSeat: 1 });
    useLiveStore.setState({
      mySeat: 1,
      queuedCardCounts: new Map([["Thoughtseize", 1]]),
      // Position is 1-based entry index, so putting it in the second entry gives position 2
      queue: [
        { mode: 'pause', cards: [{ cardId: 99, cardName: "Other Card" }] },
        { mode: 'pause', cards: [{ cardId: 0, cardName: "Thoughtseize" }] },
      ],
    });
    useCardStore.setState({
      takenCardNamesSet: new Set(["Thoughtseize"]),
    });
    expect(getCardStatus("Thoughtseize")).toEqual({
      status: "queued",
      queuePosition: 2,
      queuedCount: 1,
      remainingCopies: 1,
    });
  });

  it("returns 'queued' with queuedCount and remainingCopies for multi-copy card", () => {
    useDraftStore.setState({ selectedSeat: 2 });
    useLiveStore.setState({
      mySeat: 2,
      queuedCardCounts: new Map([["Scalding Tarn", 2]]),
      queue: [
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Scalding Tarn" }] },
        { mode: 'pause', cards: [{ cardId: 10, cardName: "Scalding Tarn" }] },
      ],
    });
    useCardStore.setState({
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(),
      takenCardCounts: new Map([["Scalding Tarn", 1]]),
      cardData: { ...useCardStore.getState().cardData, cubeCopies: { "Scalding Tarn": 3 } },
    });

    const result = getCardStatus("Scalding Tarn");
    expect(result.status).toBe("queued");
    expect(result.queuePosition).toBe(1);
    expect(result.queuedCount).toBe(2);
    expect(result.remainingCopies).toBe(2); // 3 total - 1 taken
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
