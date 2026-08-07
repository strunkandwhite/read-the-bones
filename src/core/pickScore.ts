/**
 * The canonical pick score (P#).
 *
 * P# is the weighted geometric mean of the positions a card was taken at,
 * pooled across drafts. Lower is better. Every surface that reports a pick
 * score routes through pickScore() so the weighting conventions cannot drift
 * apart again.
 */

/** One card's record from one draft. */
export interface DraftObservation {
  /** Position each copy was taken at, in copy order. Empty if none were. */
  pickPositions: number[];
  /** Cards in that draft's cube — the stand-in position for an untaken card. */
  poolSize: number;
}

/**
 * Weight of a single observation.
 *
 * Successive copies are halved: the second copy of a card goes later for
 * mechanical reasons rather than because the card is worse, so it says less
 * about how the card is valued. A card nobody took is halved again because it
 * is censored — all it establishes is that the true position was at or beyond
 * the pool size.
 */
function observationWeight(copyIndex: number, wasPicked: boolean): number {
  return Math.pow(0.5, copyIndex) * (wasPicked ? 1 : 0.5);
}

/**
 * Flatten observations into weighted values.
 *
 * A draft in which any copy was taken contributes only its taken copies. A
 * leftover copy of a multi-copy card is not evidence the card went unwanted,
 * only that demand was not that deep.
 */
function weightedValues(
  observations: DraftObservation[],
): { value: number; weight: number }[] {
  const items: { value: number; weight: number }[] = [];

  for (const observation of observations) {
    if (observation.pickPositions.length > 0) {
      observation.pickPositions.forEach((position, copyIndex) => {
        items.push({ value: position, weight: observationWeight(copyIndex, true) });
      });
    } else {
      items.push({ value: observation.poolSize, weight: observationWeight(0, false) });
    }
  }

  return items;
}

/**
 * Weighted geometric mean of pick positions, or 0 when nothing is averageable.
 * Positions at or below 0 are dropped — ln(0) is -Infinity and would poison
 * the whole score.
 */
export function pickScore(observations: DraftObservation[]): number {
  const items = weightedValues(observations).filter((item) => item.value > 0);

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;

  const weightedLogSum = items.reduce(
    (sum, item) => sum + item.weight * Math.log(item.value),
    0,
  );

  return Math.exp(weightedLogSum / totalWeight);
}
