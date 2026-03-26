import { useState, useEffect, useCallback } from "react";

interface UseMySeatReturn {
  mySeat: number | null;
  autoPick: boolean;
  displayName: string | null;
  toggleAutoPick: () => Promise<void>;
}

export function useMySeat(
  draftId: string | null,
  token: string | null,
): UseMySeatReturn {
  const [mySeat, setMySeat] = useState<number | null>(null);
  const [autoPick, setAutoPick] = useState(true);
  const [displayName, setDisplayName] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- fetching from API */
  useEffect(() => {
    if (!draftId || !token) {
      setMySeat(null);
      return;
    }

    let cancelled = false;

    async function fetchSeat() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/me`, {
          headers: { "X-Seat-Token": token! },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (!cancelled) {
          setMySeat(data.seat);
          setAutoPick(data.autoPick);
          setDisplayName(data.displayName);
        }
      } catch {
        // Token invalid or network error — remain as spectator
      }
    }

    fetchSeat();
    return () => { cancelled = true; };
  }, [draftId, token]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggleAutoPick = useCallback(async () => {
    if (!draftId || !token) return;
    const newValue = !autoPick;
    try {
      const res = await fetch(`/api/drafts/${draftId}/seat-settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": token,
        },
        body: JSON.stringify({ auto_pick: newValue }),
      });
      if (res.ok) setAutoPick(newValue);
    } catch { /* ignore */ }
  }, [draftId, token, autoPick]);

  return { mySeat, autoPick, displayName, toggleAutoPick };
}
