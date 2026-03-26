import type { Client } from '@libsql/client';
import { resolveToken } from './db/queries/seatTokens';

export function extractToken(request: Request): string | null {
  const header = request.headers.get('X-Seat-Token');
  if (header) return header;
  const url = new URL(request.url);
  return url.searchParams.get('token');
}

export async function authenticateSeat(
  client: Client,
  request: Request,
  draftId: string,
): Promise<{ seat: number; autoPick: boolean }> {
  const token = extractToken(request);
  if (!token) throw new Error('Missing seat token');
  const resolved = await resolveToken(client, token);
  if (!resolved) throw new Error('Invalid seat token');
  if (resolved.draftId !== draftId) throw new Error('Token does not match draft');
  return { seat: resolved.seat, autoPick: resolved.autoPick };
}
