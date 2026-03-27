import { useState, useEffect } from "react";

interface UseModalManagementProps {
  activeDraft: string | null;
  selectedSeat: number | null;
}

interface UseModalManagementReturn {
  deckBuilderActive: boolean;
  setDeckBuilderActive: (active: boolean) => void;
  deckBuilderModalOpen: boolean;
  setDeckBuilderModalOpen: (open: boolean) => void;
  draftBoardOpen: boolean;
  setDraftBoardOpen: (open: boolean) => void;
}

export function useModalManagement({
  activeDraft,
  selectedSeat,
}: UseModalManagementProps): UseModalManagementReturn {
  const [deckBuilderActive, setDeckBuilderActive] = useState(false);
  const [deckBuilderModalOpen, setDeckBuilderModalOpen] = useState(false);
  const [draftBoardOpen, setDraftBoardOpen] = useState(false);

  // Restore modal open state from localStorage on mount
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage (localStorage) */
  useEffect(() => {
    const stored = localStorage.getItem("deckBuilderOpen");
    if (stored === "true" && activeDraft && selectedSeat !== null) {
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist modal open state to localStorage
  useEffect(() => {
    localStorage.setItem("deckBuilderOpen", String(deckBuilderModalOpen));
  }, [deckBuilderModalOpen]);

  // Close modal and deactivate deck builder when draft/seat deselected
  /* eslint-disable react-hooks/set-state-in-effect -- resetting derived state when upstream selection changes */
  useEffect(() => {
    if (!activeDraft || selectedSeat === null) {
      setDeckBuilderActive(false);
      setDeckBuilderModalOpen(false);
    }
  }, [activeDraft, selectedSeat]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Close modal on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && draftBoardOpen) {
        setDraftBoardOpen(false);
      }
      if (e.key === "Escape" && deckBuilderModalOpen) {
        setDeckBuilderModalOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [deckBuilderModalOpen, draftBoardOpen]);

  return {
    deckBuilderActive,
    setDeckBuilderActive,
    deckBuilderModalOpen,
    setDeckBuilderModalOpen,
    draftBoardOpen,
    setDraftBoardOpen,
  };
}
