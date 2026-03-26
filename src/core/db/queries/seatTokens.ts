import { randomBytes } from 'crypto';
import type { Client } from '@libsql/client';

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

export async function generateSeatTokens(
  client: Client,
  draftId: string,
  numSeats: number,
): Promise<{ seat: number; token: string }[]> {
  const tokens: { seat: number; token: string }[] = [];
  for (let seat = 1; seat <= numSeats; seat++) {
    const token = generateToken();
    await client.execute({
      sql: `INSERT INTO seat_tokens (draft_id, seat, token, auto_pick)
            VALUES (?, ?, ?, 1)`,
      args: [draftId, seat, token],
    });
    tokens.push({ seat, token });
  }
  return tokens;
}

export async function resolveToken(
  client: Client,
  token: string,
): Promise<{ draftId: string; seat: number; autoPick: boolean; displayName: string | null } | null> {
  const result = await client.execute({
    sql: `SELECT draft_id, seat, auto_pick, display_name FROM seat_tokens WHERE token = ?`,
    args: [token],
  });
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    draftId: row.draft_id as string,
    seat: row.seat as number,
    autoPick: row.auto_pick === 1,
    displayName: (row.display_name as string) ?? null,
  };
}

export async function getSeatTokens(
  client: Client,
  draftId: string,
): Promise<{ seat: number; token: string; displayName: string | null; autoPick: boolean }[]> {
  const result = await client.execute({
    sql: `SELECT seat, token, display_name, auto_pick
          FROM seat_tokens WHERE draft_id = ? ORDER BY seat`,
    args: [draftId],
  });
  return result.rows.map((row) => ({
    seat: row.seat as number,
    token: row.token as string,
    displayName: row.display_name as string | null,
    autoPick: row.auto_pick === 1,
  }));
}

export async function regenerateToken(
  client: Client,
  draftId: string,
  seat: number,
): Promise<string> {
  const newToken = generateToken();
  await client.execute({
    sql: `UPDATE seat_tokens SET token = ? WHERE draft_id = ? AND seat = ?`,
    args: [newToken, draftId, seat],
  });
  return newToken;
}

export async function updateDisplayName(
  client: Client,
  draftId: string,
  seat: number,
  displayName: string | null,
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET display_name = ? WHERE draft_id = ? AND seat = ?`,
    args: [displayName, draftId, seat],
  });
}

export async function updateAutoPick(
  client: Client,
  draftId: string,
  seat: number,
  enabled: boolean,
): Promise<void> {
  await client.execute({
    sql: `UPDATE seat_tokens SET auto_pick = ? WHERE draft_id = ? AND seat = ?`,
    args: [enabled ? 1 : 0, draftId, seat],
  });
}
