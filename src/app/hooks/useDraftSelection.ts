import { useState, useEffect } from "react";

interface UseDraftSelectionProps {
  completedDraftIds: string[];
}

interface UseDraftSelectionReturn {
  selectedDrafts: Set<string>;
  setSelectedDrafts: (drafts: Set<string>) => void;
  activeDraft: string | null;
  setActiveDraft: (draft: string | null) => void;
  hideTaken: boolean;
  setHideTaken: (hide: boolean) => void;
  selectedSeat: number | null;
  setSelectedSeat: (seat: number | null) => void;
  hydrated: boolean;
}

export function useDraftSelection({
  completedDraftIds,
}: UseDraftSelectionProps): UseDraftSelectionReturn {
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(
    () => new Set(completedDraftIds)
  );

  // Active draft state (persisted to localStorage)
  // Initialize with server-safe defaults, then hydrate from localStorage
  const [activeDraft, setActiveDraftState] = useState<string | null>(null);
  const [hideTaken, setHideTaken] = useState<boolean>(true);
  const [selectedSeat, setSelectedSeatState] = useState<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage after mount (avoids hydration mismatch)
  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external storage */
  useEffect(() => {
    const stored = localStorage.getItem("activeDraft");
    if (stored) setActiveDraftState(stored);
    const storedHideTaken = localStorage.getItem("hideTaken");
    if (storedHideTaken !== null) setHideTaken(storedHideTaken !== "false");
    const storedSeats = localStorage.getItem("selectedSeats");
    if (stored && storedSeats) {
      const seatsMap = JSON.parse(storedSeats) as Record<string, number>;
      if (stored in seatsMap) setSelectedSeatState(seatsMap[stored]);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist to localStorage on change (skip until hydrated)
  useEffect(() => {
    if (!hydrated) return;
    if (activeDraft) {
      localStorage.setItem("activeDraft", activeDraft);
    } else {
      localStorage.removeItem("activeDraft");
    }
  }, [activeDraft, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("hideTaken", String(hideTaken));
  }, [hideTaken, hydrated]);

  // Look up the stored seat for a given draft
  function getStoredSeat(draftId: string | null): number | null {
    if (!draftId) return null;
    const raw = localStorage.getItem("selectedSeats");
    if (!raw) return null;
    const seatsMap = JSON.parse(raw) as Record<string, number>;
    return draftId in seatsMap ? seatsMap[draftId] : null;
  }

  // Wrap setActiveDraft to also update selectedSeat from stored map
  function setActiveDraft(draft: string | null) {
    setActiveDraftState(draft);
    setSelectedSeatState(getStoredSeat(draft));
  }

  // Wrap setSelectedSeat to persist per-draft in localStorage
  function setSelectedSeat(seat: number | null) {
    setSelectedSeatState(seat);
    if (!activeDraft) return;
    const raw = localStorage.getItem("selectedSeats");
    const seatsMap: Record<string, number> = raw ? JSON.parse(raw) : {};
    if (seat === null) {
      delete seatsMap[activeDraft];
    } else {
      seatsMap[activeDraft] = seat;
    }
    localStorage.setItem("selectedSeats", JSON.stringify(seatsMap));
  }

  return {
    selectedDrafts,
    setSelectedDrafts,
    activeDraft,
    setActiveDraft,
    hideTaken,
    setHideTaken,
    selectedSeat,
    setSelectedSeat,
    hydrated,
  };
}
