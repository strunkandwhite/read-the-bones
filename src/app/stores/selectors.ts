import type { CardStatusResult } from "@/core/cardStatus";
import { useDraftStore } from "./draftStore";
import { useCardStore } from "./cardStore";
import { useLiveStore } from "./liveStore";

export function getCardStatus(cardName: string): CardStatusResult {
  const { seatCardNames, takenCardNamesSet } = useCardStore.getState();
  const { mySeat, queuedCards, floatedCardsSet } = useLiveStore.getState();
  const { selectedSeat } = useDraftStore.getState();

  if (seatCardNames?.has(cardName)) return { status: "picked" };

  const isAuthed = mySeat !== null && mySeat === selectedSeat;
  if (isAuthed) {
    const queuePriority = queuedCards.get(cardName);
    if (queuePriority != null) return { status: "queued", queuePosition: queuePriority };
    if (floatedCardsSet.has(cardName)) return { status: "floated" };
  }

  if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}

export function getImageUrl(cardName: string | null): string | undefined {
  if (!cardName) return undefined;
  return useCardStore.getState().scryfallDataMap.get(cardName)?.imageUri;
}
