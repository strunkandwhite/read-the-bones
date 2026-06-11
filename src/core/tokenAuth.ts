import type { Client } from '@libsql/client';
import { resolveToken } from './db/queries/seatTokens';
import { AuthError } from './errors';

/**
 * Extract seat token from the Authorization header only.
 * Query-param tokens (?token=) are intentionally not accepted on API routes —
 * tokens in URLs appear in server and CDN logs. The join-link flow reads the
 * URL query param client-side (liveStore.hydrateToken) and stores it in
 * localStorage before any API call is made.
 */
export function extractToken(request: Request): string | null {
  return request.headers.get('X-Seat-Token');
}

export async function authenticateSeat(
  client: Client,
  request: Request,
  draftId: string,
): Promise<{ seat: number; autoPick: boolean; displayName: string | null }> {
  const token = extractToken(request);
  if (!token) throw new AuthError('Missing seat token');
  const resolved = await resolveToken(client, token);
  if (!resolved) throw new AuthError('Invalid seat token');
  if (resolved.draftId !== draftId) throw new AuthError('Token does not match draft');
  return { seat: resolved.seat, autoPick: resolved.autoPick, displayName: resolved.displayName };
}
