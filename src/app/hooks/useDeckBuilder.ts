import { useReducer, useEffect, useRef, useCallback, useState } from "react";
import {
  deckReducer,
  createEmptyDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

interface UseDeckBuilderProps {
  draftId: string;
  seat: number;
  token: string | null;
}

const DEBOUNCE_MS = 1000;

export function useDeckBuilder({ draftId, seat, token }: UseDeckBuilderProps) {
  const [state, dispatch] = useReducer(
    deckReducer,
    { draftId, seat },
    ({ draftId, seat }) => createEmptyDeckState(draftId, seat),
  );

  const [ready, setReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");

  // Keep a stable ref to the latest state so flushSave doesn't need state in its deps
  const stateRef = useRef<DeckState>(state);
  stateRef.current = state;

  // Keep a stable ref to the latest token so flushSave doesn't need token in its deps
  const tokenRef = useRef<string | null>(token);
  tokenRef.current = token;

  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const prevKeyRef = useRef(`${draftId}:${seat}`);
  // Tracks whether the current state was loaded from the server (not a user edit)
  const justHydratedRef = useRef(false);

  // Stable save function — reads state and token via refs to avoid stale closures
  const flushSave = useCallback(async () => {
    const currentToken = tokenRef.current;
    if (!currentToken || !dirtyRef.current || inFlightRef.current) return;
    inFlightRef.current = true;
    setSaveStatus("saving");
    const snapshot = stateRef.current;
    try {
      const res = await fetch(`/api/drafts/${snapshot.draftId}/deck-state`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": currentToken,
        },
        body: JSON.stringify(snapshot),
      });
      if (res.ok) {
        dirtyRef.current = false;
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus((s) => s === "saved" ? "idle" : s), 2000);
      }
      // On failure, keep dirty — next debounce cycle will retry
    } catch {
      // Network error — keep dirty for retry
    } finally {
      inFlightRef.current = false;
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        flushSave();
      }
    }
  }, []); // stable — reads everything via refs

  // Fetch WIP deck state from server on mount
  useEffect(() => {
    if (!token) return;

    let cancelled = false;
    async function fetchDeckState() {
      try {
        const res = await fetch(`/api/drafts/${draftId}/deck-state`, {
          headers: { "X-Seat-Token": token! },
        });
        if (cancelled) return;
        if (res.ok) {
          const deckState = await res.json();
          justHydratedRef.current = true;
          dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });
        }
        // 404 = no saved WIP, start fresh (empty state is already set)
      } catch (err) {
        if (!cancelled) console.error("Failed to fetch deck state:", err);
      } finally {
        if (!cancelled) {
          setReady(true);
          dirtyRef.current = false;
        }
      }
    }

    setReady(false);
    fetchDeckState();
    return () => { cancelled = true; };
  }, [draftId, seat, token]);

  // Reset when draft/seat changes
  useEffect(() => {
    const newKey = `${draftId}:${seat}`;
    if (newKey !== prevKeyRef.current) {
      prevKeyRef.current = newKey;
      // The fetch effect above will re-run due to dependency change
    }
  }, [draftId, seat]);

  // Mark dirty and schedule save on state changes (skip initial hydration)
  useEffect(() => {
    if (!ready) return;
    // Skip marking dirty if this state change was from server hydration
    if (justHydratedRef.current) {
      justHydratedRef.current = false;
      return;
    }
    dirtyRef.current = true;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    if (inFlightRef.current) {
      pendingSaveRef.current = true;
    } else {
      saveTimerRef.current = setTimeout(flushSave, DEBOUNCE_MS);
    }
  }, [state, ready, flushSave]);

  // Flush on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && tokenRef.current && typeof navigator.sendBeacon === "function") {
        // Best-effort synchronous save via sendBeacon (uses query param for auth
        // because sendBeacon doesn't support custom headers)
        const currentToken = tokenRef.current;
        const url = `/api/drafts/${stateRef.current.draftId}/deck-state?token=${currentToken}`;
        navigator.sendBeacon(url, new Blob(
          [JSON.stringify(stateRef.current)],
          { type: "application/json" },
        ));
      }
    };
  }, []); // stable — reads everything via refs

  return { state, dispatch, ready, saveStatus } as const;
}

export type { DeckAction };
