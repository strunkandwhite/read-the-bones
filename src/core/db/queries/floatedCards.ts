import type { Client } from '@libsql/client';

export async function getFloatedCards(
  client: Client,
  draftId: string,
  seat: number,
): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT card_name FROM floated_cards
          WHERE draft_id = ? AND seat = ?
          ORDER BY created_at ASC`,
    args: [draftId, seat],
  });
  return result.rows.map((row) => row.card_name as string);
}

export async function addFloatedCard(
  client: Client,
  draftId: string,
  seat: number,
  cardName: string,
): Promise<void> {
  await client.execute({
    sql: `INSERT OR IGNORE INTO floated_cards (draft_id, seat, card_name)
          VALUES (?, ?, ?)`,
    args: [draftId, seat, cardName],
  });
}

export async function removeFloatedCard(
  client: Client,
  draftId: string,
  seat: number,
  cardName: string,
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM floated_cards
          WHERE draft_id = ? AND seat = ? AND card_name = ?`,
    args: [draftId, seat, cardName],
  });
}

export async function addFloatedCards(
  client: Client,
  draftId: string,
  seat: number,
  cardNames: string[],
): Promise<void> {
  if (cardNames.length === 0) return;
  await client.batch(
    cardNames.map((name) => ({
      sql: `INSERT OR IGNORE INTO floated_cards (draft_id, seat, card_name) VALUES (?, ?, ?)`,
      args: [draftId, seat, name],
    })),
  );
}

export async function removeFloatedCards(
  client: Client,
  draftId: string,
  seat: number,
  cardNames: string[],
): Promise<void> {
  if (cardNames.length === 0) return;
  await client.batch(
    cardNames.map((name) => ({
      sql: `DELETE FROM floated_cards WHERE draft_id = ? AND seat = ? AND card_name = ?`,
      args: [draftId, seat, name],
    })),
  );
}

export async function removeFloatedCardByCardId(
  client: Client,
  draftId: string,
  cardId: number,
): Promise<void> {
  await client.execute({
    sql: `DELETE FROM floated_cards
          WHERE draft_id = ? AND card_name = (
            SELECT name FROM cards WHERE card_id = ?
          )`,
    args: [draftId, cardId],
  });
}
