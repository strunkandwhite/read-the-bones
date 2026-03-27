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

  it('reads from ?token= query param', () => {
    const req = new Request('http://localhost/test?token=xyz789');
    expect(extractToken(req)).toBe('xyz789');
  });

  it('returns null if neither present', () => {
    const req = new Request('http://localhost/test');
    expect(extractToken(req)).toBeNull();
  });
});

describe('authenticateSeat', () => {
  const client = createMockClient();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { seat, autoPick } for valid token', async () => {
    mockResolveToken.mockResolvedValue({
      draftId: 'draft-1',
      seat: 3,
      autoPick: true,
      displayName: null,
      autoPickMode: 'resilient' as const,
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'valid-token' },
    });

    const result = await authenticateSeat(client, req, 'draft-1');
    expect(result).toEqual({ seat: 3, autoPick: true });
    expect(mockResolveToken).toHaveBeenCalledWith(client, 'valid-token');
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
      autoPickMode: 'resilient' as const,
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Seat-Token': 'wrong-draft-token' },
    });

    await expect(authenticateSeat(client, req, 'draft-1')).rejects.toThrow(
      'Token does not match draft',
    );
  });
});
