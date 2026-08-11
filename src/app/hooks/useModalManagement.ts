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

  // Wrap setDeckBuilderModalOpen so closing the modal also deactivates the deck builder.
  // deckBuilderActive gates syncDeckWithPicks (the poll-driven rebuild loop); leaving
  // it true after modal close causes unnecessary poll→rebuild→dirty→PUT churn.
  const setDeckBuilderModalOpenWithLifecycle = (open: boolean) => {
    setDeckBuilderModalOpen(open);
    if (!open) {
      setDeckBuilderActive(false);
    }
  };

  // Restore deck builder open state from localStorage after store hydration populates
  // activeDraft/selectedSeat. The mount-only [] effect ran before hydration, so the
  // guard on activeDraft/selectedSeat was always false. Instead we depend on those
  // values and use a once-guard ref so the restore fires at most once — on the first
  // render where both are non-null — and never re-opens after the user closes it.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!activeDraft || selectedSeat === null) return;
    restoredRef.current = true;
    const stored = localStorage.getItem("deckBuilderOpen");
    if (stored === "true") {
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true); // eslint-disable-line react-hooks/set-state-in-effect -- restoring state from an external system (localStorage) after hydration
    }
  }, [activeDraft, selectedSeat, setDeckBuilderActive]);

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
  useEffect(() => {
    if (!activeDraft || selectedSeat === null) {
      setDeckBuilderActive(false);
      setDeckBuilderModalOpen(false); // eslint-disable-line react-hooks/set-state-in-effect -- closing modal in response to prop-driven deselection
    }
  }, [activeDraft, selectedSeat, setDeckBuilderActive]);

  // Close modal on Escape key
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && draftBoardOpen) {
        setDraftBoardOpen(false);
      }
      if (e.key === "Escape" && deckBuilderModalOpen) {
        setDeckBuilderModalOpenWithLifecycle(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckBuilderModalOpen, draftBoardOpen]);

  return {
    deckBuilderModalOpen,
    setDeckBuilderModalOpen: setDeckBuilderModalOpenWithLifecycle,
    draftBoardOpen,
    setDraftBoardOpen,
  };
}
