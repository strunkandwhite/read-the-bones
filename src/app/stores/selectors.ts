import type { CardStatusResult } from "@/core/cardStatus";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import { useLiveStore } from "./liveStore";

export function getIsAuthed(): boolean {
  const { mySeat } = useLiveStore.getState();
  const { selectedSeat } = useDraftStore.getState();
  return mySeat !== null && mySeat === selectedSeat;
}

export function useIsAuthed(): boolean {
  const mySeat = useLiveStore((s) => s.mySeat);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);
  return mySeat !== null && mySeat === selectedSeat;
}

export function getCardStatus(cardName: string): CardStatusResult {
  const { seatCardNames, takenCardNamesSet, takenCardCounts, cardData } = useCardStore.getState();
  const { queuedCardCounts, floatedCardsSet, queue } = useLiveStore.getState();

  if (seatCardNames?.has(cardName)) return { status: "picked" };

  if (getIsAuthed()) {
    const count = queuedCardCounts.get(cardName);
    if (count != null && count > 0) {
      // Find the first entry (by index) that contains this card; position is 1-based entry index
      let entryPosition = Infinity;
      for (let i = 0; i < queue.length; i++) {
        if (queue[i].cards.some((c) => c.cardName === cardName)) {
          entryPosition = i + 1;
          break;
        }
      }
      const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
      const takenCount = takenCardCounts?.get(cardName) ?? 0;
      return {
        status: "queued",
        queuePosition: entryPosition,
        queuedCount: count,
        remainingCopies: cubeCopies - takenCount,
      };
    }
    if (floatedCardsSet.has(cardName)) return { status: "floated" };
  }

  if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}

export function getImageUrl(cardName: string | null): string | undefined {
  if (!cardName) return undefined;
  return useCardStore.getState().scryfallDataMap.get(cardName)?.imageUri;
}
