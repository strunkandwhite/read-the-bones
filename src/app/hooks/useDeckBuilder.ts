import { useReducer, useEffect, useRef, useCallback } from "react";
import {
  deckReducer,
  createEmptyDeckState,
  migrateDeckState,
  type DeckAction,
} from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

interface UseDeckBuilderProps {
  draftId: string;
  seat: number;
}

function getStorageKey(draftId: string, seat: number): string {
  return `deckState:${draftId}:${seat}`;
}

function loadFromStorage(draftId: string, seat: number): DeckState | null {
  const key = getStorageKey(draftId, seat);
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  try {
    return migrateDeckState(JSON.parse(stored) as DeckState);
  } catch {
    return null;
  }
}

export function useDeckBuilder({ draftId, seat }: UseDeckBuilderProps) {
  const [state, dispatch] = useReducer(
    deckReducer,
    { draftId, seat },
    // Always start empty to avoid SSR/client hydration mismatch
    ({ draftId, seat }) => createEmptyDeckState(draftId, seat),
  );
  const prevKeyRef = useRef(`${draftId}:${seat}`);
  const hydratedRef = useRef(false);

  // Hydrate from localStorage on mount (client-only, after first render)
  useEffect(() => {
    const stored = loadFromStorage(draftId, seat);
    if (stored) {
      dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: stored });
    }
    hydratedRef.current = true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset when draft/seat changes (after initial hydration)
  useEffect(() => {
    const newKey = `${draftId}:${seat}`;
    if (newKey !== prevKeyRef.current) {
      prevKeyRef.current = newKey;
      const stored = loadFromStorage(draftId, seat);
      if (stored) {
        dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: stored });
      } else {
        dispatch({
          type: "INIT_FROM_SNAPSHOT",
          snapshot: createEmptyDeckState(draftId, seat),
        });
      }
    }
  }, [draftId, seat]);

  // Persist to localStorage on state changes (skip until hydrated, skip if no draft)
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (!state.draftId) return;
    const key = getStorageKey(state.draftId, state.seat);
    localStorage.setItem(key, JSON.stringify(state));
  }, [state]);

  // Load a snapshot while pre-empting the draft/seat change effect.
  // Writes to localStorage and updates prevKeyRef so the effect sees
  // the key as unchanged and skips its localStorage reload.
  const loadSnapshot = useCallback((snapshot: DeckState) => {
    const key = getStorageKey(snapshot.draftId, snapshot.seat);
    localStorage.setItem(key, JSON.stringify(snapshot));
    prevKeyRef.current = `${snapshot.draftId}:${snapshot.seat}`;
    dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot });
  }, []);

  return { state, dispatch, loadSnapshot } as const;
}

export type { DeckAction };
