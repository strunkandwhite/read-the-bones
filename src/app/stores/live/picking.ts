/**
 * Picking action module: handlePick, setPickError, triggerAutoPick, recomputePicking.
 * All module-scoped mutable flags are encapsulated here.
 */
import { useDraftStore } from "../draftStore";
import type { SetState, GetState } from "../liveStore";

// ---------------------------------------------------------------------------
// Auto-pick guard (module-scoped — encapsulated here, not exposed)
// ---------------------------------------------------------------------------

let autoPickInFlight = false;

/**
 * Client-side auto-pick trigger: checks the trigger condition (my turn +
 * autoPick enabled + not in flight) then delegates ALL queue-traversal and
 * candidate selection to the server via POST /api/drafts/[id]/pick with
 * `{ auto: true }`.  The server runs the same logic as the cascade path so
 * both paths are guaranteed to make identical picks for the same queue state.
 *
 * On conflict (pick_n already taken — cascade fired first): the server returns
 * 409, which we treat as "already handled — just refresh".
 */
async function triggerAutoPick(
  get: GetState,
  setState: (partial: Partial<{ autoPick: boolean }>) => void,
): Promise<void> {
  if (autoPickInFlight) return;
  autoPickInFlight = true;
  try {
    const { seatToken, autoPick } = get();
    if (!autoPick) return;

    const activeDraft = useDraftStore.getState().activeDraft;
    if (!seatToken || !activeDraft) return;

    const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
      method: "POST",
      headers: {
        "X-Seat-Token": seatToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ auto: true }),
    });

    if (res.ok) {
      const data = await res.json() as { autoPickDisabled?: boolean; pickedCard?: unknown };
      if (data.autoPickDisabled) {
        // Server disabled auto-pick due to pause-mode exhaustion — reflect locally
        setState({ autoPick: false });
      }
      await useDraftStore.getState().refreshNow();
    } else if (res.status === 409) {
      // Conflict: cascade already fired for this pick_n — refresh to catch up
      await useDraftStore.getState().refreshNow();
    }
    // Other errors (not my turn, queue empty, etc.) are silent
  } finally {
    autoPickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// makeRecomputePicking — returns a standalone recomputePicking function
// ---------------------------------------------------------------------------

/**
 * Creates a recomputePicking function bound to the store's set/get.
 * The returned function is used for both the store's internal wiring and
 * the module-exported recomputePicking used in tests and subscriptions.
 */
export function makeRecomputePicking(set: SetState, get: GetState): () => void {
  return (): void => {
    const { mySeat, autoPick, queue } = get();
    const { liveDraftStatus } = useDraftStore.getState();

    const isMyTurn = mySeat !== null && liveDraftStatus?.nextSeat === mySeat;
    set({ isMyTurn });

    if (isMyTurn && autoPick && queue.length > 0) {
      void triggerAutoPick(get, set as (partial: Partial<{ autoPick: boolean }>) => void);
    }
  };
}

// ---------------------------------------------------------------------------
// Action factories
// ---------------------------------------------------------------------------

export function makeHandlePick(set: SetState, get: GetState) {
  return async (cardName: string): Promise<void> => {
    const { seatToken, autoPick } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!seatToken || !activeDraft) return;

    try {
      const res = await fetch(`/api/drafts/${activeDraft}/pick`, {
        method: "POST",
        headers: {
          "X-Seat-Token": seatToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ card_name: cardName }),
      });

      if (res.ok) {
        set({ pickError: null });
        const { floatedCards } = get();
        if (floatedCards.includes(cardName)) {
          const updated = floatedCards.filter((c) => c !== cardName);
          set({ floatedCards: updated, floatedCardsSet: new Set(updated) });
        }
        await useDraftStore.getState().refreshNow();
      } else {
        const data = await res.json().catch(() => ({ error: "Pick failed" }));
        const errorMsg = data.error || "Pick failed";

        if (autoPick && errorMsg.includes("already been picked")) {
          set({ pickError: null });
          await useDraftStore.getState().refreshNow();
        } else {
          set({ pickError: errorMsg });
        }
      }
    } catch {
      set({ pickError: "Network error — pick may not have been submitted" });
    }
  };
}

export function makeSetPickError(set: SetState) {
  return (error: string | null): void => {
    set({ pickError: error });
  };
}

// ---------------------------------------------------------------------------
// makeReportMatch — POST match result, then refresh standings
// ---------------------------------------------------------------------------

export interface MatchReportParams {
  opponentSeat: number;
  wins: number;
  losses: number;
}

/**
 * Reports a match result via POST /api/drafts/[id]/match.
 * Token plumbing follows the same pattern as handlePick and queueFloat mutations —
 * reads seatToken from get() and activeDraft from draftStore.
 *
 * Returns an error message string on failure, or null on success.
 */
export function makeReportMatch(get: GetState) {
  return async ({ opponentSeat, wins, losses }: MatchReportParams): Promise<string | null> => {
    const { seatToken } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!seatToken || !activeDraft) return "Not authenticated";

    try {
      const res = await fetch(`/api/drafts/${activeDraft}/match`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Seat-Token": seatToken,
        },
        body: JSON.stringify({
          opponent_seat: opponentSeat,
          wins,
          losses,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Request failed" }));
        return (data.error as string | undefined) ?? `HTTP ${res.status}`;
      }

      // Refresh standings after a successful report
      await useDraftStore.getState().fetchStandings();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "Unknown error";
    }
  };
}
