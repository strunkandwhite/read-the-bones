import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import type { DeckState } from "@/core/types";

interface UseSharedDeckLoaderProps {
  setActiveDraft: (draftId: string) => void;
  setSelectedSeat: (seat: number) => void;
  loadSnapshot: (snapshot: DeckState) => void;
  setDeckBuilderActive: (active: boolean) => void;
  setDeckBuilderModalOpen: (open: boolean) => void;
}

export function useSharedDeckLoader({
  setActiveDraft,
  setSelectedSeat,
  loadSnapshot,
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

        // Load the shared deck into the deck builder, pre-empting
        // the localStorage hydration that would otherwise overwrite it
        loadSnapshot(deckState);

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
