import { useEffect, useMemo, useRef } from "react";
import type { DeckState, ScryCard } from "@/core/types";
import type { DeckAction } from "@/core/deckBuilder";

interface UseDeckBuilderSyncProps {
  deckBuilderActive: boolean;
  seatCardList: string[] | undefined;
  deckBuilderState: DeckState;
  dispatch: (action: DeckAction) => void;
  scryfallDataMap: Map<string, ScryCard>;
  activeDraft: string | null;
  selectedSeat: number | null;
  ready: boolean;
  floatedCards: string[];
  queuedCardNames: string[];
}

/**
 * Manages deck builder initialization from seat picks and
 * reconciliation on data refreshes.
 *
 * - On first activation with pick data: dispatches INIT_FROM_PICKS
 *   if the deck builder zones are empty.
 * - On subsequent data refreshes: dispatches SYNC_PICKS to reconcile
 *   new picks into the existing deck state.
 * - Auto-removes cards that were floated/queued but are no longer.
 */
export function useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  deckBuilderState,
  dispatch,
  scryfallDataMap,
  activeDraft,
  selectedSeat,
  ready,
  floatedCards,
  queuedCardNames,
}: UseDeckBuilderSyncProps): void {
  const allCardNames = useMemo(() => {
    const picks = seatCardList ?? [];
    return [...picks, ...floatedCards, ...queuedCardNames];
  }, [seatCardList, floatedCards, queuedCardNames]);

  // Initialize deck builder from seat picks when first opened
  const deckBuilderInitialized = useRef(false);
  useEffect(() => {
    if (deckBuilderActive && ready && allCardNames.length > 0 && !deckBuilderInitialized.current) {
      const isEmpty = Object.values(deckBuilderState.zones.deck).flat().length === 0
        && Object.values(deckBuilderState.zones.sideboard).flat().length === 0;
      if (isEmpty) {
        dispatch({
          type: "INIT_FROM_PICKS",
          picks: allCardNames,
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
  }, [deckBuilderActive, allCardNames, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile picked cards with deck builder state on every data refresh
  useEffect(() => {
    if (!deckBuilderActive || !ready || allCardNames.length === 0) return;
    dispatch({
      type: "SYNC_PICKS",
      pickedCardNames: allCardNames,
      scryfallData: scryfallDataMap,
    });
  }, [allCardNames, deckBuilderActive, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-remove cards that were floated/queued but are no longer
  const prevSpeculativeRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!deckBuilderActive || !ready) return;

    const pickedSet = new Set(seatCardList ?? []);
    const currentSpeculative = new Set([
      ...floatedCards.filter((c) => !pickedSet.has(c)),
      ...queuedCardNames.filter((c) => !pickedSet.has(c)),
    ]);

    const removed: string[] = [];
    for (const card of prevSpeculativeRef.current) {
      if (!currentSpeculative.has(card) && !pickedSet.has(card)) {
        removed.push(card);
      }
    }

    if (removed.length > 0) {
      dispatch({ type: "REMOVE_CARDS", cardNames: removed });
    }

    prevSpeculativeRef.current = currentSpeculative;
  }, [seatCardList, floatedCards, queuedCardNames, deckBuilderActive, ready, dispatch]);
}
