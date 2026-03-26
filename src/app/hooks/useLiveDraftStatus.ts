import { useState, useEffect, useRef, useCallback } from "react";

const DRAFTING_POLL_MS = 3_000;
const PLAYING_POLL_MS = 15_000;

export interface LiveDraftStatus {
  phase: string;
  latestPickN: number;
  nextSeat: number | null;
  recentPicks: { pickN: number; seat: number; cardName: string }[];
  seatNames: Record<string, string>;
  numSeats: number;
  picksPerPlayer: number;
  matchCount: number;
  totalMatches: number;
}

interface UseLiveDraftStatusReturn {
  status: LiveDraftStatus | null;
  dataChanged: number;
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useLiveDraftStatus(
  draftId: string | null,
  enabled: boolean,
): UseLiveDraftStatusReturn {
  const [status, setStatus] = useState<LiveDraftStatus | null>(null);
  const [dataChanged, setDataChanged] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const prevPickNRef = useRef<number>(0);

  const fetchStatus = useCallback(async () => {
    if (!draftId) return;
    try {
      const res = await fetch(`/api/drafts/${draftId}/status`);
      if (!res.ok) return;
      const data = await res.json();
      setStatus(data);
      if (data.latestPickN > prevPickNRef.current) {
        prevPickNRef.current = data.latestPickN;
        setDataChanged((prev) => prev + 1);
      }
    } catch { /* ignore transient errors during polling */ }
  }, [draftId]);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external system (API polling) */
  useEffect(() => {
    if (!enabled || !draftId) return;
    setIsLoading(true);
    fetchStatus().then(() => setIsLoading(false));
    const phase = status?.phase;
    const interval = phase === "playing" ? PLAYING_POLL_MS : DRAFTING_POLL_MS;
    const id = setInterval(fetchStatus, interval);
    return () => clearInterval(id);
  }, [enabled, draftId, fetchStatus, status?.phase]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { status, dataChanged, isLoading, refresh: fetchStatus };
}

export interface BoardData {
  picks: { pickN: number; seat: number; cardName: string; oracleId: string; colorIdentity: string[]; manaCost: string }[];
  numSeats: number;
  picksPerPlayer: number;
  phase: string;
  seatNames: Record<string, string>;
  bannedCards: string[];
}

export function useDraftBoard(
  draftId: string | null,
  dataChanged: number,
): { board: BoardData | null; isLoading: boolean; refresh: () => void } {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastSeenRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!draftId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/drafts/${draftId}/board`);
      if (res.ok) setBoard(await res.json());
    } catch { /* ignore */ }
    setIsLoading(false);
  }, [draftId]);

  /* eslint-disable react-hooks/set-state-in-effect -- syncing from external system (API fetch) */
  useEffect(() => { if (draftId) refresh(); }, [draftId, refresh]);

  useEffect(() => {
    if (dataChanged > lastSeenRef.current) {
      lastSeenRef.current = dataChanged;
      refresh();
    }
  }, [dataChanged, refresh]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return { board, isLoading, refresh };
}
