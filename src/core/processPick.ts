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
  const availCheck = await client.execute({
    sql: `SELECT COUNT(pe.pick_n) as picked_count, csc.qty
          FROM cube_snapshot_cards csc
          JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
          LEFT JOIN pick_events pe ON pe.card_id = csc.card_id AND pe.draft_id = d.draft_id
          WHERE d.draft_id = ? AND csc.card_id = ?
          GROUP BY csc.card_id, csc.qty`,
    args: [input.draftId, input.cardId],
  });
  if (availCheck.rows.length > 0) {
    const pickedCount = availCheck.rows[0].picked_count as number;
    const qty = availCheck.rows[0].qty as number;
    if (pickedCount >= qty) {
      throw new ValidationError(`${input.cardName} has already been picked`);
    }
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

    const inserted = await client.execute({
      sql: `INSERT INTO pick_events (draft_id, pick_n, seat, card_id)
            SELECT ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM pick_events WHERE draft_id = ? AND pick_n = ?
            )`,
      args: [input.draftId, pickN, currentSeat, currentCardId,
             input.draftId, pickN],
    });
    if (inserted.rowsAffected === 0) {
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
      const prevPickedCount = availCheck.rows.length > 0
        ? (availCheck.rows[0].picked_count as number)
        : 0;
      const totalQty = availCheck.rows.length > 0
        ? (availCheck.rows[0].qty as number)
        : 1;
      isLastCopy = prevPickedCount + 1 >= totalQty;
      remainingAfterPick = totalQty - (prevPickedCount + 1);
    } else {
      // Cascade pick: check the count now
      const copyCheck = await client.execute({
        sql: `SELECT COUNT(pe.pick_n) as picked_count, csc.qty
              FROM cube_snapshot_cards csc
              JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
              LEFT JOIN pick_events pe ON pe.card_id = csc.card_id AND pe.draft_id = d.draft_id
              WHERE d.draft_id = ? AND csc.card_id = ?
              GROUP BY csc.card_id, csc.qty`,
        args: [input.draftId, currentCardId],
      });
      const pickedNow = copyCheck.rows.length > 0 ? (copyCheck.rows[0].picked_count as number) : 1;
      const totalQty = copyCheck.rows.length > 0 ? (copyCheck.rows[0].qty as number) : 1;
      isLastCopy = pickedNow >= totalQty;
      remainingAfterPick = totalQty - pickedNow;
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
    const nextAfter = getNextPick(totalAfter, numSeats, picksPerPlayer);
    if (!nextAfter) break;

    const nextSettings = allSeatSettings.get(nextAfter.seat);
    if (!nextSettings?.autoPick) {
      break;
    }

    // Get available card_ids (quantity-aware)
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
      args: [input.draftId, input.draftId],
    });
    const availableSet = new Set(available.rows.map((r) => r.card_id as number));

    const autoPickResult = await getAutoPickCandidate(
      client, input.draftId, nextAfter.seat, availableSet,
    );
    if (autoPickResult.kind !== 'candidate') {
      if (autoPickResult.kind === 'paused') {
        await updateAutoPick(client, input.draftId, nextAfter.seat, false);
        allSeatSettings.set(nextAfter.seat, { ...nextSettings, autoPick: false });
      }
      break;
    }

    // Fulfill the group entry (remove entire entry from picking seat's queue)
    const fulfilledEntry = await fulfillGroupEntry(client, input.draftId, nextAfter.seat, autoPickResult.entryIndex);

    const candidate = autoPickResult.cardId;

    // Demote non-picked group members to float
    const nonPicked = fulfilledEntry.cards.filter((c) => c.id !== candidate);
    await Promise.all(nonPicked.map((c) => addFloatedCard(client, input.draftId, nextAfter.seat, c.name)));

    // Look up card name for the candidate
    const cardRow = await client.execute({
      sql: `SELECT name FROM cards WHERE card_id = ?`,
      args: [candidate],
    });
    if (cardRow.rows.length === 0) break;

    currentSeat = nextAfter.seat;
    currentCardId = candidate;
    currentCardName = cardRow.rows[0].name as string;
    cascadeDepth++;
  }

  return { picks, phaseChanged: false, newPhase: null };
}
