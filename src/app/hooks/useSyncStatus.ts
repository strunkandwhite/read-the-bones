import { useState, useEffect, useRef, useCallback } from "react";
import { track } from "@vercel/analytics/react";

const POLL_INTERVAL_MS = 10_000; // 10 seconds

export type ActiveDraftInfo = { id: string; numSeats: number };

type SyncStatusResponse = {
  lastSyncedAt: string;
  syncInProgress: boolean;
  activeDrafts: ActiveDraftInfo[];
};

type SyncStatus = SyncStatusResponse & {
  /** Trigger a manual sync. Returns when sync completes. */
  triggerSync: () => Promise<void>;
  /** Whether a manual sync is in flight. */
  manualSyncInFlight: boolean;
  /** Whether the last sync timestamp changed since previous poll. */
  dataChanged: boolean;
};

export function useSyncStatus(enabled: boolean, activeDraftId?: string | null): SyncStatus {
  const [status, setStatus] = useState<SyncStatusResponse>({
    lastSyncedAt: "0",
    syncInProgress: false,
    activeDrafts: [],
  });
  const [manualSyncInFlight, setManualSyncInFlight] = useState(false);
  const [dataChanged, setDataChanged] = useState(false);
  const lastSyncedAtRef = useRef("0");
  const pollPausedRef = useRef(false);
  const activeDraftIdRef = useRef(activeDraftId);
  activeDraftIdRef.current = activeDraftId;

  const fetchStatus = useCallback(async () => {
    if (pollPausedRef.current) return;
    try {
      const res = await fetch("/api/sync-status");
      if (!res.ok) return;
      const data: SyncStatusResponse = await res.json();

      const changed =
        data.lastSyncedAt !== lastSyncedAtRef.current &&
        lastSyncedAtRef.current !== "0";
      lastSyncedAtRef.current = data.lastSyncedAt;

      setStatus(data);
      setDataChanged(changed);
    } catch {
      // Silently ignore transient fetch errors during polling
    }
  }, []);

  // Always fetch once on mount (so settings dropdown can discover active drafts)
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Poll on interval only when enabled (i.e., an active draft is selected)
  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, fetchStatus]);

  // Clear dataChanged flag after consumer has had a chance to act on it
  useEffect(() => {
    if (dataChanged) {
      const timeout = setTimeout(() => setDataChanged(false), 100);
      return () => clearTimeout(timeout);
    }
  }, [dataChanged]);

  const triggerSync = useCallback(async () => {
    pollPausedRef.current = true;
    setManualSyncInFlight(true);
    const start = performance.now();
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      let syncCompleted = false;
      if (res.ok) {
        const data = await res.json();
        if (data.lastSyncedAt) {
          lastSyncedAtRef.current = data.lastSyncedAt;
        }
        syncCompleted = data.status === "completed";
      } else {
        track("sync_failed", {
          error: `HTTP ${res.status}`,
          draft: activeDraftIdRef.current ?? "unknown",
        });
      }
      // Refetch status and signal dataChanged only if sync actually completed
      pollPausedRef.current = false;
      await fetchStatus();
      if (syncCompleted) {
        track("sync_completed", {
          duration_ms: Math.round(performance.now() - start),
        });
        setDataChanged(true);
      }
    } catch (err) {
      track("sync_failed", {
        error: String(err).slice(0, 255),
        draft: activeDraftIdRef.current ?? "unknown",
      });
    } finally {
      setManualSyncInFlight(false);
      pollPausedRef.current = false;
    }
  }, [fetchStatus]);

  return {
    ...status,
    triggerSync,
    manualSyncInFlight,
    dataChanged,
  };
}
