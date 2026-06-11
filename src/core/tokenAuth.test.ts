import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db/queries/seatTokens', () => ({
  resolveToken: vi.fn(),
}));

import { resolveToken } from './db/queries/seatTokens';
import { extractToken, authenticateSeat } from './tokenAuth';

const mockResolveToken = vi.mocked(resolveToken);

function createMockClient() {
  return { execute: vi.fn() } as never;
}

describe('extractToken', () => {
  it('reads from X-Seat-Token header', () => {
    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'abc123' },
    });
    expect(extractToken(req)).toBe('abc123');
  });

  it('does NOT read from ?token= query param (tokens in URLs hit server logs)', () => {
    const req = new Request('http://localhost/test?token=xyz789');
    expect(extractToken(req)).toBeNull();
  });

  it('header takes precedence over query param', () => {
    const req = new Request('http://localhost/test?token=ignored', {
      headers: { 'X-Seat-Token': 'header-wins' },
    });
    expect(extractToken(req)).toBe('header-wins');
  });

  it('returns null if header absent', () => {
    const req = new Request('http://localhost/test');
    expect(extractToken(req)).toBeNull();
  });
});

describe('authenticateSeat', () => {
  const client = createMockClient();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { seat, autoPick, displayName } for valid token', async () => {
    mockResolveToken.mockResolvedValue({
      draftId: 'draft-1',
      seat: 3,
      autoPick: true,
      displayName: 'Alice',
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'valid-token' },
    });

    const result = await authenticateSeat(client, req, 'draft-1');
    expect(result).toEqual({ seat: 3, autoPick: true, displayName: 'Alice' });
    expect(mockResolveToken).toHaveBeenCalledWith(client, 'valid-token');
  });

  it('includes null displayName when seat has no display name set', async () => {
    mockResolveToken.mockResolvedValue({
      draftId: 'draft-1',
      seat: 2,
      autoPick: false,
      displayName: null,
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'valid-token' },
    });

    const result = await authenticateSeat(client, req, 'draft-1');
    expect(result).toEqual({ seat: 2, autoPick: false, displayName: null });
  });

  it('throws for missing token', async () => {
    const req = new Request('http://localhost/test');

    await expect(authenticateSeat(client, req, 'draft-1')).rejects.toThrow(
      'Missing seat token',
    );
  });

  it('throws for invalid token (resolveToken returns null)', async () => {
    mockResolveToken.mockResolvedValue(null);

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'bad-token' },
    });

    await expect(authenticateSeat(client, req, 'draft-1')).rejects.toThrow(
      'Invalid seat token',
    );
  });

  it('throws if token draftId does not match', async () => {
    mockResolveToken.mockResolvedValue({
      draftId: 'draft-2',
      seat: 1,
      autoPick: false,
      displayName: null,
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'wrong-draft-token' },
    });

    await expect(authenticateSeat(client, req, 'draft-1')).rejects.toThrow(
      'Token does not match draft',
    );
  });
});
