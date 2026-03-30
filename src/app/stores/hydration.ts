import { useEffect, useRef } from "react";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";

export interface HydrationProps {
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  completedDraftIds: string[];
  initialDraftId?: string;
}

export function useHydration({
  cardData,
  draftStats,
  completedDraftIds,
  initialDraftId,
}: HydrationProps): boolean {
  const hydrated = useDraftStore((s) => s.hydrated);
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    // Hydrate card store first (so derived state is available for draftStore subscribers)
    useCardStore.getState().hydrate(cardData, draftStats);

    // Then hydrate draft store (selection state from localStorage + SSR props)
    useDraftStore.getState().hydrate({ completedDraftIds, initialDraftId });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return hydrated;
}
