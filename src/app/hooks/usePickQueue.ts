import { useState, useEffect, useCallback, useMemo } from "react";

interface QueueEntry {
  priority: number;
  cardId: number;
  cardName: string;
}

interface UsePickQueueReturn {
  queue: QueueEntry[];
  queuedCards: Map<string, number>;
  addToQueue: (cardName: string) => void;
  removeFromQueue: (cardName: string) => void;
  reorderQueue: (cardNames: string[]) => void;
  isLoading: boolean;
}

export function usePickQueue(
  draftId: string | null,
  token: string | null,
  dataChanged: number,
): UsePickQueueReturn {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchQueue = useCallback(async () => {
    if (!draftId || !token) return;
    try {
      const res = await fetch(`/api/drafts/${draftId}/queue`, {
        headers: { "X-Seat-Token": token },
      });
      if (res.ok) {
        const data = await res.json();
        setQueue(data.queue);
      }
    } catch { /* ignore */ }
  }, [draftId, token]);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external system (API fetch) */
  useEffect(() => { fetchQueue(); }, [fetchQueue]);
  useEffect(() => { if (dataChanged) fetchQueue(); }, [dataChanged, fetchQueue]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const syncQueue = useCallback(async (cardNames: string[]) => {
    if (!draftId || !token) return;
    setIsLoading(true);
    try {
      const body = cardNames.map((card_name) => ({ card_name }));
      const res = await fetch(`/api/drafts/${draftId}/queue`, {
        method: "PUT",
        headers: { "X-Seat-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json();
        setQueue(data.queue);
      }
    } catch { /* ignore */ }
    setIsLoading(false);
  }, [draftId, token]);

  const addToQueue = useCallback((cardName: string) => {
    const newNames = [...queue.map((e) => e.cardName), cardName];
    syncQueue(newNames);
  }, [queue, syncQueue]);

  const removeFromQueue = useCallback((cardName: string) => {
    const newNames = queue.filter((e) => e.cardName !== cardName).map((e) => e.cardName);
    syncQueue(newNames);
  }, [queue, syncQueue]);

  const queuedCards = useMemo(
    () => new Map(queue.map((e) => [e.cardName, e.priority])),
    [queue],
  );

  return { queue, queuedCards, addToQueue, removeFromQueue, reorderQueue: syncQueue, isLoading };
}
