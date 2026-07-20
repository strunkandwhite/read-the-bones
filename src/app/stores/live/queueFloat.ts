/**
 * Queue and float action module.
 * Owns: syncQueue, mutateFloat, parseServerQueue, deriveQueuedCardCounts,
 * fetchQueue, addToQueue, removeFromQueue, reorderQueue, setEntryMode,
 * fetchFloatedCards, addFloat, removeFloat.
 */
import { useDraftStore } from "../draftStore";
import type { SetState, GetState, QueueGroupEntry } from "../liveStore";
import { getLocalDeckMode, loadLocalFloats, saveLocalFloats } from "./localDeck";
import { useCardStore } from "../cardStore";

// Re-export types that consumers need (avoids importing from liveStore in modules)
export type { QueueGroupEntry };

// ---------------------------------------------------------------------------
// Internal types matching server format
// ---------------------------------------------------------------------------

interface ServerQueueCard { id: number; name: string; }
interface ServerQueueEntry { mode: "pause" | "flow-through"; cards: ServerQueueCard[]; }

// ---------------------------------------------------------------------------
// parseServerQueue — canonical conversion from server { id, name } to client shape
// ---------------------------------------------------------------------------

export function parseServerQueue(raw: ServerQueueEntry[]): QueueGroupEntry[] {
  return raw.map((e) => ({
    mode: e.mode,
    cards: e.cards.map((c) => ({ cardId: c.id, cardName: c.name })),
  }));
}

// ---------------------------------------------------------------------------
// deriveQueuedCardCounts — Map<cardName, count> from flat queue
// ---------------------------------------------------------------------------

export function deriveQueuedCardCounts(queue: QueueGroupEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of queue) {
    for (const card of entry.cards) {
      counts.set(card.cardName, (counts.get(card.cardName) ?? 0) + 1);
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// syncQueue — PUT the queue to the server with optimistic revert
// ---------------------------------------------------------------------------

export async function syncQueue(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; fetchFloatedCards: () => Promise<void> },
  newQueue: QueueGroupEntry[],
  previousQueue?: QueueGroupEntry[],
  fallbackFloats?: string[],
): Promise<void> {
  const { seatToken } = get();
  const fallbackQueue = previousQueue ?? get().queue;
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft) return;

  set({ queueLoading: true });
  try {
    const body = newQueue.map((entry) => ({
      mode: entry.mode,
      cards: entry.cards.map((c) => c.cardName),
    }));
    const res = await fetch(`/api/drafts/${activeDraft}/queue`, {
      method: "PUT",
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const queue = parseServerQueue(data.queue as ServerQueueEntry[]);
      set({
        queue,
        queuedCardCounts: deriveQueuedCardCounts(queue),
        queueError: null,
      });
      // Refresh floated cards to pick up any server-side auto-float/unfloat side effects
      void getLiveStore().fetchFloatedCards();
    } else {
      set({
        queue: fallbackQueue,
        queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
        queueError: "Failed to sync queue",
      });
      if (fallbackFloats !== undefined) {
        set({ floatedCards: fallbackFloats, floatedCardsSet: new Set(fallbackFloats) });
      }
    }
  } catch {
    set({
      queue: fallbackQueue,
      queuedCardCounts: deriveQueuedCardCounts(fallbackQueue),
      queueError: "Failed to sync queue",
    });
    if (fallbackFloats !== undefined) {
      set({ floatedCards: fallbackFloats, floatedCardsSet: new Set(fallbackFloats) });
    }
  }
  set({ queueLoading: false });
}

// ---------------------------------------------------------------------------
// mutateFloat — shared helper for add/remove float
// ---------------------------------------------------------------------------

export async function mutateFloat(
  set: SetState,
  get: GetState,
  getLiveStore: () => { fetchFloatedCards: () => Promise<void> },
  cardName: string,
  method: "PUT" | "DELETE",
): Promise<void> {
  const { seatToken, floatedCards: previous } = get();
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!activeDraft) return;

  const next =
    method === "PUT"
      ? [...previous, cardName]
      : previous.filter((c) => c !== cardName);

  if (!seatToken) {
    // Local deck mode (sheet drafts): persist floats to localStorage, no API.
    if (!getLocalDeckMode()) return;
    const { selectedSeat } = useDraftStore.getState();
    if (selectedSeat === null) return;
    set({ floatedCards: next, floatedCardsSet: new Set(next) });
    saveLocalFloats(activeDraft, selectedSeat, next);
    return;
  }

  set({ floatedCards: next, floatedCardsSet: new Set(next) });

  try {
    const res = await fetch(`/api/drafts/${activeDraft}/float`, {
      method,
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ card_name: cardName }),
    });
    if (!res.ok) await getLiveStore().fetchFloatedCards();
  } catch {
    await getLiveStore().fetchFloatedCards();
  }
}

// ---------------------------------------------------------------------------
// Action factory functions
// ---------------------------------------------------------------------------

export function makeFetchQueue(set: SetState, get: GetState) {
  return async (): Promise<void> => {
    const { seatToken } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!seatToken || !activeDraft) return;

    set({ queueLoading: true });
    try {
      const res = await fetch(`/api/drafts/${activeDraft}/queue`, {
        headers: { "X-Seat-Token": seatToken },
      });
      if (res.ok) {
        const data = await res.json();
        const queue = parseServerQueue(data.queue as ServerQueueEntry[]);
        const prevQueue = get().queue;
        const queueChanged = JSON.stringify(queue) !== JSON.stringify(prevQueue);
        if (queueChanged) {
          set({
            queue,
            queuedCardCounts: deriveQueuedCardCounts(queue),
            queueError: null,
          });
        } else {
          set({ queueError: null });
        }
      }
    } catch {
      set({ queueError: "Failed to load queue" });
    }
    set({ queueLoading: false });
  };
}

export function makeAddToQueue(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; fetchFloatedCards: () => Promise<void> },
) {
  return (cardName: string): void => {
    const { queue: original, floatedCards } = get();
    const optimisticQueue: QueueGroupEntry[] = [
      ...original,
      { mode: "pause", cards: [{ cardId: 0, cardName }] },
    ];
    set({
      queue: optimisticQueue,
      queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
    });
    if (floatedCards.includes(cardName)) {
      const nextFloats = floatedCards.filter((c) => c !== cardName);
      set({ floatedCards: nextFloats, floatedCardsSet: new Set(nextFloats) });
    }
    void syncQueue(set, get, getLiveStore, optimisticQueue, original, floatedCards);
  };
}

export function makeRemoveFromQueue(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; fetchFloatedCards: () => Promise<void> },
) {
  return (cardName: string): void => {
    const { queue: original, floatedCards } = get();
    let found = false;
    const optimisticQueue: QueueGroupEntry[] = original
      .map((entry) => {
        if (!found) {
          const cardIndex = entry.cards.findIndex((c) => c.cardName === cardName);
          if (cardIndex !== -1) {
            found = true;
            return { ...entry, cards: entry.cards.filter((_, i) => i !== cardIndex) };
          }
        }
        return entry;
      })
      .filter((entry) => entry.cards.length > 0);
    if (!found) return;
    const nextFloats = floatedCards.includes(cardName)
      ? floatedCards
      : [...floatedCards, cardName];
    set({
      queue: optimisticQueue,
      queuedCardCounts: deriveQueuedCardCounts(optimisticQueue),
      floatedCards: nextFloats,
      floatedCardsSet: new Set(nextFloats),
    });
    void syncQueue(set, get, getLiveStore, optimisticQueue, original, floatedCards);
  };
}

export function makeReorderQueue(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; fetchFloatedCards: () => Promise<void> },
) {
  return (entries: QueueGroupEntry[]): void => {
    const { queue: original } = get();
    set({ queue: entries, queuedCardCounts: deriveQueuedCardCounts(entries) });
    void syncQueue(set, get, getLiveStore, entries, original);
  };
}

export function makeSetEntryMode(
  set: SetState,
  get: GetState,
  getLiveStore: () => { getState: GetState; fetchFloatedCards: () => Promise<void> },
) {
  return (entryIndex: number, mode: "pause" | "flow-through"): void => {
    const { queue: original } = get();
    const newQueue = original.map((entry, i) =>
      i === entryIndex ? { ...entry, mode } : entry,
    );
    set({ queue: newQueue, queuedCardCounts: deriveQueuedCardCounts(newQueue) });
    void syncQueue(set, get, getLiveStore, newQueue, original);
  };
}

export function makeFetchFloatedCards(set: SetState, get: GetState) {
  return async (): Promise<void> => {
    const { seatToken } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!activeDraft) return;

    if (!seatToken) {
      // Local deck mode (sheet drafts): floats live in localStorage.
      if (!getLocalDeckMode()) return;
      const { selectedSeat } = useDraftStore.getState();
      if (selectedSeat === null) return;
      const incoming = loadLocalFloats(activeDraft, selectedSeat);
      const prevFloats = get().floatedCards;
      const floatsChanged =
        incoming.length !== prevFloats.length ||
        incoming.some((c, i) => c !== prevFloats[i]);
      if (floatsChanged) {
        set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
      }
      // Stored floats may have been superseded by picks synced while this
      // tab was closed — reconcile immediately after loading.
      get().reconcileLocalFloats();
      return;
    }

    try {
      const res = await fetch(`/api/drafts/${activeDraft}/float`, {
        headers: { "X-Seat-Token": seatToken },
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.cards) {
          const incoming: string[] = data.cards;
          const prevFloats = get().floatedCards;
          const floatsChanged =
            incoming.length !== prevFloats.length ||
            incoming.some((c, i) => c !== prevFloats[i]);
          if (floatsChanged) {
            set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
          }
        }
      }
    } catch {
      // ignore
    }
  };
}

export function makeAddFloat(
  set: SetState,
  get: GetState,
  getLiveStore: () => { fetchFloatedCards: () => Promise<void> },
) {
  return (cardName: string): Promise<void> =>
    mutateFloat(set, get, getLiveStore, cardName, "PUT");
}

export function makeRemoveFloat(
  set: SetState,
  get: GetState,
  getLiveStore: () => { fetchFloatedCards: () => Promise<void> },
) {
  return (cardName: string): Promise<void> =>
    mutateFloat(set, get, getLiveStore, cardName, "DELETE");
}

// ---------------------------------------------------------------------------
// reconcileLocalFloats — drop floats superseded by synced picks (local mode)
// ---------------------------------------------------------------------------

/**
 * Local-mode analog of the server's pick-time float cleanup (processPick →
 * removeFloatedCardByCardId): once a floated card is picked by the viewed seat
 * it is a real pick (the float entry only kept it dimmed), and once every copy
 * is taken by other seats it can never be picked. Both cases remove the float;
 * takenCardNamesSet only contains fully-taken names, so a card with copies
 * still available keeps its float.
 */
export function makeReconcileLocalFloats(set: SetState, get: GetState) {
  return (): void => {
    if (get().viewingSharedDeck) return;
    if (!getLocalDeckMode()) return;
    const { activeDraft, selectedSeat } = useDraftStore.getState();
    if (!activeDraft || selectedSeat === null) return;
    const { seatCardNames, takenCardNamesSet } = useCardStore.getState();
    if (!seatCardNames && !takenCardNamesSet) return;

    const previous = get().floatedCards;
    const next = previous.filter(
      (name) => !seatCardNames?.has(name) && !takenCardNamesSet?.has(name),
    );
    if (next.length === previous.length) return;

    set({ floatedCards: next, floatedCardsSet: new Set(next) });
    saveLocalFloats(activeDraft, selectedSeat, next);
  };
}
