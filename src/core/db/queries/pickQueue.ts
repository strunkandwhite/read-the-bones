import type { Client } from '@libsql/client';

export async function getQueue(
  client: Client,
  draftId: string,
  seat: number,
): Promise<{ priority: number; cardId: number; cardName: string }[]> {
  const result = await client.execute({
    sql: `SELECT pq.priority, pq.card_id, c.name
          FROM pick_queue pq
          JOIN cards c ON c.card_id = pq.card_id
          WHERE pq.draft_id = ? AND pq.seat = ?
          ORDER BY pq.priority`,
    args: [draftId, seat],
  });
  return result.rows.map((row) => ({
    priority: row.priority as number,
    cardId: row.card_id as number,
    cardName: row.name as string,
  }));
}

export async function setQueue(
  client: Client,
  draftId: string,
  seat: number,
  cardIds: number[],
): Promise<void> {
  const statements = [
    { sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`, args: [draftId, seat] },
    ...cardIds.map((cardId, i) => ({
      sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
      args: [draftId, seat, i + 1, cardId],
    })),
  ];
  await client.batch(statements);
}

export async function removeCardFromAllQueues(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND card_id = ?`,
    args: [draftId, cardId],
  });

  const remaining = await client.execute({
    sql: `SELECT seat, card_id FROM pick_queue WHERE draft_id = ? ORDER BY seat, priority`,
    args: [draftId],
  });

  if (remaining.rows.length === 0) return;

  const statements: { sql: string; args: (string | number)[] }[] = [
    { sql: `DELETE FROM pick_queue WHERE draft_id = ?`, args: [draftId] },
  ];

  let currentSeat = -1;
  let priority = 0;
  for (const row of remaining.rows) {
    const seat = row.seat as number;
    if (seat !== currentSeat) {
      currentSeat = seat;
      priority = 0;
    }
    priority++;
    statements.push({
      sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
      args: [draftId, seat, priority, row.card_id as number],
    });
  }

  await client.batch(statements);
}

/**
 * Remove queue entries that exceed remainingCopies for a given card.
 * Removes from the bottom (highest priority number) per seat.
 * Called after a pick to trim queues across all seats.
 */
export async function trimExcessQueueEntries(
  client: Client,
  draftId: string,
  cardId: number,
  remainingCopies: number,
): Promise<void> {
  if (remainingCopies <= 0) {
    // No copies left — remove all entries (existing behavior)
    await removeCardFromAllQueues(client, draftId, cardId);
    return;
  }

  // Find all queue entries for this card across all seats
  const entries = await client.execute({
    sql: `SELECT seat, priority, card_id
          FROM pick_queue
          WHERE draft_id = ? AND card_id = ?
          ORDER BY seat, priority`,
    args: [draftId, cardId],
  });

  // Group by seat, find entries to delete (lowest-priority = highest number)
  const toDelete: { seat: number; priority: number }[] = [];
  const bySeat = new Map<number, { priority: number }[]>();
  for (const row of entries.rows) {
    const seat = row.seat as number;
    const priority = row.priority as number;
    const arr = bySeat.get(seat) ?? [];
    arr.push({ priority });
    bySeat.set(seat, arr);
  }

  for (const [seat, seatEntries] of bySeat) {
    if (seatEntries.length <= remainingCopies) continue;
    // Sort by priority ascending, keep the first `remainingCopies`, delete the rest
    seatEntries.sort((a, b) => a.priority - b.priority);
    for (let i = remainingCopies; i < seatEntries.length; i++) {
      toDelete.push({ seat, priority: seatEntries[i].priority });
    }
  }

  if (toDelete.length === 0) return;

  // Delete excess entries
  const deleteStatements = toDelete.map(({ seat, priority }) => ({
    sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ? AND priority = ?`,
    args: [draftId, seat, priority] as (string | number)[],
  }));
  await client.batch(deleteStatements);

  // Renumber remaining entries per affected seat
  const affectedSeats = new Set(toDelete.map((d) => d.seat));
  const renumberStatements: { sql: string; args: (string | number)[] }[] = [];

  for (const seat of affectedSeats) {
    const remaining = await client.execute({
      sql: `SELECT card_id FROM pick_queue WHERE draft_id = ? AND seat = ? ORDER BY priority`,
      args: [draftId, seat],
    });

    renumberStatements.push({
      sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
      args: [draftId, seat],
    });
    remaining.rows.forEach((row, i) => {
      renumberStatements.push({
        sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
        args: [draftId, seat, i + 1, row.card_id as number],
      });
    });
  }

  if (renumberStatements.length > 0) {
    await client.batch(renumberStatements);
  }
}

/**
 * Find all seats that have a specific card in their queue.
 * Used to detect queue invalidation when a card is picked.
 * MUST be called BEFORE removeCardFromAllQueues for the same card.
 */
export async function getQueuesContainingCard(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<Array<{ seat: number }>> {
  const result = await client.execute({
    sql: `SELECT DISTINCT st.seat
          FROM pick_queue pq
          JOIN seat_tokens st ON st.draft_id = pq.draft_id AND st.seat = pq.seat
          WHERE pq.draft_id = ? AND pq.card_id = ?`,
    args: [draftId, cardId],
  });
  return result.rows.map((row) => ({ seat: row.seat as number }));
}

export async function getAutoPickCandidate(
  client: Client,
  draftId: string,
  seat: number,
  availableCardIds: Set<number>,
): Promise<number | null> {
  const queue = await getQueue(client, draftId, seat);
  for (const entry of queue) {
    if (availableCardIds.has(entry.cardId)) {
      return entry.cardId;
    }
  }
  return null;
}
