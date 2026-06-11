import { useState, useEffect, useRef } from "react";
import { useLiveStore } from "../stores/liveStore";

interface UseModalManagementProps {
  activeDraft: string | null;
  selectedSeat: number | null;
}

interface UseModalManagementReturn {
  deckBuilderModalOpen: boolean;
  setDeckBuilderModalOpen: (open: boolean) => void;
  draftBoardOpen: boolean;
  setDraftBoardOpen: (open: boolean) => void;
}

export function useModalManagement({
  activeDraft,
  selectedSeat,
}: UseModalManagementProps): UseModalManagementReturn {
  const [deckBuilderModalOpen, setDeckBuilderModalOpen] = useState(false);
  const [draftBoardOpen, setDraftBoardOpen] = useState(false);

  const setDeckBuilderActive = useLiveStore((s) => s.setDeckBuilderActive);

  // Restore deck builder open state from localStorage after store hydration populates
  // activeDraft/selectedSeat. The mount-only [] effect ran before hydration, so the
  // guard on activeDraft/selectedSeat was always false. Instead we depend on those
  // values and use a once-guard ref so the restore fires at most once — on the first
  // render where both are non-null — and never re-opens after the user closes it.
  const restoredRef = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage (localStorage) */
  useEffect(() => {
    if (restoredRef.current) return;
    if (!activeDraft || selectedSeat === null) return;
    restoredRef.current = true;
    const stored = localStorage.getItem("deckBuilderOpen");
    if (stored === "true") {
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true);
    }
  }, [activeDraft, selectedSeat, setDeckBuilderActive]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist modal open state to localStorage. Skip the initial render so the
  // stored "true" value isn't overwritten to "false" by the default state before
  // the restore effect above has a chance to read it.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    localStorage.setItem("deckBuilderOpen", String(deckBuilderModalOpen));
  }, [deckBuilderModalOpen]);

  // Close modal and deactivate deck builder when draft/seat deselected
  /* eslint-disable react-hooks/set-state-in-effect -- resetting derived state when upstream selection changes */
  useEffect(() => {
    if (!activeDraft || selectedSeat === null) {
      setDeckBuilderActive(false);
      setDeckBuilderModalOpen(false);
    }
  }, [activeDraft, selectedSeat, setDeckBuilderActive]);
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
    deckBuilderModalOpen,
    setDeckBuilderModalOpen,
    draftBoardOpen,
    setDraftBoardOpen,
  };
}
