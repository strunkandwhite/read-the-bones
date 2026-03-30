import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { DeckAction } from "@/core/deckBuilder";
import { useLiveStore } from "@/app/stores/liveStore";

interface UseSharedDeckLoaderProps {
  setActiveDraft: (draftId: string) => void;
  setSelectedSeat: (seat: number) => void;
  dispatch: (action: DeckAction) => void;
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}

export function useSharedDeckLoader({
  setActiveDraft,
  setSelectedSeat,
  dispatch,
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

        // Set draft context to match the shared deck
        setActiveDraft(deckState.draftId);
        setSelectedSeat(deckState.seat);

        // Load the shared deck into the deck builder state via reducer
        dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });

        // Prevent fetchDeckState from overwriting the shared deck snapshot
        useLiveStore.setState({ viewingSharedDeck: true });

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
