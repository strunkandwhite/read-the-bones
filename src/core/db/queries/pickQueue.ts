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

  const seats = await client.execute({
    sql: `SELECT DISTINCT seat FROM pick_queue WHERE draft_id = ? ORDER BY seat`,
    args: [draftId],
  });

  if (seats.rows.length > 0) {
    const renumberStatements = [];
    for (const row of seats.rows) {
      const seat = row.seat as number;
      const entries = await client.execute({
        sql: `SELECT card_id FROM pick_queue WHERE draft_id = ? AND seat = ? ORDER BY priority`,
        args: [draftId, seat],
      });
      renumberStatements.push({
        sql: `DELETE FROM pick_queue WHERE draft_id = ? AND seat = ?`,
        args: [draftId, seat],
      });
      for (let i = 0; i < entries.rows.length; i++) {
        renumberStatements.push({
          sql: `INSERT INTO pick_queue (draft_id, seat, priority, card_id) VALUES (?, ?, ?, ?)`,
          args: [draftId, seat, i + 1, entries.rows[i].card_id],
        });
      }
    }
    if (renumberStatements.length > 0) {
      await client.batch(renumberStatements);
    }
  }
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
