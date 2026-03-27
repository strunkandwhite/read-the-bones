import type { Client } from '@libsql/client';
import { resolveToken } from './db/queries/seatTokens';
import { AuthError } from './errors';

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
  if (!token) throw new AuthError('Missing seat token');
  const resolved = await resolveToken(client, token);
  if (!resolved) throw new AuthError('Invalid seat token');
  if (resolved.draftId !== draftId) throw new AuthError('Token does not match draft');
  return { seat: resolved.seat, autoPick: resolved.autoPick };
}
