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

/**
 * Determine whether the next seat should auto-pick, and if so which card.
 * Handles pause-mode exhaustion by disabling auto-pick for the seat and
 * demoting non-winning group members to float.
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
  allSeatSettings: Map<number, { autoPick: boolean; displayName: string | null }>,
): Promise<AutoPickAdvance> {
  const nextAfter = getNextPick(totalPicksSoFar, numSeats, picksPerPlayer);
  if (!nextAfter) return { kind: 'none' };

  const nextSettings = allSeatSettings.get(nextAfter.seat);
  if (!nextSettings?.autoPick) return { kind: 'none' };

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

  const autoPickResult = await getAutoPickCandidate(client, draftId, nextAfter.seat, availableSet);

  if (autoPickResult.kind !== 'candidate') {
    if (autoPickResult.kind === 'paused') {
      await updateAutoPick(client, draftId, nextAfter.seat, false);
      allSeatSettings.set(nextAfter.seat, { ...nextSettings, autoPick: false });
    }
    return { kind: 'none' };
  }

  // Fulfill the group entry and demote non-picked members to float
  const fulfilledEntry = await fulfillGroupEntry(
    client, draftId, nextAfter.seat, autoPickResult.entryIndex,
  );
  const candidate = autoPickResult.cardId;
  const nonPicked = fulfilledEntry.cards.filter((c) => c.id !== candidate);
  await Promise.all(nonPicked.map((c) => addFloatedCard(client, draftId, nextAfter.seat, c.name)));

  // Resolve the card name from the DB
  const cardRow = await client.execute({
    sql: `SELECT name FROM cards WHERE card_id = ?`,
    args: [candidate],
  });
  if (cardRow.rows.length === 0) return { kind: 'none' };

  return {
    kind: 'candidate',
    seat: nextAfter.seat,
    cardId: candidate,
    cardName: cardRow.rows[0].name as string,
  };
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
  const { phase, numSeats, picksPerPlayer, bannedCards } = meta;

  if (phase !== 'drafting') {
    throw new ValidationError(`Draft is in '${phase}' phase, not 'drafting'`);
  }

  // 2. Derive whose turn it is
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [input.draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
  const next = getNextPick(currentCount, numSeats, picksPerPlayer);
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
  const picks: ProcessPickResult['picks'] = [];
  const maxCascade = numSeats * 2;
  const allSeatSettings = await getAllSeatSettings(client, input.draftId);

  let currentSeat = input.seat;
  let currentCardId = input.cardId;
  let currentCardName = input.cardName;
  let cascadeDepth = 0;

  while (cascadeDepth < maxCascade) {
    const pickN = currentCount + picks.length + 1;

    const rowsAffected = await insertPickEvent(
      client, input.draftId, pickN, currentSeat, currentCardId,
    );
    if (rowsAffected === 0) {
      throw new ConflictError('Conflict: pick_n already exists — retry');
    }

    picks.push({
      pickN,
      seat: currentSeat,
      cardId: currentCardId,
      cardName: currentCardName,
    });

    // Determine remaining copies after this pick
    let isLastCopy: boolean;
    let remainingAfterPick: number;
    if (cascadeDepth === 0) {
      // Initial pick: reuse the validation query result
      isLastCopy = availCheck.pickedCount + 1 >= availCheck.qty;
      remainingAfterPick = availCheck.qty - (availCheck.pickedCount + 1);
    } else {
      // Cascade pick: re-query the count now. Throws if card is not in cube.
      const copyInfo = await getRemainingCopiesForPick(
        client, input.draftId, currentCardId, currentCardName,
      );
      isLastCopy = copyInfo.pickedCount >= copyInfo.qty;
      remainingAfterPick = copyInfo.qty - copyInfo.pickedCount;
    }

    if (isLastCopy) {
      const { pauseSeats } = await removeCardFromAllQueues(client, input.draftId, currentCardId);
      // Disable auto-pick for seats whose first entry was exhausted with pause mode
      await Promise.all(
        pauseSeats
          .filter((s) => s !== currentSeat)
          .map(async (s) => {
            await updateAutoPick(client, input.draftId, s, false);
            const prev = allSeatSettings.get(s);
            if (prev) allSeatSettings.set(s, { ...prev, autoPick: false });
          })
      );
      await removeFloatedCardByCardId(client, input.draftId, currentCardId);
    } else {
      // Not last copy: trim queue entries that exceed remaining availability
      await trimExcessQueueEntries(client, input.draftId, currentCardId, remainingAfterPick);
    }

    // Check if draft is complete
    const totalAfter = currentCount + picks.length;
    const totalExpected = getTotalPicks(numSeats, picksPerPlayer);
    if (totalAfter >= totalExpected) {
      await client.execute({
        sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
        args: [input.draftId],
      });
      // Clear all queues — they're irrelevant once drafting ends
      await client.execute({
        sql: `UPDATE seat_tokens SET queue_json = '[]' WHERE draft_id = ?`,
        args: [input.draftId],
      });
      return { picks, phaseChanged: true, newPhase: 'playing' };
    }

    // Check next seat for auto-pick
    const advance = await advanceAutoPick(
      client, input.draftId, totalAfter, numSeats, picksPerPlayer, allSeatSettings,
    );
    if (advance.kind !== 'candidate') break;

    currentSeat = advance.seat;
    currentCardId = advance.cardId;
    currentCardName = advance.cardName;
    cascadeDepth++;
  }

  return { picks, phaseChanged: false, newPhase: null };
}
