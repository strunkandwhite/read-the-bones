import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { track } from "@vercel/analytics/react";
import { useDraftStore } from "./draftStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import type { ScryCard, EnrichedCardStats } from "@/core/types";
import type { ColorFilterMode } from "@/core/colorFilter";
import { isLocalClient } from "@/core/isLocal";
import { getFrontFace } from "@/core/cardNames";
import { searchLocalCards } from "@/core/localSearch";
import { hasScryfallOperators } from "@/core/searchUtils";

// ---------------------------------------------------------------------------
// Empty defaults
// ---------------------------------------------------------------------------

export const EMPTY_CARD_DATA: CardStatsResponse = {
  cards: [],
  draftCount: 0,
  cubeCopies: {},
  draftMetadata: {},
  draftIds: [],
  completedDraftIds: [],
  ingestionHash: "",
};

export const EMPTY_DRAFT_STATS: DraftStatsResponse = {
  winRateBySeat: [],
  winRateByColor: [],
  ingestionHash: "",
};

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------

function classifyQueryType(query: string): string {
  const prefixes = ["t:", "o:", "c:", "mv", "cmc"];
  const found = prefixes.filter((p) => query.includes(p));
  if (found.length > 1) return "multi";
  if (found[0] === "t:") return "type";
  if (found[0] === "o:") return "oracle";
  if (found[0] === "c:") return "color";
  if (found[0] === "mv" || found[0] === "cmc") return "mv";
  return "unknown";
}

// Module-scoped debounce state
let searchTimeout: ReturnType<typeof setTimeout> | null = null;

// Module-scoped request identity for fetchCardData.
// Each call increments the counter and captures its own ID. On resolve,
// a response is committed only if its ID matches the latest — stale
// responses from superseded fetches are discarded harmlessly.
// If a trigger arrives while a fetch is in flight, a trailing re-run is
// queued (pendingFetch = true) so the trigger is never lost.
let fetchRequestId = 0;
let fetchInFlight = false;
let pendingFetch = false;

// Module-scoped cache for recompute map rebuilds
let lastCardDataRef: CardStatsResponse | null = null;
let cachedScryfallDataMap = new Map<string, ScryCard>();
let cachedCardStatsMap = new Map<string, EnrichedCardStats>();

/** Exported for tests to clear debounce state between runs. */
export function _resetSearchState() {
  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }
  fetchRequestId = 0;
  fetchInFlight = false;
  pendingFetch = false;
  lastCardDataRef = null;
  cachedScryfallDataMap = new Map();
  cachedCardStatsMap = new Map();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardStatsData = {
  pick: { drafts_in_pool: number; times_picked: number; avg_pick: number; median_pick: number; geomean_pick: number };
  play?: { times_drafted: number; times_maindecked: number; play_rate: number };
  wins?: { game_wins: number; game_losses: number; win_rate: number; win_rate_ci: { lower: number; center: number; upper: number }; low_sample: boolean; drafts_with_data: number };
  pick_history: Array<{ draftId: string; draftName: string; draftDate: string; pickPosition: number; picked: boolean; numSeats: number }>;
  pick_distribution: number[];
  times_banned: number;
  color_pair_breakdown: Array<{ colorPair: string; percentage: number; deckCount: number }>;
};

interface DraftListItem {
  id: string;
  name: string;
  date: string;
  isComplete: boolean;
  numDrafters: number;
}

interface CardStoreState {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;

  // Search state
  searchQuery: string;
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  scryfallMatchNames: Set<string> | null;

  // Derived state
  scryfallDataMap: Map<string, ScryCard>;
  cardStatsMap: Map<string, EnrichedCardStats>;
  takenCardNamesSet: Set<string> | undefined;
  takenCardCounts: Map<string, number> | undefined;
  seatCardNames: Set<string> | undefined;
  seatCardList: string[] | undefined;
  bannedCardNamesSet: Set<string> | undefined;
  displayCards: EnrichedCardStats[];
  searchFilteredCards: EnrichedCardStats[];
  availableCount: number;
  drafts: DraftListItem[];

  // Card stats modal state
  selectedCard: string | null;
  cardStatsDetail: CardStatsData | null;
  cardStatsLoading: boolean;

  // Actions
  //
  // fetchCardData({ includeDraftStats }) — pass false to skip the /api/draft-stats
  // request. Draft-stats cover completed drafts only and do not change mid-draft;
  // pick-driven refetches can safely omit them (saves one request per pick).
  fetchCardData: (opts?: { includeDraftStats?: boolean }) => Promise<void>;
  hydrate: (initial: CardStatsResponse, draftStats: DraftStatsResponse) => void;
  setSearchQuery: (query: string) => void;
  setColorFilter: (colors: string[]) => void;
  setColorFilterMode: (mode: ColorFilterMode) => void;
  clearSearch: () => void;
  selectCard: (name: string, excludeDraftId?: string) => Promise<void>;
  clearSelectedCard: () => void;
}

// ---------------------------------------------------------------------------
// Recompute — derives all computed state from current inputs
// ---------------------------------------------------------------------------

function recompute() {
  const state = useCardStore.getState();
  const { cardData, searchQuery, scryfallMatchNames } = state;
  const { activeDraft, hideTaken, selectedSeat } = useDraftStore.getState();

  // Only rebuild maps when cardData reference changes
  if (cardData !== lastCardDataRef) {
    lastCardDataRef = cardData;
    cachedScryfallDataMap = new Map<string, ScryCard>();
    cachedCardStatsMap = new Map<string, EnrichedCardStats>();
    for (const card of cardData.cards) {
      if (card.scryfall) cachedScryfallDataMap.set(card.cardName, card.scryfall);
      cachedCardStatsMap.set(card.cardName, card);
    }
  }

  const scryfallDataMap = cachedScryfallDataMap;
  const cardStatsMap = cachedCardStatsMap;

  // takenCardCounts
  let takenCardCounts: Map<string, number> | undefined;
  if (cardData.takenCards) {
    takenCardCounts = new Map<string, number>();
    for (const c of cardData.takenCards) {
      takenCardCounts.set(c.name, (takenCardCounts.get(c.name) ?? 0) + 1);
    }
  }

  // takenCardNamesSet — only cards where ALL copies are taken
  let takenCardNamesSet: Set<string> | undefined;
  if (takenCardCounts) {
    takenCardNamesSet = new Set<string>();
    for (const [name, count] of takenCardCounts) {
      if (count >= (cardData.cubeCopies[name] ?? 1)) {
        takenCardNamesSet.add(name);
      }
    }
  }

  // seatCardNames + seatCardList
  let seatCardNames: Set<string> | undefined;
  let seatCardList: string[] | undefined;
  if (cardData.takenCards && selectedSeat != null) {
    const seatPicks = cardData.takenCards.filter(
      (c) => c.seat === selectedSeat,
    );
    seatCardList = seatPicks.map((c) => c.name);
    seatCardNames = new Set(seatCardList);
  }

  // bannedCardNamesSet
  let bannedCardNamesSet: Set<string> | undefined;
  if (activeDraft && cardData.bannedCardNames) {
    bannedCardNamesSet = new Set(cardData.bannedCardNames);
  }

  // displayCards
  let displayCards = cardData.cards;
  if (bannedCardNamesSet) {
    displayCards = displayCards.filter((c) => {
      if (bannedCardNamesSet!.has(c.cardName)) return false;
      const frontFace = getFrontFace(c.cardName);
      return frontFace ? !bannedCardNamesSet!.has(frontFace) : true;
    });
  }
  if (hideTaken && takenCardNamesSet) {
    displayCards = displayCards.filter((c) => !takenCardNamesSet!.has(c.cardName));
  }

  // searchFilteredCards
  let searchFilteredCards: EnrichedCardStats[];
  if (scryfallMatchNames) {
    searchFilteredCards = displayCards.filter((c) =>
      scryfallMatchNames.has(c.cardName),
    );
  } else if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    searchFilteredCards = displayCards.filter((c) =>
      c.cardName.toLowerCase().includes(q),
    );
  } else {
    searchFilteredCards = displayCards;
  }

  // availableCount
  let availableCount = 0;
  if (activeDraft && takenCardNamesSet) {
    const bannedSet = new Set(cardData.bannedCardNames ?? []);
    availableCount = cardData.cards.filter((c) => {
      if (takenCardNamesSet!.has(c.cardName)) return false;
      if (bannedSet.has(c.cardName)) return false;
      const frontFace = getFrontFace(c.cardName);
      return frontFace ? !bannedSet.has(frontFace) : true;
    }).length;
  }

  // drafts
  const completedSet = new Set(cardData.completedDraftIds);
  const drafts: DraftListItem[] = cardData.draftIds.map((id) => ({
    id,
    name: cardData.draftMetadata[id]?.name || id,
    date: cardData.draftMetadata[id]?.date || "1970-01-01",
    isComplete: completedSet.has(id),
    numDrafters: cardData.draftMetadata[id]?.numDrafters || 10,
  }));

  useCardStore.setState({
    scryfallDataMap,
    cardStatsMap,
    takenCardNamesSet,
    takenCardCounts,
    seatCardNames,
    seatCardList,
    bannedCardNamesSet,
    displayCards,
    searchFilteredCards,
    availableCount,
    drafts,
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCardStore = create<CardStoreState>()(
  subscribeWithSelector((set, get) => ({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,

    // Search state
    searchQuery: "",
    colorFilter: [],
    colorFilterMode: "inclusive" as ColorFilterMode,
    scryfallMatchNames: null,

    // Card stats modal state
    selectedCard: null,
    cardStatsDetail: null,
    cardStatsLoading: false,

    // Derived state (initial empty values)
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

    // Actions
    hydrate: (initial, draftStats) => {
      set({ cardData: initial, draftStats });
      recompute();
    },

    fetchCardData: async ({ includeDraftStats = true } = {}) => {
      // If a fetch is already in flight, record that another run is needed
      // and return — the in-flight fetch will re-run on completion.
      if (fetchInFlight) {
        pendingFetch = true;
        return;
      }
      fetchInFlight = true;

      // Capture a monotonically increasing request ID and read all fetch
      // parameters at the START of this fetch, before any awaits.
      const requestId = ++fetchRequestId;
      const { selectedDrafts, activeDraft, poolAsOfDraft } =
        useDraftStore.getState();
      const effectivePool = activeDraft ?? poolAsOfDraft;

      if (selectedDrafts.size === 0) {
        set((s) => ({
          cardData: {
            ...s.cardData,
            cards: [],
            draftCount: 0,
            cubeCopies: {},
          },
        }));
        recompute();
        fetchInFlight = false;
        // If a trigger arrived while we were clearing, re-run immediately.
        if (pendingFetch) {
          pendingFetch = false;
          useCardStore.getState().fetchCardData();
        }
        return;
      }

      set({ isLoading: true });
      try {
        // Use the server's known ingestionHash (from the last sync-status response)
        // as the ?v= cache-buster. This represents the data the client WANTS, not
        // the data it already has — so the edge cache is busted toward new data.
        // Fall back to the client's current hash when the server hash is unavailable
        // (e.g. before the first sync-status poll).
        const serverHash = useDraftStore.getState().syncStatus.ingestionHash;
        const currentHash = serverHash ?? get().cardData.ingestionHash;

        const params = new URLSearchParams();
        params.set("drafts", [...selectedDrafts].join(","));
        params.set("v", currentHash);
        if (isLocalClient()) params.set("local", "1");
        if (activeDraft) params.set("activeDraft", activeDraft);
        if (effectivePool) params.set("poolAsOfDraft", effectivePool);

        // Draft-stats cover completed drafts only and cannot change mid-draft.
        // Skip the /api/draft-stats request when a pick triggered this fetch
        // (the caller sets includeDraftStats=false for pick-driven refetches).
        const fetches: [Promise<Response>, Promise<Response> | null] = [
          fetch(`/api/cards?${params}`),
          includeDraftStats
            ? (() => {
                const statsParams = new URLSearchParams();
                statsParams.set("drafts", [...selectedDrafts].join(","));
                statsParams.set("v", currentHash);
                return fetch(`/api/draft-stats?${statsParams}`);
              })()
            : null,
        ];

        const [cardsRes, statsRes] = await Promise.all(fetches);

        // Only commit if this response is still the latest request.
        // A superseded response (requestId < fetchRequestId) is discarded
        // so stale data from an old selection never overwrites new state.
        if (requestId === fetchRequestId) {
          if (cardsRes?.ok) set({ cardData: await cardsRes.json() });
          if (statsRes?.ok) set({ draftStats: await statsRes.json() });
          recompute();
        }
      } catch (error) {
        console.error("Failed to fetch card data:", error);
      } finally {
        set({ isLoading: false });
        fetchInFlight = false;
        // If a trigger arrived while this fetch was in flight, run it now.
        if (pendingFetch) {
          pendingFetch = false;
          useCardStore.getState().fetchCardData();
        }
      }
    },

    setSearchQuery: (query: string) => {
      set({ searchQuery: query });
      if (searchTimeout) clearTimeout(searchTimeout);

      const trimmed = query.trim();
      if (!trimmed) {
        set({ scryfallMatchNames: null });
        recompute();
        return;
      }

      if (!hasScryfallOperators(trimmed)) {
        set({ scryfallMatchNames: null });
        recompute();
        setTimeout(() => {
          track("search", { query_type: "name", result_count: -1 });
        }, 500);
        return;
      }

      searchTimeout = setTimeout(() => {
        const scryfallCards = get()
          .cardData.cards.map((c) => c.scryfall)
          .filter(Boolean) as ScryCard[];
        const results = searchLocalCards(trimmed, scryfallCards);
        const names = new Set<string>();
        for (const card of results) {
          names.add(card.name);
          const frontFace = getFrontFace(card.name);
          if (frontFace) names.add(frontFace);
        }
        set({ scryfallMatchNames: names });
        recompute();
        track("search", {
          query_type: classifyQueryType(trimmed),
          result_count: results.length,
        });
      }, 500);
    },

    setColorFilter: (colors: string[]) => {
      set({ colorFilter: colors });
      recompute();
    },

    setColorFilterMode: (mode: ColorFilterMode) => {
      set({ colorFilterMode: mode });
      recompute();
    },

    clearSearch: () => {
      if (searchTimeout) {
        clearTimeout(searchTimeout);
        searchTimeout = null;
      }
      set({ searchQuery: "", scryfallMatchNames: null });
      recompute();
      track("search_cleared");
    },

    selectCard: async (name, excludeDraftId) => {
      set({ selectedCard: name, cardStatsLoading: true, cardStatsDetail: null });
      try {
        const params = new URLSearchParams({ card_name: name });
        if (excludeDraftId) params.set("exclude_draft_id", excludeDraftId);
        const res = await fetch(`/api/cards/stats?${params}`);
        if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
        set({ cardStatsDetail: await res.json() });
      } catch (error) {
        console.error("Failed to fetch card stats:", error);
      } finally {
        set({ cardStatsLoading: false });
      }
    },

    clearSelectedCard: () => set({ selectedCard: null, cardStatsDetail: null }),
  })),
);

// ---------------------------------------------------------------------------
// Cross-store subscriptions: refetch when draftStore changes
// ---------------------------------------------------------------------------

// Refetch when selectedDrafts changes
useDraftStore.subscribe(
  (state) => state.selectedDrafts,
  () => useCardStore.getState().fetchCardData(),
);

// pickVersion: a live pick landed — refetch card data only.
// Draft-stats cover completed drafts only and cannot change mid-draft,
// so skip /api/draft-stats here. Task 21 will remove this subscription
// entirely once pick-driven card state is derived from board.picks.
useDraftStore.subscribe(
  (state) => state.pickVersion,
  () => useCardStore.getState().fetchCardData({ includeDraftStats: false }),
);

// dataVersion: ingestion/sync data changed — refetch BOTH card data and draft-stats.
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => useCardStore.getState().fetchCardData(),
);

// Refetch when poolAsOfDraft changes
useDraftStore.subscribe(
  (state) => state.poolAsOfDraft,
  () => useCardStore.getState().fetchCardData(),
);

// Refetch card data when activeDraft changes (taken cards depend on active draft)
useDraftStore.subscribe(
  (state) => state.activeDraft,
  () => useCardStore.getState().fetchCardData(),
);

// Recompute derived state when display-affecting draftStore state changes
useDraftStore.subscribe(
  (state) =>
    [state.hideTaken, state.selectedSeat] as const,
  () => recompute(),
  {
    equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1],
  },
);
