import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import { isLocalClient } from "@/core/isLocal";

interface UseCardDataProps {
  initialCardData: CardStatsResponse;
  initialDraftStats: DraftStatsResponse;
  selectedDrafts: Set<string>;
  activeDraft: string | null;
  poolAsOfDraft: string | null;
  syncDataChanged: boolean;
  liveDraftDataChanged?: number;
}

interface UseCardDataReturn {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;
  handleDraftsChange: (drafts: Set<string>) => Promise<void>;
}

export function useCardData({
  initialCardData,
  initialDraftStats,
  selectedDrafts,
  activeDraft,
  poolAsOfDraft,
  syncDataChanged,
  liveDraftDataChanged,
}: UseCardDataProps): UseCardDataReturn {
  const [cardData, setCardData] = useState<CardStatsResponse>(initialCardData);
  const [draftStats, setDraftStats] = useState<DraftStatsResponse>(initialDraftStats);
  const [isLoading, setIsLoading] = useState(false);

  const isLocal = useMemo(() => isLocalClient(), []);

  // Reusable fetch function for card data and draft stats
  const fetchCardData = useCallback(
    async (draftSelection: Set<string>, activeDraftId: string | null, poolDraftId: string | null) => {
      if (draftSelection.size === 0) {
        setCardData((prev) => ({
          ...prev,
          cards: [],
          draftCount: 0,
          cubeCopies: {},
        }));
        return;
      }

      setIsLoading(true);
      try {
        const draftsJoined = [...draftSelection].join(",");
        const params = new URLSearchParams();
        params.set("drafts", draftsJoined);
        params.set("v", cardData.ingestionHash);
        if (isLocal) params.set("local", "1");
        if (activeDraftId) params.set("activeDraft", activeDraftId);
        if (poolDraftId) params.set("poolAsOfDraft", poolDraftId);

        const statsParams = new URLSearchParams();
        statsParams.set("drafts", draftsJoined);
        statsParams.set("v", cardData.ingestionHash);

        const [cardsRes, statsRes] = await Promise.all([
          fetch(`/api/cards?${params}`),
          fetch(`/api/draft-stats?${statsParams}`),
        ]);

        if (!cardsRes.ok) throw new Error("Cards API request failed");
        const data: CardStatsResponse = await cardsRes.json();
        setCardData(data);

        if (statsRes.ok) {
          const stats: DraftStatsResponse = await statsRes.json();
          setDraftStats(stats);
        }
      } catch (error) {
        console.error("Failed to fetch card data:", error);
      } finally {
        setIsLoading(false);
      }
    },
    [cardData.ingestionHash, isLocal]
  );

  // Handle draft selection change — fetch recalculated stats from the API
  const handleDraftsChange = useCallback(
    async (newSelection: Set<string>) => {
      await fetchCardData(newSelection, activeDraft, poolAsOfDraft);
    },
    [fetchCardData, activeDraft, poolAsOfDraft]
  );

  // Refetch when sync detects changes
  useEffect(() => {
    if (syncDataChanged && activeDraft) {
      fetchCardData(selectedDrafts, activeDraft, poolAsOfDraft);
    }
  }, [syncDataChanged, activeDraft, poolAsOfDraft, selectedDrafts, fetchCardData]);

  // Keep refs to latest values so the effect always reads current state
  const selectedDraftsRef = useRef(selectedDrafts);
  selectedDraftsRef.current = selectedDrafts;
  const activeDraftRef = useRef(activeDraft);
  activeDraftRef.current = activeDraft;
  const poolAsOfDraftRef = useRef(poolAsOfDraft);
  poolAsOfDraftRef.current = poolAsOfDraft;

  // Refetch when live draft picks change (updates taken cards)
  useEffect(() => {
    if (liveDraftDataChanged && activeDraft) {
      fetchCardData(selectedDraftsRef.current, activeDraftRef.current, poolAsOfDraftRef.current);
    }
  }, [liveDraftDataChanged, activeDraft, fetchCardData]);

  // Refetch when activeDraft or poolAsOfDraft changes (skip initial mount)
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    fetchCardData(selectedDraftsRef.current, activeDraftRef.current, poolAsOfDraftRef.current);
  }, [activeDraft, poolAsOfDraft, fetchCardData]);

  return {
    cardData,
    draftStats,
    isLoading,
    handleDraftsChange,
  };
}
