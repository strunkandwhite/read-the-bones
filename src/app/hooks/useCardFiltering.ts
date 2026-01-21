import { useMemo, useCallback } from "react";
import type { CardStatsResponse } from "@/core/getCards";
import type { EnrichedCardStats } from "@/core/types";

interface UseCardFilteringProps {
  cardData: CardStatsResponse;
  activeDraft: string | null;
  hideTaken: boolean;
  selectedSeat: number | null;
  searchQuery: string;
  scryfallMatchNames: Set<string> | null;
}

interface UseCardFilteringReturn {
  displayCards: EnrichedCardStats[];
  searchFilteredCards: EnrichedCardStats[];
  availableCount: number;
  takenCardNamesSet: Set<string> | undefined;
  seatCardNames: Set<string> | undefined;
  seatCardList: string[] | undefined;
}

export function useCardFiltering({
  cardData,
  activeDraft,
  hideTaken,
  selectedSeat,
  searchQuery,
  scryfallMatchNames,
}: UseCardFilteringProps): UseCardFilteringReturn {
  const takenCardNamesSet = useMemo(() => {
    if (!activeDraft || !cardData.takenCards) return undefined;
    return new Set(cardData.takenCards.map((c) => c.name));
  }, [activeDraft, cardData.takenCards]);

  const seatCardList = useMemo(() => {
    if (!activeDraft || !cardData.takenCards || selectedSeat === null)
      return undefined;
    return cardData.takenCards
      .filter((c) => c.seat === selectedSeat)
      .map((c) => c.name);
  }, [activeDraft, cardData.takenCards, selectedSeat]);

  const seatCardNames = useMemo(() => {
    if (!seatCardList) return undefined;
    return new Set(seatCardList);
  }, [seatCardList]);

  const bannedCardNamesSet = useMemo(() => {
    if (!activeDraft || !cardData.bannedCardNames) return undefined;
    return new Set(cardData.bannedCardNames);
  }, [activeDraft, cardData.bannedCardNames]);

  const isBanned = useCallback(
    (cardName: string) => {
      if (!bannedCardNamesSet) return false;
      if (bannedCardNamesSet.has(cardName)) return true;
      if (cardName.includes(" // ")) {
        return bannedCardNamesSet.has(cardName.split(" // ")[0]);
      }
      return false;
    },
    [bannedCardNamesSet]
  );

  const displayCards = useMemo(() => {
    let cards = cardData.cards;

    // Always filter out banned cards when active draft is selected
    if (bannedCardNamesSet) {
      cards = cards.filter((c) => !isBanned(c.cardName));
    }

    // Conditionally filter taken cards, but keep the selected seat's cards
    if (activeDraft && takenCardNamesSet && hideTaken) {
      cards = cards.filter(
        (c) =>
          !takenCardNamesSet.has(c.cardName) ||
          seatCardNames?.has(c.cardName)
      );
    }

    return cards;
  }, [
    activeDraft,
    cardData,
    hideTaken,
    takenCardNamesSet,
    seatCardNames,
    bannedCardNamesSet,
    isBanned,
  ]);

  const availableCount = useMemo(() => {
    if (!activeDraft || !takenCardNamesSet) return 0;
    return cardData.cards.filter(
      (c) => !takenCardNamesSet.has(c.cardName) && !isBanned(c.cardName)
    ).length;
  }, [activeDraft, cardData, takenCardNamesSet, isBanned]);

  // Filter displayed cards by Scryfall results when available
  const filteredDisplayedCards = useMemo(() => {
    if (!scryfallMatchNames) return displayCards;
    return displayCards.filter((card) => scryfallMatchNames.has(card.cardName));
  }, [displayCards, scryfallMatchNames]);

  // Apply client-side name filtering when not using Scryfall
  const searchFilteredCards = useMemo(() => {
    if (scryfallMatchNames) return filteredDisplayedCards;
    if (!searchQuery) return filteredDisplayedCards;
    const query = searchQuery.toLowerCase();
    return filteredDisplayedCards.filter((card) =>
      card.cardName.toLowerCase().includes(query)
    );
  }, [filteredDisplayedCards, scryfallMatchNames, searchQuery]);

  return {
    displayCards,
    searchFilteredCards,
    availableCount,
    takenCardNamesSet,
    seatCardNames,
    seatCardList,
  };
}
