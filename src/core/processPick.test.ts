import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processPick } from './processPick';

// Mock pickQueue module
vi.mock('./db/queries/pickQueue', () => ({
  removeCardFromAllQueues: vi.fn().mockResolvedValue(undefined),
  trimExcessQueueEntries: vi.fn().mockResolvedValue(undefined),
  getAutoPickCandidate: vi.fn().mockResolvedValue(null),
  getQueuesContainingCard: vi.fn().mockResolvedValue([]),
}));

// Mock floatedCards module
vi.mock('./db/queries/floatedCards', () => ({
  removeFloatedCardByCardId: vi.fn().mockResolvedValue(undefined),
}));

// Mock seatTokens module
vi.mock('./db/queries/seatTokens', () => ({
  getAllSeatSettings: vi.fn().mockResolvedValue(new Map()),
  updateAutoPick: vi.fn().mockResolvedValue(undefined),
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
    // 1. Draft metadata -- phase is 'complete'
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
    // 1. Draft metadata -- phase is 'drafting', 4 seats, 6 picks per player
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count -- 0 picks so far (next pick is seat 1)
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
    // 2. Pick count -- 0 picks
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
    // 2. Pick count -- 0 picks (seat 1's turn)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );
    // 3. Availability check -- picked_count=1, qty=1 (fully taken)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ picked_count: 1, qty: 1 }]),
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
    // 2. Pick count -- 0 picks
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );
    // 3. Availability check -- picked_count=0, qty=1 (available)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ picked_count: 0, qty: 1 }]),
    );
    // 4. getAllSeatSettings returns empty map (mocked at top level)
    // 5. INSERT pick_events -- success
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );
    // 6. isLastCopy=true (0+1>=1), so removeCardFromAllQueues is called (mocked)
    // (no DB query for next seat auto_pick; uses allSeatSettings map -- seat 2 not in map -> break)

    const result = await processPick(mockClient as never, baseInput);

    expect(result).toEqual({
      picks: [
        { pickN: 1, seat: 1, cardId: 42, cardName: 'Counterspell' },
      ],
      phaseChanged: false,
      newPhase: null,
    });
  });

  it('calls removeFloatedCardByCardId when isLastCopy is true', async () => {
    const { removeFloatedCardByCardId } = await import('./db/queries/floatedCards');

    // 1. Draft metadata
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([
        { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
      ]),
    );
    // 2. Pick count -- 0 picks
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );
    // 3. Availability check -- picked_count=0, qty=1 (last copy)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ picked_count: 0, qty: 1 }]),
    );
    // 4. INSERT pick_events -- success
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );

    await processPick(mockClient as never, baseInput);

    expect(removeFloatedCardByCardId).toHaveBeenCalledWith(
      mockClient, 'draft-1', 42,
    );
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
    // 2. Pick count -- 23 picks already made
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 23 }]),
    );
    // 3. Availability check -- picked_count=0, qty=1 (available)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ picked_count: 0, qty: 1 }]),
    );
    // 4. INSERT -- success
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 1),
    );
    // 5. isLastCopy=true, removeCardFromAllQueues is mocked
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

  describe('queue cleanup on last copy', () => {
    it('does not pause auto-pick when last copy is taken (cautious mode removed)', async () => {
      const { getQueuesContainingCard } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings, updateAutoPick } = await import('./db/queries/seatTokens');

      // Seat 2 has the card queued
      vi.mocked(getQueuesContainingCard).mockResolvedValueOnce([{ seat: 2 }]);
      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: false, displayName: null }],
      ]));

      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([
          { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
        ]),
      );
      // 2. Pick count -- 0 picks
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- picked_count=0, qty=1 (last copy)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 1 }]),
      );
      // 4. INSERT pick_events -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );

      await processPick(mockClient as never, baseInput);

      expect(getQueuesContainingCard).toHaveBeenCalledWith(
        mockClient, 'draft-1', 42,
      );
      // updateAutoPick should NOT be called — cautious-mode pause logic removed
      expect(updateAutoPick).not.toHaveBeenCalled();
    });
  });

  describe('multi-copy cards', () => {
    it('allows picking a 2-copy card that has been picked once', async () => {
      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([
          { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
        ]),
      );
      // 2. Pick count -- 1 pick so far (seat 2's turn)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 1 }]),
      );
      // 3. Availability check -- picked_count=1, qty=2 (still available)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 1, qty: 2 }]),
      );
      // 4. INSERT pick_events -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // 5. isLastCopy=true (1+1>=2) -> removeCardFromAllQueues is called (mocked)
      // (no DB query for next seat auto_pick; uses allSeatSettings map -> break)

      const result = await processPick(mockClient as never, {
        ...baseInput,
        seat: 2,
      });

      expect(result.picks).toHaveLength(1);
      expect(result.picks[0].seat).toBe(2);
    });

    it('rejects picking a 2-copy card when both copies are taken', async () => {
      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([
          { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
        ]),
      );
      // 2. Pick count -- 2 picks so far (seat 3's turn)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 2 }]),
      );
      // 3. Availability check -- picked_count=2, qty=2 (fully taken)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 2, qty: 2 }]),
      );

      await expect(
        processPick(mockClient as never, { ...baseInput, seat: 3 }),
      ).rejects.toThrow('Counterspell has already been picked');
    });

    it('only removes from queues when last copy is taken', async () => {
      const { removeCardFromAllQueues, getQueuesContainingCard } = await import('./db/queries/pickQueue');

      vi.mocked(getQueuesContainingCard).mockResolvedValueOnce([]);

      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([
          { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
        ]),
      );
      // 2. Pick count -- 0 picks
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- picked_count=0, qty=2 (first of 2 copies)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 2 }]),
      );
      // 4. INSERT -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // 5. isLastCopy=false (0+1<2) -> skip queue removal
      // (no DB query for next seat auto_pick; uses allSeatSettings map -> break)

      await processPick(mockClient as never, baseInput);

      // picked_count was 0, qty is 2 -> after this pick, 1 < 2 -> NOT last copy
      expect(removeCardFromAllQueues).not.toHaveBeenCalled();
    });

    it('does not pause cautious auto-pick when copies remain', async () => {
      const { getQueuesContainingCard } = await import('./db/queries/pickQueue');
      const { updateAutoPick } = await import('./db/queries/seatTokens');

      vi.mocked(getQueuesContainingCard).mockResolvedValueOnce([{ seat: 2 }]);

      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([
          { phase: 'drafting', num_seats: 4, picks_per_player: 6, banned_cards: null },
        ]),
      );
      // 2. Pick count -- 0
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- picked_count=0, qty=2 (copies remain after pick)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 2 }]),
      );
      // 4. INSERT -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // 5. isLastCopy=false -> skip cautious pause and queue removal
      // (no DB query for next seat auto_pick; uses allSeatSettings map -> break)

      await processPick(mockClient as never, baseInput);

      // Copies remain -> no pause, no queue removal
      expect(getQueuesContainingCard).not.toHaveBeenCalled();
      expect(updateAutoPick).not.toHaveBeenCalled();
    });

    it('calls trimExcessQueueEntries when pick is not last copy', async () => {
      const { trimExcessQueueEntries } = await import('./db/queries/pickQueue');

      // 1. Draft metadata
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ phase: 'drafting', num_seats: 2, picks_per_player: 3, banned_cards: null }]),
      );
      // 2. Pick count -- 0 picks (seat 1's turn)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- qty=3, picked_count=0 (NOT last copy)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 3 }]),
      );
      // 4. INSERT pick_events -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // 5. isLastCopy=false (0+1 < 3) -> trimExcessQueueEntries called (mocked)
      // (no DB query for next seat; allSeatSettings returns empty map -> break)

      await processPick(mockClient as never, {
        draftId: 'd1', seat: 1, cardId: 100, cardName: 'Scalding Tarn',
      });

      expect(trimExcessQueueEntries).toHaveBeenCalledWith(
        mockClient, 'd1', 100, 2, // 3 - (0+1) = 2 remaining
      );
      // removeCardFromAllQueues should NOT have been called
      const { removeCardFromAllQueues } = await import('./db/queries/pickQueue');
      expect(removeCardFromAllQueues).not.toHaveBeenCalled();
    });
  });
});
