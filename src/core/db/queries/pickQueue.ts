import type { Client } from '@libsql/client';

export interface QueueCard {
  id: number;
  name: string;
}

export interface QueueEntry {
  mode: 'pause' | 'flow-through';
  cards: QueueCard[];
}

export type AutoPickResult =
  | { kind: 'candidate'; cardId: number; entryIndex: number }
  | { kind: 'paused' }
  | { kind: 'empty' };

export async function getQueue(
  client: Client,
  draftId: string,
  seat: number,
): Promise<QueueEntry[]> {
  const result = await client.execute({
    sql: `SELECT queue_json FROM seat_tokens WHERE draft_id = ? AND seat = ?`,
    args: [draftId, seat],
  });
  if (result.rows.length === 0) return [];
  const raw = result.rows[0].queue_json as string | null;
  if (!raw) return [];
  return JSON.parse(raw) as QueueEntry[];
}

export async function setQueue(
  client: Client,
  draftId: string,
  seat: number,
  entries: QueueEntry[],
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
    args: [JSON.stringify(entries), draftId, seat],
  });
}

export async function removeCardFromAllQueues(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<{ pauseSeats: number[] }> {
  const result = await client.execute({
    sql: `SELECT seat, queue_json FROM seat_tokens WHERE draft_id = ? AND queue_json IS NOT NULL`,
    args: [draftId],
  });

  const updates: { seat: number; newQueue: QueueEntry[] }[] = [];
  const pauseSeats: number[] = [];

  for (const row of result.rows) {
    const seat = row.seat as number;
    const queue: QueueEntry[] = JSON.parse(row.queue_json as string);

    // Check if card is in this queue at all
    const hasCard = queue.some((entry) => entry.cards.some((c) => c.id === cardId));
    if (!hasCard) continue;

    // Check pause trigger before mutation: is the card in the first entry?
    const firstEntry = queue[0];
    const cardInFirstEntry = firstEntry?.cards.some((c) => c.id === cardId);

    // Remove card from all entries, drop empty entries
    const newQueue: QueueEntry[] = [];
    for (const entry of queue) {
      const filteredCards = entry.cards.filter((c) => c.id !== cardId);
      if (filteredCards.length > 0) {
        newQueue.push({ ...entry, cards: filteredCards });
      }
    }

    // Pause check: if card was in the first entry, that entry's mode is 'pause',
    // and the first entry is now fully exhausted (empty after removal)
    if (cardInFirstEntry && firstEntry.mode === 'pause') {
      const remainingInFirstEntry = firstEntry.cards.filter((c) => c.id !== cardId);
      if (remainingInFirstEntry.length === 0) {
        pauseSeats.push(seat);
      }
    }

    updates.push({ seat, newQueue });
  }

  if (updates.length > 0) {
    await client.batch(
      updates.map(({ seat, newQueue }) => ({
        sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
        args: [JSON.stringify(newQueue), draftId, seat] as (string | number)[],
      })),
    );
  }

  return { pauseSeats };
}

export async function getAutoPickCandidate(
  client: Client,
  draftId: string,
  seat: number,
  availableCardIds: Set<number>,
): Promise<AutoPickResult> {
  const queue = await getQueue(client, draftId, seat);
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    for (const card of entry.cards) {
      if (availableCardIds.has(card.id)) {
        return { kind: 'candidate', cardId: card.id, entryIndex: i };
      }
    }
    // Entry exhausted
    if (entry.mode === 'pause') return { kind: 'paused' };
    // flow-through: continue to next entry
  }
  return { kind: 'empty' };
}

/**
 * Remove queue entries that exceed remainingCopies for a given card.
 * Removes from the bottom (lowest priority = highest index) per seat.
 * Called after a pick to trim queues across all seats.
 */
export async function trimExcessQueueEntries(
  client: Client,
  draftId: string,
  cardId: number,
  remainingCopies: number,
): Promise<void> {
  if (remainingCopies <= 0) {
    await removeCardFromAllQueues(client, draftId, cardId);
    return;
  }

  const result = await client.execute({
    sql: `SELECT seat, queue_json FROM seat_tokens WHERE draft_id = ? AND queue_json IS NOT NULL`,
    args: [draftId],
  });

  const updates: { seat: number; newQueue: QueueEntry[] }[] = [];

  for (const row of result.rows) {
    const seat = row.seat as number;
    const queue: QueueEntry[] = JSON.parse(row.queue_json as string);

    // Count references to this card
    let count = 0;
    for (const entry of queue) {
      count += entry.cards.filter((c) => c.id === cardId).length;
    }
    if (count <= remainingCopies) continue;

    // Remove excess from bottom (highest index) up
    let toRemove = count - remainingCopies;

    // First pass: find which entries to trim (iterate in reverse)
    const removeAtEntry = new Set<number>();
    for (let i = queue.length - 1; i >= 0 && toRemove > 0; i--) {
      if (queue[i].cards.some((c) => c.id === cardId)) {
        removeAtEntry.add(i);
        toRemove--;
      }
    }

    // Second pass: build new queue
    const newQueue: QueueEntry[] = [];
    for (let i = 0; i < queue.length; i++) {
      if (removeAtEntry.has(i)) {
        const filteredCards = queue[i].cards.filter((c) => c.id !== cardId);
        if (filteredCards.length > 0) {
          newQueue.push({ ...queue[i], cards: filteredCards });
        }
        // else: entry removed entirely
      } else {
        newQueue.push(queue[i]);
      }
    }

    updates.push({ seat, newQueue });
  }

  if (updates.length > 0) {
    await client.batch(
      updates.map(({ seat, newQueue }) => ({
        sql: `UPDATE seat_tokens SET queue_json = ? WHERE draft_id = ? AND seat = ?`,
        args: [JSON.stringify(newQueue), draftId, seat] as (string | number)[],
      })),
    );
  }
}

/**
 * Remove an entire queue entry at a given index for a seat.
 * Called after auto-picking from a group entry.
 */
export async function fulfillGroupEntry(
  client: Client,
  draftId: string,
  seat: number,
  entryIndex: number,
): Promise<void> {
  const queue = await getQueue(client, draftId, seat);
  const newQueue = queue.filter((_, i) => i !== entryIndex);
  await setQueue(client, draftId, seat, newQueue);
}
