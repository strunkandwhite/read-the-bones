import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processPick } from './processPick';

// Mock pickQueue module
vi.mock('./db/queries/pickQueue', () => ({
  removeCardFromAllQueues: vi.fn().mockResolvedValue({ pauseSeats: [] }),
  trimExcessQueueEntries: vi.fn().mockResolvedValue(undefined),
  getAutoPickCandidate: vi.fn().mockResolvedValue({ kind: 'empty' }),
  fulfillGroupEntry: vi.fn().mockResolvedValue({ mode: 'pause', cards: [] }),
}));

// Mock floatedCards module
vi.mock('./db/queries/floatedCards', () => ({
  addFloatedCard: vi.fn().mockResolvedValue(undefined),
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
    it('disables auto-pick for seats returned in pauseSeats when last copy is taken', async () => {
      const { removeCardFromAllQueues } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings, updateAutoPick } = await import('./db/queries/seatTokens');

      // Seat 2 is in pauseSeats (its first entry was a pause-mode entry for this card)
      vi.mocked(removeCardFromAllQueues).mockResolvedValueOnce({ pauseSeats: [2] });
      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
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

      // updateAutoPick should be called for seat 2 (in pauseSeats, not currentSeat)
      expect(updateAutoPick).toHaveBeenCalledWith(mockClient, 'draft-1', 2, false);
    });

    it('does not call updateAutoPick when pauseSeats is empty', async () => {
      const { updateAutoPick } = await import('./db/queries/seatTokens');

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
      const { removeCardFromAllQueues } = await import('./db/queries/pickQueue');

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

    it('does not call updateAutoPick or removeCardFromAllQueues when copies remain', async () => {
      const { removeCardFromAllQueues } = await import('./db/queries/pickQueue');
      const { updateAutoPick } = await import('./db/queries/seatTokens');

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
      // 5. isLastCopy=false -> trimExcessQueueEntries, not removeCardFromAllQueues
      // (no DB query for next seat; allSeatSettings returns empty map -> break)

      await processPick(mockClient as never, baseInput);

      expect(removeCardFromAllQueues).not.toHaveBeenCalled();
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

  describe('auto-pick cascade', () => {
    it('calls fulfillGroupEntry after a successful auto-pick cascade step', async () => {
      const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      // Seat 2 has auto-pick enabled
      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      // getAutoPickCandidate returns a candidate for seat 2
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 10, entryIndex: 0,
      });

      // 1. Draft metadata -- 2 seats, 3 picks each (6 total)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ phase: 'drafting', num_seats: 2, picks_per_player: 3, banned_cards: null }]),
      );
      // 2. Pick count -- 0 (seat 1's turn)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- qty=1, picked_count=0
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 1 }]),
      );
      // 4. INSERT pick_events for seat 1 -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // After isLastCopy=true: removeCardFromAllQueues+removeFloatedCardByCardId are module mocks
      // 5. Available cards query for seat 2
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ card_id: 10 }]),
      );
      // getAutoPickCandidate returns candidate (mocked above) -> fulfillGroupEntry called
      // 6. Card name lookup for candidate cardId=10 -- return empty to break cascade
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([]),
      );
      // cardRow.rows.length === 0 -> break

      const result = await processPick(mockClient as never, baseInput);

      expect(result.picks).toHaveLength(1);
      expect(fulfillGroupEntry).toHaveBeenCalledWith(mockClient, 'draft-1', 2, 0);
    });

    it('floats non-picked group members when cascade fulfills a group entry', async () => {
      const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
      const { addFloatedCard } = await import('./db/queries/floatedCards');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 10, entryIndex: 0,
      });
      // Group has 3 cards; cardId 10 is picked, 20 and 30 should be floated
      vi.mocked(fulfillGroupEntry).mockResolvedValueOnce({
        mode: 'pause',
        cards: [
          { id: 10, name: 'Lightning Bolt' },
          { id: 20, name: 'Counterspell' },
          { id: 30, name: 'Swords to Plowshares' },
        ],
      });

      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ phase: 'drafting', num_seats: 2, picks_per_player: 3, banned_cards: null }]),
      );
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 10 }]));
      // Card name lookup returns empty to break cascade after the float
      mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

      await processPick(mockClient as never, baseInput);

      // Picked card should NOT be floated
      expect(addFloatedCard).not.toHaveBeenCalledWith(mockClient, 'draft-1', 2, 'Lightning Bolt');
      // Non-picked group members should be floated
      expect(addFloatedCard).toHaveBeenCalledWith(mockClient, 'draft-1', 2, 'Counterspell');
      expect(addFloatedCard).toHaveBeenCalledWith(mockClient, 'draft-1', 2, 'Swords to Plowshares');
      expect(addFloatedCard).toHaveBeenCalledTimes(2);
    });

    it('disables auto-pick and stops cascade when getAutoPickCandidate returns paused', async () => {
      const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings, updateAutoPick } = await import('./db/queries/seatTokens');

      // Seat 2 has auto-pick enabled
      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      // getAutoPickCandidate returns paused
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'paused' });

      // 1. Draft metadata -- 2 seats, 3 picks each
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ phase: 'drafting', num_seats: 2, picks_per_player: 3, banned_cards: null }]),
      );
      // 2. Pick count -- 0 (seat 1's turn)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- qty=1, picked_count=0
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 1 }]),
      );
      // 4. INSERT pick_events for seat 1 -- success
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([], 1),
      );
      // 5. isLastCopy=true -> removeCardFromAllQueues (mocked, returns pauseSeats:[])
      // 6. Available cards query for seat 2
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ card_id: 10 }]),
      );
      // getAutoPickCandidate returns paused -> updateAutoPick called, cascade breaks

      const result = await processPick(mockClient as never, baseInput);

      expect(result.picks).toHaveLength(1);
      expect(updateAutoPick).toHaveBeenCalledWith(mockClient, 'draft-1', 2, false);
    });
  });
});
