import { useEffect, useRef } from "react";
import type { DeckState, ScryCard } from "@/core/types";
import type { DeckAction } from "@/core/deckBuilder";

interface UseDeckBuilderSyncProps {
  deckBuilderActive: boolean;
  seatCardList: string[] | undefined;
  takenCardNamesSet: Set<string> | undefined;
  deckBuilderState: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallDataMap: Map<string, ScryCard>;
  activeDraft: string | null;
  selectedSeat: number | null;
}

/**
 * Manages deck builder initialization from seat picks and
 * reconciliation on data refreshes.
 *
 * - On first activation with pick data: dispatches INIT_FROM_PICKS
 *   if the deck builder zones are empty.
 * - On subsequent data refreshes: dispatches SYNC_PICKS to reconcile
 *   new picks into the existing deck state.
 */
export function useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  takenCardNamesSet,
  deckBuilderState,
  dispatch,
  scryfallDataMap,
  activeDraft,
  selectedSeat,
}: UseDeckBuilderSyncProps): void {
  // Initialize deck builder from seat picks when first opened
  const deckBuilderInitialized = useRef(false);
  useEffect(() => {
    if (deckBuilderActive && seatCardList && seatCardList.length > 0 && !deckBuilderInitialized.current) {
      const isEmpty = Object.values(deckBuilderState.zones.deck).flat().length === 0
        && Object.values(deckBuilderState.zones.sideboard).flat().length === 0;
      if (isEmpty) {
        dispatch({
          type: "INIT_FROM_PICKS",
          picks: seatCardList!,
          scryfallData: scryfallDataMap,
          draftId: activeDraft ?? "",
          seat: selectedSeat ?? 0,
        });
      }
      deckBuilderInitialized.current = true;
    }
    if (!deckBuilderActive) {
      deckBuilderInitialized.current = false;
    }
  }, [deckBuilderActive, seatCardList]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile picked cards with deck builder state on every data refresh
  useEffect(() => {
    if (!deckBuilderActive || !seatCardList || seatCardList.length === 0) return;
    dispatch({
      type: "SYNC_PICKS",
      pickedCardNames: seatCardList,
      takenCardNames: takenCardNamesSet ? Array.from(takenCardNamesSet) : undefined,
      scryfallData: scryfallDataMap,
    });
  }, [seatCardList, deckBuilderActive]); // eslint-disable-line react-hooks/exhaustive-deps
}
