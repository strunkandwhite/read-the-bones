import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { track } from "@vercel/analytics/react";
import { useDraftStore } from "./draftStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import type { ScryCard, EnrichedCardStats } from "@/core/types";
import type { WorthCard } from "@/core/worthModel";
import type { ColorFilterMode } from "@/core/colorFilter";
import { isLocalClient } from "@/core/isLocal";
import { getFrontFace } from "@/core/cardNames";
import { searchLocalCards } from "@/core/localSearch";
import { hasScryfallOperators } from "@/core/searchUtils";
import { DEFAULT_NUM_SEATS } from "@/core/constants";

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

// Module-scoped client-side cache for /api/cards/stats responses.
// Keyed by "<name>\0<excludeDraftId>" (NUL separator avoids collisions).
// Each entry stores the ingestionHash that was current when it was fetched;
// the entry is considered stale when the card data's ingestionHash changes,
// so syncing new data or switching cube versions always triggers a real fetch.
interface CardStatsCacheEntry {
  data: CardStatsData;
  ingestionHash: string;
}
let cardStatsCache = new Map<string, CardStatsCacheEntry>();

// Module-scoped cache marker for /api/cards/worth (dev-only route).
// Records the ingestionHash the worth table was fetched for, so the table is
// refetched only when the hash changes. Reset to null on failure so the next
// hash-change trigger retries (the dev server may have been mid-compile).
let worthFetchedForHash: string | null = null;

/** Exported for tests to clear debounce and cache state between runs. */
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
  cardStatsCache = new Map();
  worthFetchedForHash = null;
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

// Fit parameters as returned by /api/cards/worth (snake_case at the API
// boundary). Only the fields the UI reads are typed; the route may include more.
interface WorthModelSummary {
  a: number;
  b: number;
  tau: number;
  tau0: number;
  sigma: number;
  tau_a: number;
  kappa: number;
  baselines: Record<string, number>;
  pair_edges: Record<string, number>;
}

interface WorthTableResponse {
  cards: WorthCard[];
  model: WorthModelSummary;
}

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
  // Minimal staleness signal: true when the last fetchCardData call failed.
  // Reset to false on next successful fetch.
  lastFetchFailed: boolean;

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
  // Sorted list of card names available for picking (cube minus taken minus banned).
  // Used by PickAutocomplete instead of fetching /api/available per pick.
  availableCardNames: string[];
  drafts: DraftListItem[];

  // Card stats modal state
  selectedCard: string | null;
  cardStatsDetail: CardStatsData | null;
  cardStatsLoading: boolean;

  // Worth model state (dev-only; populated from /api/cards/worth on localhost)
  worthCards: Map<string, WorthCard>;
  worthModel: WorthModelSummary | null;
  // Dev-only override for the pick desire is evaluated at (null = automatic:
  // the live draft's current pick, else 1). Session state, not persisted.
  desirePickOverride: number | null;

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
  fetchWorthTable: () => Promise<void>;
  setDesirePickOverride: (pick: number | null) => void;
}

// ---------------------------------------------------------------------------
// Recompute — derives all computed state from current inputs
// ---------------------------------------------------------------------------

function recompute() {
  const state = useCardStore.getState();
  const { cardData, searchQuery, scryfallMatchNames } = state;
  const { activeDraft, hideTaken, selectedSeat, board } = useDraftStore.getState();

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

  // Determine the effective source of taken-card data:
  //   - Active draft with a populated board: derive from board.picks (already in
  //     every poll response, so this is always live without an API round-trip per pick).
  //   - Non-active / completed drafts, or before the first poll arrives:
  //     use cardData.takenCards from the last /api/cards fetch.
  //
  // Guard: board.picks must be an array (a malformed poll response where the
  // live endpoint returns non-board data leaves board.picks as undefined).
  const effectiveTakenCards: Array<{ name: string; seat: number }> | undefined =
    activeDraft && Array.isArray(board?.picks)
      ? board!.picks.map((p) => ({ name: p.cardName, seat: p.seat }))
      : cardData.takenCards;

  // takenCardCounts
  let takenCardCounts: Map<string, number> | undefined;
  if (effectiveTakenCards) {
    takenCardCounts = new Map<string, number>();
    for (const c of effectiveTakenCards) {
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
  if (effectiveTakenCards && selectedSeat != null) {
    const seatPicks = effectiveTakenCards.filter(
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

  // availableCount + availableCardNames (cube minus taken minus banned)
  let availableCount = 0;
  let availableCardNames: string[] = [];
  if (activeDraft && takenCardNamesSet) {
    const bannedSet = new Set(cardData.bannedCardNames ?? []);
    const availableCards = cardData.cards.filter((c) => {
      if (takenCardNamesSet!.has(c.cardName)) return false;
      if (bannedSet.has(c.cardName)) return false;
      const frontFace = getFrontFace(c.cardName);
      return frontFace ? !bannedSet.has(frontFace) : true;
    });
    availableCount = availableCards.length;
    availableCardNames = availableCards.map((c) => c.cardName).sort();
  }

  // drafts
  const completedSet = new Set(cardData.completedDraftIds);
  const drafts: DraftListItem[] = cardData.draftIds.map((id) => ({
    id,
    name: cardData.draftMetadata[id]?.name || id,
    date: cardData.draftMetadata[id]?.date || "1970-01-01",
    isComplete: completedSet.has(id),
    numDrafters: cardData.draftMetadata[id]?.numDrafters || DEFAULT_NUM_SEATS,
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
    availableCardNames,
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
    lastFetchFailed: false,

    // Search state
    searchQuery: "",
    colorFilter: [],
    colorFilterMode: "inclusive" as ColorFilterMode,
    scryfallMatchNames: null,

    // Card stats modal state
    selectedCard: null,
    cardStatsDetail: null,
    cardStatsLoading: false,

    // Worth model state
    worthCards: new Map(),
    worthModel: null,
    desirePickOverride: null,

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
    availableCardNames: [],
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
      const { selectedDrafts, activeDraft } = useDraftStore.getState();
      const effectivePool = useDraftStore.getState().getEffectivePoolAsOfDraft();

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
          const cardsFailed = !cardsRes?.ok;
          if (cardsRes?.ok) set({ cardData: await cardsRes.json() });
          if (statsRes?.ok) set({ draftStats: await statsRes.json() });
          set({ lastFetchFailed: cardsFailed });
          recompute();
        }
      } catch (error) {
        console.error("Failed to fetch card data:", error);
        set({ lastFetchFailed: true });
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
        // Debounce the analytics event so only the settled query fires,
        // not every intermediate keystroke. Compute the real result count
        // at fire time (after the user has stopped typing and recompute ran).
        searchTimeout = setTimeout(() => {
          const resultCount = useCardStore.getState().searchFilteredCards.length;
          track("search", { query_type: "name", result_count: resultCount });
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
        const cacheKey = `${name}\0${excludeDraftId ?? ""}`;
        const currentHash = get().cardData.ingestionHash;
        const cached = cardStatsCache.get(cacheKey);

        // Cache hit: serve immediately when the ingestionHash hasn't changed
        if (cached && cached.ingestionHash === currentHash) {
          set({ cardStatsDetail: cached.data, cardStatsLoading: false });
          return;
        }

        const params = new URLSearchParams({ card_name: name });
        if (excludeDraftId) params.set("exclude_draft_id", excludeDraftId);
        const res = await fetch(`/api/cards/stats?${params}`);
        if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
        const data: CardStatsData = await res.json();
        // Store in cache keyed to the current ingestionHash so it is automatically
        // invalidated when new data is ingested (dataVersion bump → fetchCardData
        // → new ingestionHash arrives in the response → future cache lookups miss).
        cardStatsCache.set(cacheKey, { data, ingestionHash: currentHash });
        set({ cardStatsDetail: data });
      } catch (error) {
        console.error("Failed to fetch card stats:", error);
      } finally {
        set({ cardStatsLoading: false });
      }
    },

    clearSelectedCard: () => set({ selectedCard: null, cardStatsDetail: null }),

    setDesirePickOverride: (pick) =>
      set({
        // Guard against NaN and fractional input; the override is a pick number.
        desirePickOverride:
          pick !== null && Number.isFinite(pick) && pick >= 1
            ? Math.floor(pick)
            : null,
      }),

    fetchWorthTable: async () => {
      // Dev-only: /api/cards/worth 404s in production builds, so production
      // clients must never request it.
      if (!isLocalClient()) return;

      const currentHash = get().cardData.ingestionHash;
      if (worthFetchedForHash === currentHash) return;
      // Mark before awaiting so overlapping triggers don't double-fetch.
      worthFetchedForHash = currentHash;

      try {
        const res = await fetch("/api/cards/worth");
        if (!res.ok) throw new Error(`Worth fetch failed: ${res.status}`);
        const data: WorthTableResponse = await res.json();
        // A newer hash may have started its own fetch while this one was in
        // flight; only the fetch that still owns the marker may write.
        if (worthFetchedForHash !== currentHash) return;
        const worthCards = new Map(
          data.cards.map((card) => [card.card_name, card]),
        );
        set({ worthCards, worthModel: data.model ?? null });
      } catch {
        // Swallow: the dev server may still be compiling the route. Empty
        // state hides the worth UI; clearing the marker lets the next
        // ingestionHash trigger retry. A stale failure must not clobber a
        // newer fetch's data or marker.
        if (worthFetchedForHash !== currentHash) return;
        worthFetchedForHash = null;
        set({ worthCards: new Map(), worthModel: null });
      }
    },
  })),
);

// Worth table (dev-only): fetch whenever the committed card data's
// ingestionHash changes — fires after SSR hydration and after any fetch that
// landed new data. fetchWorthTable itself no-ops off localhost and when the
// hash is one it already fetched for.
useCardStore.subscribe(
  (state) => state.cardData.ingestionHash,
  () => void useCardStore.getState().fetchWorthTable(),
);

// ---------------------------------------------------------------------------
// Cross-store subscriptions: refetch when draftStore changes
// ---------------------------------------------------------------------------

// Refetch when selectedDrafts changes
useDraftStore.subscribe(
  (state) => state.selectedDrafts,
  () => useCardStore.getState().fetchCardData(),
);

// pickVersion: a live pick landed — recompute derived state from board.picks
// (already in every poll response) instead of refetching /api/cards. This
// eliminates ~4,500 heavy API calls per 450-pick draft with 10 clients.
// The board field is read inside recompute() via useDraftStore.getState().
useDraftStore.subscribe(
  (state) => state.pickVersion,
  () => recompute(),
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
