/**
 * Local deck mode — deck-builder persistence for synced sheet drafts.
 *
 * Sheet drafts have no seat tokens, so speculative cards ("Add to Deck
 * Builder", the float analog) and the WIP deck arrangement are persisted in
 * localStorage instead of the token-authed API. Keys are scoped by draftId
 * AND seat so prospective decks never leak between seats.
 */
import { useDraftStore } from "../draftStore";
import { migrateDeckState } from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

/** True when the active draft is sheet-synced and a seat is selected. */
export function getLocalDeckMode(): boolean {
  const { board, selectedSeat } = useDraftStore.getState();
  return board?.isSheetDraft === true && selectedSeat !== null;
}

function floatsKey(draftId: string, seat: number): string {
  return `localFloats:${draftId}:${seat}`;
}

function deckStateKey(draftId: string, seat: number): string {
  return `localDeckState:${draftId}:${seat}`;
}

export function loadLocalFloats(draftId: string, seat: number): string[] {
  try {
    const raw = localStorage.getItem(floatsKey(draftId, seat));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

export function saveLocalFloats(draftId: string, seat: number, floats: string[]): void {
  try {
    localStorage.setItem(floatsKey(draftId, seat), JSON.stringify(floats));
  } catch {
    // localStorage unavailable or full — degrade to in-memory only
  }
}

export function loadLocalDeckState(draftId: string, seat: number): DeckState | null {
  try {
    const raw = localStorage.getItem(deckStateKey(draftId, seat));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as DeckState;
    if (typeof candidate.zones !== "object" || candidate.zones === null) return null;
    // Force identity from the storage key so a mis-keyed blob can't leak a
    // different draft/seat identity into the store.
    return migrateDeckState({ ...candidate, draftId, seat });
  } catch {
    return null;
  }
}

export function saveLocalDeckState(state: DeckState): void {
  // The key derives from the state's own identity — never from current
  // selection — so a mid-debounce seat switch can't write to the wrong key.
  if (!state.draftId) return;
  try {
    localStorage.setItem(deckStateKey(state.draftId, state.seat), JSON.stringify(state));
  } catch {
    // localStorage unavailable or full — degrade to in-memory only
  }
}
