/**
 * Scoring shared by the decklist matcher and the integrity checker.
 *
 * Both answer the same question — does this list belong to this seat? — and
 * must answer it the same way. If the two drift apart, the checker certifies
 * data the matcher would have rejected.
 */

/**
 * A list must cover at least this fraction of the seat's picks.
 * Well below 1.0 because not every pick is placed: sealeddeck's `hidden` zone
 * legitimately holds unplaced pool cards, so `stored < picks` is normal.
 */
export const SEAT_MATCH_RECALL_THRESHOLD = 0.5;

/**
 * At least this fraction of the list's cards must be cards the seat picked.
 *
 * This is the rotisserie invariant made executable: every card belongs to
 * exactly one player, so a correctly assigned list scores ~1.0. Measured
 * across 193 stored decks, 190 scored >= 0.95 and every mis-assignment
 * scored 0.
 */
export const SEAT_MATCH_PRECISION_THRESHOLD = 0.9;

export interface SeatScore {
  /** Cards present in both the list and the seat's picks. */
  overlap: number;
  /** Fraction of the seat's picks the list covers. Low when picks went unplaced. */
  recall: number;
  /** Fraction of the list the seat actually picked. Low means it is the wrong seat. */
  precision: number;
}

/** Score one decklist's stored cards against one seat's picks. */
export function scoreAgainstSeat(storedCards: Set<string>, picks: Set<string>): SeatScore {
  let overlap = 0;
  for (const card of storedCards) {
    if (picks.has(card)) overlap++;
  }

  return {
    overlap,
    recall: picks.size > 0 ? overlap / picks.size : 0,
    precision: storedCards.size > 0 ? overlap / storedCards.size : 0,
  };
}

/** A seat can receive a decklist only if it clears both thresholds. */
export function isEligibleSeat(score: SeatScore): boolean {
  return (
    score.precision >= SEAT_MATCH_PRECISION_THRESHOLD && score.recall >= SEAT_MATCH_RECALL_THRESHOLD
  );
}

/** Render a 0-1 fraction as a percentage for log output. */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
