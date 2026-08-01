export interface PickSeatResult {
  seat: number;
  round: number;
  isDoublePick: boolean;
}

export interface DerivePickSeatOptions {
  numSeats: number;
  picksPerPlayer: number;
  /**
   * Last single-pick round; double-pick rounds start after it. Sheet drafts
   * declare this in the sheet ("Double Picks After:") and it is stored on the
   * draft. When null/undefined (live drafts), the floor(N/4) heuristic applies.
   */
  doublePickAfterRound?: number | null;
}

// The last quarter of rounds use double-picks (each player picks twice per round).
// Given N rounds total, floor(N/4) rounds are double-pick rounds at the end.
const DOUBLE_PICK_FINAL_FRACTION = 4;

export function derivePickSeat(
  pickNumber: number,
  opts: DerivePickSeatOptions,
): PickSeatResult {
  const { numSeats, picksPerPlayer, doublePickAfterRound } = opts;
  const singlePickRounds = doublePickAfterRound ??
    picksPerPlayer - 2 * Math.floor(picksPerPlayer / DOUBLE_PICK_FINAL_FRACTION);
  const doublePickRounds = Math.floor((picksPerPlayer - singlePickRounds) / 2);
  // When the double region doesn't divide evenly (e.g. 45 picks with doubles
  // after 20), the draft ends with one final single-pick round.
  const trailingSingleRounds = picksPerPlayer - singlePickRounds - 2 * doublePickRounds;
  const singlePickTotal = singlePickRounds * numSeats;
  const doublePickTotal = doublePickRounds * numSeats * 2;
  const trailingSingleTotal = trailingSingleRounds * numSeats;
  const picksPerDoubleRound = numSeats * 2;

  let round: number;
  let posInRound: number;
  let isDoublePick: boolean;

  if (pickNumber <= singlePickTotal) {
    // Single-pick region
    round = Math.ceil(pickNumber / numSeats);
    posInRound = (pickNumber - 1) % numSeats;
    isDoublePick = false;
  } else if (pickNumber <= singlePickTotal + doublePickTotal) {
    // Double-pick region
    const doublePickIndex = pickNumber - singlePickTotal - 1;
    const doubleRound = Math.floor(doublePickIndex / picksPerDoubleRound);
    const posInDoubleRound = doublePickIndex % picksPerDoubleRound;
    round = singlePickRounds + 1 + doubleRound;
    posInRound = Math.floor(posInDoubleRound / 2);
    isDoublePick = true;
  } else if (pickNumber <= singlePickTotal + doublePickTotal + trailingSingleTotal) {
    // Trailing single-pick round after the double region
    round = singlePickRounds + doublePickRounds + 1;
    posInRound = (pickNumber - singlePickTotal - doublePickTotal - 1) % numSeats;
    isDoublePick = false;
  } else {
    throw new Error(`Pick number ${pickNumber} exceeds total picks`);
  }

  const isForward = round % 2 === 1;
  const seat = isForward ? posInRound + 1 : numSeats - posInRound;

  return { seat, round, isDoublePick };
}

export function getTotalPicks(
  numSeats: number,
  picksPerPlayer: number,
): number {
  return numSeats * picksPerPlayer;
}

/**
 * Derive the next pick number and seat for a draft.
 * Returns null if all picks are made.
 */
export function getNextPick(
  currentPickCount: number,
  numSeats: number,
  picksPerPlayer: number,
  doublePickAfterRound?: number | null,
): { pickNumber: number; seat: number } | null {
  const total = getTotalPicks(numSeats, picksPerPlayer);
  if (currentPickCount >= total) return null;
  const pickNumber = currentPickCount + 1;
  const { seat } = derivePickSeat(pickNumber, { numSeats, picksPerPlayer, doublePickAfterRound });
  return { pickNumber, seat };
}

/**
 * How many picks pass before the given seat is next on the clock, defined as
 * nextPickN − currentPickN where nextPickN is the first pick after
 * currentPickN belonging to the seat. Example: seat 1 picking at pick 1 with
 * 10 seats next acts at pick 20, so this returns 19. During a double pick the
 * seat's own second pick counts: the same call at pick 17 of a double round
 * returns 1. Returns null when the seat never picks again.
 */
export function picksUntilNextTurn(
  currentPickN: number,
  seat: number,
  opts: DerivePickSeatOptions,
): number | null {
  const total = getTotalPicks(opts.numSeats, opts.picksPerPlayer);
  for (let pickN = currentPickN + 1; pickN <= total; pickN++) {
    if (derivePickSeat(pickN, opts).seat === seat) {
      return pickN - currentPickN;
    }
  }
  return null;
}

/**
 * Build the full pick matrix: for each round, the ordered list of seats.
 * Used by the draft board to render the grid.
 */
export function buildPickMatrix(
  numSeats: number,
  picksPerPlayer: number,
  doublePickAfterRound?: number | null,
): { round: number; isForward: boolean; isDoublePick: boolean; seats: number[] }[] {
  const total = getTotalPicks(numSeats, picksPerPlayer);
  const rounds: Map<number, { isForward: boolean; isDoublePick: boolean; seats: number[] }> = new Map();

  for (let p = 1; p <= total; p++) {
    const { seat, round, isDoublePick } = derivePickSeat(p, { numSeats, picksPerPlayer, doublePickAfterRound });
    if (!rounds.has(round)) {
      rounds.set(round, {
        isForward: round % 2 === 1,
        isDoublePick,
        seats: [],
      });
    }
    rounds.get(round)!.seats.push(seat);
  }

  return Array.from(rounds.entries())
    .sort(([a], [b]) => a - b)
    .map(([round, data]) => ({ round, ...data }));
}
