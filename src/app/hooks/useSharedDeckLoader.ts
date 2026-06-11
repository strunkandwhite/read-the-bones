import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useLiveStore } from "@/app/stores/liveStore";

interface UseSharedDeckLoaderProps {
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}

export function useSharedDeckLoader({
  setDeckBuilderActive,
  setDeckBuilderModalOpen,
}: UseSharedDeckLoaderProps): void {
  const searchParams = useSearchParams();
  const sharedDeckId = searchParams.get("deck");

  useEffect(() => {
    if (!sharedDeckId) return;

    async function loadSharedDeck() {
      try {
        const res = await fetch(`/api/deck/${sharedDeckId}`);
        if (!res.ok) {
          console.error(`Failed to load shared deck ${sharedDeckId}: ${res.status}`);
          return;
        }
        const deckState = await res.json();

        // enterSharedView atomically: sets viewingSharedDeck=true, calls
        // setActiveDraft (which fires the subscription synchronously), and
        // loads the shared snapshot — all before fetchDeckState can overwrite
        // it with the viewer's own WIP deck.
        useLiveStore.getState().enterSharedView(deckState.draftId, deckState.seat, deckState);

        // Activate and open the deck builder modal
        setDeckBuilderActive(true);
        setDeckBuilderModalOpen(true);
      } catch (err) {
        console.error("Failed to load shared deck:", err);
      }
    }

    loadSharedDeck();
  }, [sharedDeckId]); // eslint-disable-line react-hooks/exhaustive-deps
}
