import { useMemo } from "react";
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

  // "picked": in your pool — include remainingCopies so the modal can decide
  // whether to show pick/queue buttons (multi-copy cards may still have copies).
  // Must come before takenCardNamesSet so your own pick always shows the green checkmark.
  if (seatCardNames?.has(cardName)) {
    const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
    const takenCount = takenCardCounts?.get(cardName) ?? 0;
    return { status: "picked", remainingCopies: cubeCopies - takenCount };
  }
  // "taken": all copies exhausted globally — no actions possible
  if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}

/**
 * Reactive hook: returns a memoized Map of card statuses for the given card names.
 * Subscribes to all actual inputs of getCardStatus so the map updates whenever
 * queue, float, or taken state changes — without requiring a parent re-render.
 *
 * Use this at the table level (one subscription for all ~540 rows) rather than
 * calling useCardStatus per-row.
 */
export function useCardStatuses(cardNames: readonly string[]): Map<string, CardStatusResult> {
  // Subscribe to all six inputs that getCardStatus reads
  const queuedCardCounts = useLiveStore((s) => s.queuedCardCounts);
  const floatedCardsSet = useLiveStore((s) => s.floatedCardsSet);
  const queue = useLiveStore((s) => s.queue);
  const seatCardNames = useCardStore((s) => s.seatCardNames);
  const takenCardNamesSet = useCardStore((s) => s.takenCardNamesSet);
  const takenCardCounts = useCardStore((s) => s.takenCardCounts);
  const cardData = useCardStore((s) => s.cardData);
  const mySeat = useLiveStore((s) => s.mySeat);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);
  const isAuthed = mySeat !== null && mySeat === selectedSeat;

  return useMemo(() => {
    const map = new Map<string, CardStatusResult>();
    for (const cardName of cardNames) {
      if (isAuthed) {
        const count = queuedCardCounts.get(cardName);
        if (count != null && count > 0) {
          let entryPosition = Infinity;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i].cards.some((c) => c.cardName === cardName)) {
              entryPosition = i + 1;
              break;
            }
          }
          const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
          const takenCount = takenCardCounts?.get(cardName) ?? 0;
          map.set(cardName, {
            status: "queued",
            queuePosition: entryPosition,
            queuedCount: count,
            remainingCopies: cubeCopies - takenCount,
          });
          continue;
        }
        if (floatedCardsSet.has(cardName)) {
          map.set(cardName, { status: "floated" });
          continue;
        }
      }
      if (seatCardNames?.has(cardName)) {
        const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
        const takenCount = takenCardCounts?.get(cardName) ?? 0;
        map.set(cardName, { status: "picked", remainingCopies: cubeCopies - takenCount });
        continue;
      }
      if (takenCardNamesSet?.has(cardName)) {
        map.set(cardName, { status: "taken" });
        continue;
      }
      map.set(cardName, { status: "none" });
    }
    return map;
  }, [cardNames, isAuthed, queuedCardCounts, floatedCardsSet, queue, seatCardNames, takenCardNamesSet, takenCardCounts, cardData]);
}

/**
 * Reactive hook: returns the status for a single card.
 * Subscribes to the same inputs as getCardStatus.
 * Use in components that display one card at a time (e.g. CardStatsModal).
 */
export function useCardStatus(cardName: string | null): CardStatusResult {
  const queuedCardCounts = useLiveStore((s) => s.queuedCardCounts);
  const floatedCardsSet = useLiveStore((s) => s.floatedCardsSet);
  const queue = useLiveStore((s) => s.queue);
  const seatCardNames = useCardStore((s) => s.seatCardNames);
  const takenCardNamesSet = useCardStore((s) => s.takenCardNamesSet);
  const takenCardCounts = useCardStore((s) => s.takenCardCounts);
  const cardData = useCardStore((s) => s.cardData);
  const mySeat = useLiveStore((s) => s.mySeat);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);
  const isAuthed = mySeat !== null && mySeat === selectedSeat;

  return useMemo((): CardStatusResult => {
    if (!cardName) return { status: "none" };
    if (isAuthed) {
      const count = queuedCardCounts.get(cardName);
      if (count != null && count > 0) {
        let entryPosition = Infinity;
        for (let i = 0; i < queue.length; i++) {
          if (queue[i].cards.some((c) => c.cardName === cardName)) {
            entryPosition = i + 1;
            break;
          }
        }
        const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
        const takenCount = takenCardCounts?.get(cardName) ?? 0;
        return { status: "queued", queuePosition: entryPosition, queuedCount: count, remainingCopies: cubeCopies - takenCount };
      }
      if (floatedCardsSet.has(cardName)) return { status: "floated" };
    }
    if (seatCardNames?.has(cardName)) {
      const cubeCopies = cardData.cubeCopies[cardName] ?? 1;
      const takenCount = takenCardCounts?.get(cardName) ?? 0;
      return { status: "picked", remainingCopies: cubeCopies - takenCount };
    }
    if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
    return { status: "none" };
  }, [cardName, isAuthed, queuedCardCounts, floatedCardsSet, queue, seatCardNames, takenCardNamesSet, takenCardCounts, cardData]);
}

export function getImageUrl(cardName: string | null): string | undefined {
  if (!cardName) return undefined;
  return useCardStore.getState().scryfallDataMap.get(cardName)?.imageUri;
}

/**
 * Canonical "my deck cards" union: picks + speculative (floats + queued),
 * auth-gated, deduplicated.
 *
 * Rules (shared across PageClient mobile filter, syncDeckWithPicks, DeckBuilderPanel):
 * - Picks are authoritative.
 * - Auth-gated: floats and queued cards are included only when authed
 *   (mySeat === selectedSeat).
 * - Speculative cards deduplicate against each other and against picks:
 *   queue first, then floats; a card that is both queued and floated counts once.
 * Returns a Set<string> of card names.
 */
export function getMyDeckCardNames(): Set<string> {
  const { seatCardList } = useCardStore.getState();
  const { floatedCards, queue } = useLiveStore.getState();
  const isAuthed = getIsAuthed();

  const picks = seatCardList ?? [];
  const authFloated = isAuthed ? floatedCards : [];
  const authQueued = isAuthed
    ? queue.flatMap((entry) => entry.cards.map((c) => c.cardName))
    : [];

  const seen = new Set(picks);
  const speculative: string[] = [];
  for (const name of [...authQueued, ...authFloated]) {
    if (!seen.has(name)) {
      seen.add(name);
      speculative.push(name);
    }
  }
  return new Set([...picks, ...speculative]);
}

/**
 * Reactive hook version of getMyDeckCardNames.
 */
export function useMyDeckCardNames(): Set<string> {
  const seatCardList = useCardStore((s) => s.seatCardList);
  const floatedCards = useLiveStore((s) => s.floatedCards);
  const queue = useLiveStore((s) => s.queue);
  const mySeat = useLiveStore((s) => s.mySeat);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);

  return useMemo(() => {
    const isAuthed = mySeat !== null && mySeat === selectedSeat;
    const picks = seatCardList ?? [];
    const authFloated = isAuthed ? floatedCards : [];
    const authQueued = isAuthed
      ? queue.flatMap((entry) => entry.cards.map((c) => c.cardName))
      : [];

    const seen = new Set(picks);
    const speculative: string[] = [];
    for (const name of [...authQueued, ...authFloated]) {
      if (!seen.has(name)) {
        seen.add(name);
        speculative.push(name);
      }
    }
    return new Set([...picks, ...speculative]);
  }, [seatCardList, floatedCards, queue, mySeat, selectedSeat]);
}
