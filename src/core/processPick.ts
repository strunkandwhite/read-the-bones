import type { Client } from '@libsql/client';
import { getNextPick, getTotalPicks } from './snakeDraft';
import { removeCardFromAllQueues, trimExcessQueueEntries, getAutoPickCandidate, fulfillGroupEntry } from './db/queries/pickQueue';
import { addFloatedCard, removeFloatedCardByCardId } from './db/queries/floatedCards';
import { getAllSeatSettings, updateAutoPick } from './db/queries/seatTokens';
import { getDraftMeta } from './db/queries/drafts';
import { NotFoundError, ValidationError, ConflictError } from './errors';

export interface ProcessPickResult {
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  phaseChanged: boolean;
  newPhase: string | null;
}

export interface ProcessPickInput {
  draftId: string;
  seat: number;
  cardId: number;
  cardName: string;
}

/**
 * The result of an on-demand auto-pick triggered via the `{ auto: true }`
 * endpoint path.
 */
export interface AutoPickOnDemandResult {
  /** The card that was picked, or null when the queue yielded nothing. */
  pickedCard: { pickN: number; cardId: number; cardName: string } | null;
  /** Every pick this call produced, including cascaded picks for later seats. */
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  /**
   * True when pause-mode exhaustion caused the seat's auto-pick to be
   * disabled server-side. The client should reflect this state change.
   */
  autoPickDisabled: boolean;
  phaseChanged: boolean;
  newPhase: string | null;
}

/** The picks produced by one insert-plus-cascade run, and any phase change it caused. */
export interface CascadeOutcome {
  picks: { pickN: number; seat: number; cardId: number; cardName: string }[];
  phaseChanged: boolean;
  newPhase: string | null;
}

// ============================================================================
// Internal helpers
// ============================================================================

interface CopyInfo {
  pickedCount: number;
  qty: number;
}

/**
 * Query how many copies of a card have been picked in this draft and how many
 * the cube contains. Throws a ValidationError if the card is not in this
 * draft's cube at all (zero rows), preventing off-cube cards from being
 * inserted.
 */
async function getRemainingCopiesForPick(
  client: Client,
  draftId: string,
  cardId: number,
  cardName: string,
): Promise<CopyInfo> {
  const result = await client.execute({
    sql: `SELECT COUNT(pe.pick_n) as picked_count, csc.qty
          FROM cube_snapshot_cards csc
          JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
          LEFT JOIN pick_events pe ON pe.card_id = csc.card_id AND pe.draft_id = d.draft_id
          WHERE d.draft_id = ? AND csc.card_id = ?
          GROUP BY csc.card_id, csc.qty`,
    args: [draftId, cardId],
  });
  if (result.rows.length === 0) {
    throw new ValidationError(`${cardName} is not in this draft's cube`);
  }
  return {
    pickedCount: result.rows[0].picked_count as number,
    qty: result.rows[0].qty as number,
  };
}

/**
 * Insert a single pick event using an optimistic-concurrency guard: the INSERT
 * is conditional on pick_n not yet existing. Returns rowsAffected.
 */
async function insertPickEvent(
  client: Client,
  draftId: string,
  pickN: number,
  seat: number,
  cardId: number,
): Promise<number> {
  const result = await client.execute({
    sql: `INSERT INTO pick_events (draft_id, pick_n, seat, card_id)
          SELECT ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM pick_events WHERE draft_id = ? AND pick_n = ?
          )`,
    args: [draftId, pickN, seat, cardId, draftId, pickN],
  });
  return result.rowsAffected;
}

type AutoPickAdvance =
  | { kind: 'candidate'; seat: number; cardId: number; cardName: string }
  | { kind: 'none' };

type SeatCandidateResult =
  | { kind: 'candidate'; cardId: number; cardName: string }
  | { kind: 'paused' }
  | { kind: 'none' };

/**
 * Single source of truth for auto-pick candidate selection for a given seat.
 *
 * Runs the queue-traversal semantics (try entries in order, within each entry
 * try each card, pause-mode stops on exhaustion, flow-through continues, group
 * entries are fulfilled and non-picked members are demoted to float).  When
 * the queue is exhausted in pause mode, auto-pick is disabled for the seat and
 * `{ kind: 'paused' }` is returned so the caller can surface the state change.
 *
 * Called by both:
 *  - `advanceAutoPick` (cascade path — fires after a preceding pick lands)
 *  - `triggerAutoPickOnDemand` (on-demand path — fires when a player's turn
 *    arrives while they are idle, e.g. draft start or re-enabling auto-pick)
 *
 * Because both callers share this function, queue-traversal semantics are
 * implemented exactly once.
 */
async function selectAutoPickCandidateForSeat(
  client: Client,
  draftId: string,
  seat: number,
  seatSettings: { autoPick: boolean; displayName: string | null },
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
): Promise<SeatCandidateResult> {
  // Collect available card_ids (quantity-aware)
  const available = await client.execute({
    sql: `SELECT csc.card_id
          FROM cube_snapshot_cards csc
          JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
          LEFT JOIN (
            SELECT card_id, COUNT(*) as cnt
            FROM pick_events WHERE draft_id = ?
            GROUP BY card_id
          ) pe ON csc.card_id = pe.card_id
          WHERE d.draft_id = ?
          AND COALESCE(pe.cnt, 0) < csc.qty`,
    args: [draftId, draftId],
  });
  const availableSet = new Set(available.rows.map((r) => r.card_id as number));

  const autoPickResult = await getAutoPickCandidate(client, draftId, seat, availableSet);

  if (autoPickResult.kind !== 'candidate') {
    if (autoPickResult.kind === 'paused') {
      await updateAutoPick(client, draftId, seat, false);
      allSeatSettings.set(seat, { ...seatSettings, autoPick: false });
      return { kind: 'paused' };
    }
    return { kind: 'none' };
  }

  // Fulfill the group entry and demote non-picked members to float
  const fulfilledEntry = await fulfillGroupEntry(
    client, draftId, seat, autoPickResult.entryIndex,
  );
  const candidate = autoPickResult.cardId;
  const nonPicked = fulfilledEntry.cards.filter((c) => c.id !== candidate);
  await Promise.all(nonPicked.map((c) => addFloatedCard(client, draftId, seat, c.name)));

  // Resolve the card name from the DB
  const cardRow = await client.execute({
    sql: `SELECT name FROM cards WHERE card_id = ?`,
    args: [candidate],
  });
  if (cardRow.rows.length === 0) return { kind: 'none' };

  return {
    kind: 'candidate',
    cardId: candidate,
    cardName: cardRow.rows[0].name as string,
  };
}

/**
 * Determine whether the next seat should auto-pick, and if so which card.
 * Delegates candidate selection to `selectAutoPickCandidateForSeat` — the
 * single implementation of queue-traversal semantics.
 *
 * Returns `{ kind: 'candidate', seat, cardId, cardName }` when a cascade pick
 * should proceed, or `{ kind: 'none' }` when the cascade should stop.
 */
async function advanceAutoPick(
  client: Client,
  draftId: string,
  totalPicksSoFar: number,
  numSeats: number,
  picksPerPlayer: number,
  doublePickAfterRound: number | null,
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
): Promise<AutoPickAdvance> {
  const nextAfter = getNextPick(totalPicksSoFar, numSeats, picksPerPlayer, doublePickAfterRound);
  if (!nextAfter) return { kind: 'none' };

  const nextSettings = allSeatSettings.get(nextAfter.seat);
  if (!nextSettings?.autoPick) return { kind: 'none' };

  const result = await selectAutoPickCandidateForSeat(
    client, draftId, nextAfter.seat, nextSettings, allSeatSettings,
  );

  if (result.kind === 'candidate') {
    return { kind: 'candidate', seat: nextAfter.seat, cardId: result.cardId, cardName: result.cardName };
  }
  return { kind: 'none' };
}

// ============================================================================
// On-demand auto-pick entry point (called by the endpoint when body.auto=true)
// ============================================================================

/**
 * Server-side on-demand auto-pick: validates it is the seat's turn, runs the
 * SAME candidate selection the cascade uses (`selectAutoPickCandidateForSeat`),
 * inserts the pick, and returns the result.
 *
 * The caller (POST /api/drafts/[id]/pick with `{ auto: true }`) must have
 * already authenticated the seat token — this function trusts `seat`.
 *
 * Double-fire safety: the INSERT uses the same optimistic-concurrency guard
 * (`pick_n NOT EXISTS`) as the cascade path.  If the cascade already fired for
 * the same pick_n (e.g. a preceding pick landed between poll and trigger), the
 * INSERT returns rowsAffected=0 and a ConflictError is thrown, which the client
 * handles as a "retry after refresh".
 */
export async function triggerAutoPickOnDemand(
  client: Client,
  draftId: string,
  seat: number,
): Promise<AutoPickOnDemandResult> {
  // 1. Load draft metadata
  const meta = await getDraftMeta(client, draftId);
  if (!meta) throw new NotFoundError('Draft not found');
  const { phase, numSeats, picksPerPlayer, doublePickAfterRound } = meta;

  if (phase !== 'drafting') {
    throw new ValidationError(`Draft is in '${phase}' phase, not 'drafting'`);
  }

  // 2. Verify it is this seat's turn
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
  const next = getNextPick(currentCount, numSeats, picksPerPlayer, doublePickAfterRound);
  if (!next) throw new ValidationError('All picks are made');
  if (next.seat !== seat) {
    throw new ValidationError(`It's seat ${next.seat}'s turn, not seat ${seat}'s`);
  }

  // 3. Run candidate selection (shared implementation)
  const allSeatSettings = await getAllSeatSettings(client, draftId);
  const seatSettings = allSeatSettings.get(seat) ?? { autoPick: true, displayName: null };

  // The seat's auto-pick toggle gates this path exactly as it gates the cascade
  // (see advanceAutoPick). A client can hold a stale "auto-pick on" view of its
  // own seat, so trusting the request alone would let it pick while the seat has
  // auto-pick disabled server-side. Reporting autoPickDisabled corrects the client.
  if (!seatSettings.autoPick) {
    return { pickedCard: null, picks: [], autoPickDisabled: true, phaseChanged: false, newPhase: null };
  }

  const candidateResult = await selectAutoPickCandidateForSeat(
    client, draftId, seat, seatSettings, allSeatSettings,
  );

  if (candidateResult.kind === 'paused') {
    // Pause-mode exhaustion: auto-pick already disabled in selectAutoPickCandidateForSeat
    return { pickedCard: null, picks: [], autoPickDisabled: true, phaseChanged: false, newPhase: null };
  }
  if (candidateResult.kind === 'none') {
    // Queue empty (flow-through exhausted or no entries)
    return { pickedCard: null, picks: [], autoPickDisabled: false, phaseChanged: false, newPhase: null };
  }

  const { cardId, cardName } = candidateResult;

  const outcome = await insertPickAndCascade(
    client,
    draftId,
    { seat, cardId, cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );

  const first = outcome.picks[0];
  return {
    pickedCard: first ? { pickN: first.pickN, cardId: first.cardId, cardName: first.cardName } : null,
    picks: outcome.picks,
    autoPickDisabled: false,
    phaseChanged: outcome.phaseChanged,
    newPhase: outcome.newPhase,
  };
}

/**
 * Insert a pick and then cascade forward: after each pick lands, ask whether the
 * next seat on the clock has auto-pick enabled with an available queued card, and
 * if so pick for them too. Continues until a seat has no valid auto-pick.
 *
 * This is the single implementation of chain continuation. Both entry points use
 * it — a manual pick and an on-demand auto-pick differ only in how the FIRST card
 * is chosen, never in what happens afterward.
 *
 * The caller is responsible for all validation (phase, turn, availability, bans)
 * before calling. Copy counts are re-queried after every insert, including the
 * first, so the caller does not need to pass its own availability check in.
 */
async function insertPickAndCascade(
  client: Client,
  draftId: string,
  firstPick: { seat: number; cardId: number; cardName: string },
  currentCount: number,
  meta: { numSeats: number; picksPerPlayer: number; doublePickAfterRound: number | null },
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
): Promise<CascadeOutcome> {
  const { numSeats, picksPerPlayer, doublePickAfterRound } = meta;
  const picks: CascadeOutcome['picks'] = [];
  const maxCascade = numSeats * 2;

  let currentSeat = firstPick.seat;
  let currentCardId = firstPick.cardId;
  let currentCardName = firstPick.cardName;
  let cascadeDepth = 0;

  while (cascadeDepth < maxCascade) {
    const pickN = currentCount + picks.length + 1;

    const rowsAffected = await insertPickEvent(
      client, draftId, pickN, currentSeat, currentCardId,
    );
    if (rowsAffected === 0) {
      throw new ConflictError('Conflict: pick_n already exists — retry');
    }

    picks.push({ pickN, seat: currentSeat, cardId: currentCardId, cardName: currentCardName });

    // Re-query after the insert, so pickedCount already includes the pick just made.
    const copyInfo = await getRemainingCopiesForPick(
      client, draftId, currentCardId, currentCardName,
    );
    const isLastCopy = copyInfo.pickedCount >= copyInfo.qty;
    const remainingAfterPick = copyInfo.qty - copyInfo.pickedCount;

    if (isLastCopy) {
      const { pauseSeats } = await removeCardFromAllQueues(client, draftId, currentCardId);
      await Promise.all(
        pauseSeats
          .filter((s) => s !== currentSeat)
          .map(async (s) => {
            await updateAutoPick(client, draftId, s, false);
            const prev = allSeatSettings.get(s);
            if (prev) allSeatSettings.set(s, { ...prev, autoPick: false });
          })
      );
      await removeFloatedCardByCardId(client, draftId, currentCardId);
    } else {
      await trimExcessQueueEntries(client, draftId, currentCardId, remainingAfterPick);
    }

    const totalAfter = currentCount + picks.length;
    const totalExpected = getTotalPicks(numSeats, picksPerPlayer);
    if (totalAfter >= totalExpected) {
      await client.execute({
        sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
        args: [draftId],
      });
      await client.execute({
        sql: `UPDATE seat_tokens SET queue_json = '[]' WHERE draft_id = ?`,
        args: [draftId],
      });
      return { picks, phaseChanged: true, newPhase: 'playing' };
    }

    const advance = await advanceAutoPick(
      client, draftId, totalAfter, numSeats, picksPerPlayer, doublePickAfterRound, allSeatSettings,
    );
    if (advance.kind !== 'candidate') break;

    currentSeat = advance.seat;
    currentCardId = advance.cardId;
    currentCardName = advance.cardName;
    cascadeDepth++;
  }

  return { picks, phaseChanged: false, newPhase: null };
}

/**
 * Re-evaluate auto-pick for whichever seat is currently on the clock, and cascade
 * from there.
 *
 * The cascade only ever runs as a side effect of a pick landing, and the client
 * trigger only runs in an open browser. That leaves a gap: a draft moving into
 * `drafting` re-arms on a seat nobody is watching, and because rotisserie order is
 * strict, no other seat can pick to restart the chain. Called on every transition
 * into `drafting` so a resumed draft does not sit dead on an absent player.
 *
 * Safe to call at any time — returns an empty outcome when there is nothing to do.
 */
export async function resumeAutoPickForCurrentSeat(
  client: Client,
  draftId: string,
): Promise<CascadeOutcome> {
  const empty: CascadeOutcome = { picks: [], phaseChanged: false, newPhase: null };

  const meta = await getDraftMeta(client, draftId);
  if (!meta) return empty;
  const { phase, numSeats, picksPerPlayer, doublePickAfterRound } = meta;
  if (phase !== 'drafting') return empty;

  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;

  const next = getNextPick(currentCount, numSeats, picksPerPlayer, doublePickAfterRound);
  if (!next) return empty;

  const allSeatSettings = await getAllSeatSettings(client, draftId);
  const seatSettings = allSeatSettings.get(next.seat);
  if (!seatSettings?.autoPick) return empty;

  const candidateResult = await selectAutoPickCandidateForSeat(
    client, draftId, next.seat, seatSettings, allSeatSettings,
  );
  if (candidateResult.kind !== 'candidate') return empty;

  return insertPickAndCascade(
    client,
    draftId,
    { seat: next.seat, cardId: candidateResult.cardId, cardName: candidateResult.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );
}

// ============================================================================
// Main entry point
// ============================================================================

export async function processPick(
  client: Client,
  input: ProcessPickInput,
): Promise<ProcessPickResult> {
  // 1. Load draft metadata
  const meta = await getDraftMeta(client, input.draftId);
  if (!meta) throw new NotFoundError('Draft not found');
  const { phase, numSeats, picksPerPlayer, bannedCards, doublePickAfterRound } = meta;

  if (phase !== 'drafting') {
    throw new ValidationError(`Draft is in '${phase}' phase, not 'drafting'`);
  }

  // 2. Derive whose turn it is
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [input.draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
  const next = getNextPick(currentCount, numSeats, picksPerPlayer, doublePickAfterRound);
  if (!next) throw new ValidationError('All picks are made');
  if (next.seat !== input.seat) {
    throw new ValidationError(`It's seat ${next.seat}'s turn, not seat ${input.seat}'s`);
  }

  // 3. Validate card is available and not banned
  if (bannedCards.has(input.cardName.toLowerCase())) {
    throw new ValidationError(`${input.cardName} is banned`);
  }
  const availCheck = await getRemainingCopiesForPick(
    client, input.draftId, input.cardId, input.cardName,
  );
  if (availCheck.pickedCount >= availCheck.qty) {
    throw new ValidationError(`${input.cardName} has already been picked`);
  }

  // 4. Insert with optimistic concurrency + cascade
  const allSeatSettings = await getAllSeatSettings(client, input.draftId);

  return insertPickAndCascade(
    client,
    input.draftId,
    { seat: input.seat, cardId: input.cardId, cardName: input.cardName },
    currentCount,
    { numSeats, picksPerPlayer, doublePickAfterRound },
    allSeatSettings,
  );
}
