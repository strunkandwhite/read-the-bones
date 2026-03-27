import { useState, useCallback, useEffect, useMemo } from "react";
import type { LiveDraftStatus } from "./useLiveDraftStatus";
import { derivePickSeat, getTotalPicks } from "@/core/snakeDraft";

interface UseLiveDraftPickingProps {
  activeDraft: string | null;
  token: string | null;
  mySeat: number | null;
  liveDraftStatus: LiveDraftStatus | null;
  refreshDraftStatus: () => Promise<void>;
  autoPick: boolean;
  queuedCards: Map<string, number> | undefined;
}

interface UseLiveDraftPickingReturn {
  handlePick: (cardName: string) => Promise<void>;
  pickError: string | null;
  setPickError: (error: string | null) => void;
  isMyTurn: boolean;
  consecutivePicks: number;
}

export function useLiveDraftPicking({
  activeDraft,
  token,
  mySeat,
  liveDraftStatus,
  refreshDraftStatus,
  autoPick,
  queuedCards,
}: UseLiveDraftPickingProps): UseLiveDraftPickingReturn {
  const [pickError, setPickError] = useState<string | null>(null);

  const isMyTurn = mySeat !== null && liveDraftStatus?.nextSeat === mySeat;

  const consecutivePicks = useMemo(() => {
    if (!isMyTurn || !liveDraftStatus || mySeat === null) return 0;
    const { latestPickN, numSeats, picksPerPlayer } = liveDraftStatus;
    const totalPicks = getTotalPicks(numSeats, picksPerPlayer);
    let count = 0;
    let pickN = latestPickN + 1;
    while (pickN <= totalPicks) {
      const { seat } = derivePickSeat(pickN, { numSeats, picksPerPlayer });
      if (seat !== mySeat) break;
      count++;
      pickN++;
    }
    return count;
  }, [isMyTurn, liveDraftStatus, mySeat]);

  const handlePick = useCallback(async (cardName: string) => {
    if (!activeDraft || !token) return;
    setPickError(null);
    try {
      const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": token,
        },
        body: JSON.stringify({ card_name: cardName }),
      });
      if (!res.ok) {
        const data = await res.json();
        const errorMsg = data.error || "Pick failed";
        // Suppress "already been picked" errors when auto-pick is on —
        // this is expected when the server cascade already handled the pick
        if (autoPick && errorMsg.includes("already been picked")) {
          refreshDraftStatus();
          return;
        }
        setPickError(errorMsg);
      } else {
        setPickError(null);
        refreshDraftStatus();
      }
    } catch {
      setPickError("Network error — pick may not have been submitted");
    }
  }, [activeDraft, token, refreshDraftStatus, autoPick]);

  // Fire queued pick immediately when auto-pick is on and it becomes the player's turn
  /* eslint-disable react-hooks/set-state-in-effect -- submitting pick to external API; setState (setPickError) is a side effect of the API call, not the goal */
  useEffect(() => {
    if (!isMyTurn || !autoPick) return;
    if (!queuedCards || queuedCards.size === 0) return;
    const sorted = [...queuedCards.entries()].sort((a, b) => a[1] - b[1]);
    const [nextCard] = sorted[0];
    handlePick(nextCard);
  }, [isMyTurn, autoPick, queuedCards, handlePick]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { handlePick, pickError, setPickError, isMyTurn, consecutivePicks };
}
