import type { Client } from '@libsql/client';
import { getNextPick, getTotalPicks } from './snakeDraft';
import { removeCardFromAllQueues, getAutoPickCandidate } from './db/queries/pickQueue';
import { parseBannedCards } from './db/queries/helpers';

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
  const draft = await client.execute({
    sql: `SELECT phase, num_seats, picks_per_player, banned_cards
          FROM drafts WHERE draft_id = ?`,
    args: [input.draftId],
  });
  if (draft.rows.length === 0) throw new Error('Draft not found');
  const row = draft.rows[0];
  const phase = row.phase as string;
  const numSeats = row.num_seats as number;
  const picksPerPlayer = row.picks_per_player as number;
  const bannedCards = parseBannedCards(row.banned_cards as string | null);

  if (phase !== 'drafting') {
    throw new Error(`Draft is in '${phase}' phase, not 'drafting'`);
  }

  // 2. Derive whose turn it is
  const pickCount = await client.execute({
    sql: `SELECT COUNT(*) as cnt FROM pick_events WHERE draft_id = ?`,
    args: [input.draftId],
  });
  const currentCount = pickCount.rows[0].cnt as number;
  const next = getNextPick(currentCount, numSeats, picksPerPlayer);
  if (!next) throw new Error('All picks are made');
  if (next.seat !== input.seat) {
    throw new Error(`It's seat ${next.seat}'s turn, not seat ${input.seat}'s`);
  }

  // 3. Validate card is available and not banned
  if (bannedCards.has(input.cardName.toLowerCase())) {
    throw new Error(`${input.cardName} is banned`);
  }
  const alreadyPicked = await client.execute({
    sql: `SELECT 1 FROM pick_events
          WHERE draft_id = ? AND card_id = ?`,
    args: [input.draftId, input.cardId],
  });
  if (alreadyPicked.rows.length > 0) {
    throw new Error(`${input.cardName} has already been picked`);
  }

  // 4. Insert with optimistic concurrency + cascade
  const picks: ProcessPickResult['picks'] = [];
  const maxCascade = numSeats * 2;

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
      throw new Error('Conflict: pick_n already exists — retry');
    }

    picks.push({
      pickN,
      seat: currentSeat,
      cardId: currentCardId,
      cardName: currentCardName,
    });

    // Remove from all queues
    await removeCardFromAllQueues(client, input.draftId, currentCardId);

    // Check if draft is complete
    const totalAfter = currentCount + picks.length;
    const totalExpected = getTotalPicks(numSeats, picksPerPlayer);
    if (totalAfter >= totalExpected) {
      await client.execute({
        sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
        args: [input.draftId],
      });
      return { picks, phaseChanged: true, newPhase: 'playing' };
    }

    // Check next seat for auto-pick
    const nextAfter = getNextPick(totalAfter, numSeats, picksPerPlayer);
    if (!nextAfter) break;

    const nextSeatToken = await client.execute({
      sql: `SELECT auto_pick FROM seat_tokens WHERE draft_id = ? AND seat = ?`,
      args: [input.draftId, nextAfter.seat],
    });
    if (nextSeatToken.rows.length === 0 || nextSeatToken.rows[0].auto_pick !== 1) {
      break;
    }

    // Get available card_ids
    const available = await client.execute({
      sql: `SELECT csc.card_id
            FROM cube_snapshot_cards csc
            JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
            WHERE d.draft_id = ?
            AND csc.card_id NOT IN (
              SELECT card_id FROM pick_events WHERE draft_id = ?
            )`,
      args: [input.draftId, input.draftId],
    });
    const availableSet = new Set(available.rows.map((r) => r.card_id as number));

    const candidate = await getAutoPickCandidate(
      client, input.draftId, nextAfter.seat, availableSet,
    );
    if (!candidate) break;

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
