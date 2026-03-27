import { useState, useEffect, useCallback } from "react";

export function useFloatedCards(draftId: string | null, token: string | null) {
  const [floatedCards, setFloatedCards] = useState<string[]>([]);

  useEffect(() => {
    if (!draftId || !token) return;

    fetch(`/api/drafts/${draftId}/float`, {
      headers: { "X-Seat-Token": token },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.cards) setFloatedCards(data.cards);
      });
  }, [draftId, token]);

  const addFloat = useCallback(
    async (cardName: string) => {
      if (!draftId || !token) return;
      await fetch(`/api/drafts/${draftId}/float`, {
        method: "PUT",
        headers: {
          "X-Seat-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_name: cardName }),
      });
      setFloatedCards((prev) => [...prev, cardName]);
    },
    [draftId, token],
  );

  const removeFloat = useCallback(
    async (cardName: string) => {
      if (!draftId || !token) return;
      await fetch(`/api/drafts/${draftId}/float`, {
        method: "DELETE",
        headers: {
          "X-Seat-Token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_name: cardName }),
      });
      setFloatedCards((prev) => prev.filter((c) => c !== cardName));
    },
    [draftId, token],
  );

  return { floatedCards, addFloat, removeFloat };
}
