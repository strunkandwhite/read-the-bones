import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { useDraftStore } from "./draftStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { isLocalClient } from "@/core/isLocal";

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
// Types
// ---------------------------------------------------------------------------

interface CardStoreState {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;

  fetchCardData: () => Promise<void>;
  hydrate: (initial: CardStatsResponse, draftStats: DraftStatsResponse) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCardStore = create<CardStoreState>()(
  subscribeWithSelector((set, get) => ({
    cardData: EMPTY_CARD_DATA,
    draftStats: EMPTY_DRAFT_STATS,
    isLoading: false,

    hydrate: (initial, draftStats) => {
      set({ cardData: initial, draftStats });
    },

    fetchCardData: async () => {
      const { selectedDrafts, activeDraft, poolAsOfDraft } = useDraftStore.getState();
      const effectivePool = activeDraft ?? poolAsOfDraft;

      if (selectedDrafts.size === 0) {
        set((s) => ({
          cardData: { ...s.cardData, cards: [], draftCount: 0, cubeCopies: {} },
        }));
        return;
      }

      set({ isLoading: true });
      try {
        const params = new URLSearchParams();
        params.set("drafts", [...selectedDrafts].join(","));
        params.set("v", get().cardData.ingestionHash);
        if (isLocalClient()) params.set("local", "1");
        if (activeDraft) params.set("activeDraft", activeDraft);
        if (effectivePool) params.set("poolAsOfDraft", effectivePool);

        const statsParams = new URLSearchParams();
        statsParams.set("drafts", [...selectedDrafts].join(","));
        statsParams.set("v", get().cardData.ingestionHash);

        const [cardsRes, statsRes] = await Promise.all([
          fetch(`/api/cards?${params}`),
          fetch(`/api/draft-stats?${statsParams}`),
        ]);

        if (cardsRes.ok) set({ cardData: await cardsRes.json() });
        if (statsRes.ok) set({ draftStats: await statsRes.json() });
      } catch (error) {
        console.error("Failed to fetch card data:", error);
      } finally {
        set({ isLoading: false });
      }
    },
  })),
);

// ---------------------------------------------------------------------------
// Cross-store subscriptions: refetch when draftStore changes
// ---------------------------------------------------------------------------

// Refetch when dataVersion changes (sync completed, live draft picks)
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => useCardStore.getState().fetchCardData(),
);

// Refetch when poolAsOfDraft changes
useDraftStore.subscribe(
  (state) => state.poolAsOfDraft,
  () => useCardStore.getState().fetchCardData(),
);
