import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processPick } from './processPick';

// Mock pickQueue module
vi.mock('./db/queries/pickQueue', () => ({
  removeCardFromAllQueues: vi.fn().mockResolvedValue(undefined),
  getAutoPickCandidate: vi.fn().mockResolvedValue(null),
}));

// ============================================================================
// Test Helpers
// ============================================================================

function createMockClient() {
  return {
    execute: vi.fn(),
  };
}

function createQueryResult(rows: Record<string, unknown>[], rowsAffected = 0) {
  return { rows, rowsAffected };
}

// ============================================================================
// processPick Tests
// ============================================================================

describe('processPick', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  const baseInput = {
    draftId: 'draft-1',
    seat: 1,
    cardId: 42,
    cardName: 'Counterspell',
  };

  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  it('rejects when phase is not drafting', async () => {
    // 1. Draft metadata — phase is 'complete'
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'complete', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow("Draft is in 'complete' phase, not 'drafting'");
  });

  it("rejects when it's not this seat's turn", async () => {
    // 1. Draft metadata — phase is 'drafting', 4 seats, 6 picks per player
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count — 0 picks so far (next pick is seat 1)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );

    await expect(
      processPick(mockClient as never, { ...baseInput, seat: 2 }),
    ).rejects.toThrow("It's seat 1's turn, not seat 2's");
  });

  it('rejects banned card', async () => {
    // 1. Draft metadata with banned card
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        {
          phase: 'drafting',
          num_seats: 4,
          picks_per_player: 6,
          banned_cards: '["Lightning Bolt"]',
        },
      ]),
    );
    // 2. Pick count — 0 picks
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );

    await expect(
      processPick(mockClient as never, {
        ...baseInput,
        seat: 1,
        cardName: 'Lightning Bolt',
      }),
    ).rejects.toThrow('Lightning Bolt is banned');
  });

  it('rejects already-picked card', async () => {
    // 1. Draft metadata
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count — 0 picks (seat 1's turn)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );
    // 3. Already-picked check — returns a row (card already taken)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ 1: 1 }]),
    );

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow('Counterspell has already been picked');
  });

  it('records pick and returns it', async () => {
    // 1. Draft metadata
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count — 0 picks
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );
    // 3. Already-picked check — no rows (card is available)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([]),
    );
    // 4. INSERT pick_events — success
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );
    // 5. removeCardFromAllQueues is mocked at module level
    // 6. Check next seat for auto_pick — no token found (break cascade)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([]),
    );

    const result = await processPick(mockClient as never, baseInput);

    expect(result).toEqual({
      picks: [
        { pickN: 1, seat: 1, cardId: 42, cardName: 'Counterspell' },
      ],
      phaseChanged: false,
      newPhase: null,
    });
  });

  it('transitions to playing when all picks are made', async () => {
    // 4 seats * 6 picks = 24 total. currentCount = 23, so this is the last pick.
    // derivePickSeat(24, {4, 6}): trailing single-pick round, seat = 4.

    // 1. Draft metadata
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count — 23 picks already made
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 23 }]),
    );
    // 3. Already-picked check — card is available
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([]),
    );
    // 4. INSERT — success
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );
    // 5. removeCardFromAllQueues is mocked at module level
    // 6. UPDATE drafts SET phase = 'playing'
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );

    const result = await processPick(mockClient as never, {
      ...baseInput,
      seat: 4,
      cardId: 99,
      cardName: 'Final Card',
    });

    expect(result).toEqual({
      picks: [
        { pickN: 24, seat: 4, cardId: 99, cardName: 'Final Card' },
      ],
      phaseChanged: true,
      newPhase: 'playing',
    });
  });
});
