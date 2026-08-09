import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processPick, triggerAutoPickOnDemand } from './processPick';

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

/** Standard mock sequence for a drafting draft with 4 seats, 6 picks/player. */
function mockDraftMeta(mockClient: ReturnType<typeof createMockClient>, overrides: {
  phase?: string;
  num_seats?: number;
  picks_per_player?: number;
  banned_cards?: string | null;
  double_pick_after_round?: number | null;
} = {}) {
  mockClient.execute.mockResolvedValueOnce(
    createQueryResult([{
      phase: overrides.phase ?? 'drafting',
      num_seats: overrides.num_seats ?? 4,
      picks_per_player: overrides.picks_per_player ?? 6,
      banned_cards: overrides.banned_cards ?? null,
      double_pick_after_round: overrides.double_pick_after_round ?? null,
    }]),
  );
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
    mockDraftMeta(mockClient, { phase: 'complete' });

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow("Draft is in 'complete' phase, not 'drafting'");
  });

  it('throws NotFoundError when draft does not exist', async () => {
    // getDraftMeta returns no rows → null
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow('Draft not found');
  });

  it("rejects when it's not this seat's turn", async () => {
    // 1. Draft metadata -- phase is 'drafting', 4 seats, 6 picks per player
    mockDraftMeta(mockClient);
    // 2. Pick count -- 0 picks so far (next pick is seat 1)
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([{ cnt: 0 }]),
    );

    await expect(
      processPick(mockClient as never, { ...baseInput, seat: 2 }),
    ).rejects.toThrow("It's seat 1's turn, not seat 2's");
  });

  it('rejects when all picks are already made', async () => {
    // 4 seats * 6 picks = 24 total. cnt=24 → getNextPick returns null.
    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 24 }]));

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow('All picks are made');
  });

  it('rejects banned card', async () => {
    // 1. Draft metadata with banned card
    mockDraftMeta(mockClient, { banned_cards: '["Lightning Bolt"]' });
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

  it('rejects card not in this draft\'s cube (zero rows from cube_snapshot_cards)', async () => {
    // S1 fix: zero rows from the availability check → card not in cube
    mockDraftMeta(mockClient);
    // Pick count -- 0 picks (seat 1's turn)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    // Availability check -- zero rows (card not in this cube)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow("Counterspell is not in this draft's cube");
  });

  it('rejects already-picked card', async () => {
    // 1. Draft metadata
    mockDraftMeta(mockClient);
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

  it('throws ConflictError when optimistic INSERT finds pick_n already taken', async () => {
    // rowsAffected === 0 means another pick raced in at the same pick_n
    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    // Availability check OK
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
    // INSERT returns rowsAffected=0 (conflict)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 0));

    await expect(
      processPick(mockClient as never, baseInput),
    ).rejects.toThrow('Conflict: pick_n already exists — retry');
  });

  // With 4 seats and 6 picks each, the floor(N/4) heuristic starts double picks
  // after round 4, so pick 18 belongs to seat 1 (seat 1's second pick of round 5).
  // A draft that declares 6 stays on single picks throughout, making pick 18
  // seat 2's. The declared value has to win, or the pick engine disagrees with
  // the board about whose turn it is for the rest of the draft.
  describe('honours the draft\'s declared double-pick boundary', () => {
    it('accepts the seat the declared boundary puts on the clock', async () => {
      mockDraftMeta(mockClient, { double_pick_after_round: 6 });
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 17 }]));
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 1 }]),
      );
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 1, qty: 1 }]),
      );

      const result = await processPick(mockClient as never, {
        draftId: 'draft-1', seat: 2, cardId: 10, cardName: 'Bolt',
      });

      expect(result.picks[0]).toMatchObject({ pickN: 18, seat: 2 });
    });

    it('rejects the seat the heuristic would have put on the clock', async () => {
      mockDraftMeta(mockClient, { double_pick_after_round: 6 });
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 17 }]));

      await expect(
        processPick(mockClient as never, {
          draftId: 'draft-1', seat: 1, cardId: 10, cardName: 'Bolt',
        }),
      ).rejects.toThrow("It's seat 2's turn, not seat 1's");
    });
  });

  it('records pick and returns it', async () => {
    // 1. Draft metadata
    mockDraftMeta(mockClient);
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
    mockDraftMeta(mockClient);
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
    mockDraftMeta(mockClient);
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
    // 7. Clear all queues on phase transition
    mockClient.execute.mockResolvedValueOnce(
      createQueryResult([], 0),
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

    // Verify queues were cleared
    const calls = mockClient.execute.mock.calls;
    const clearQueueCall = calls.find((c: unknown[]) =>
      typeof c[0] === 'object' && (c[0] as { sql: string }).sql.includes("queue_json = '[]'")
    );
    expect(clearQueueCall).toBeDefined();
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
      mockDraftMeta(mockClient);
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
      mockDraftMeta(mockClient);
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
      mockDraftMeta(mockClient);
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
      mockDraftMeta(mockClient);
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
      mockDraftMeta(mockClient);
      // 2. Pick count -- 0 picks
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ cnt: 0 }]),
      );
      // 3. Availability check -- picked_count=0, qty=2 (first of 2 copies)
      mockClient.execute.mockResolvedValueOnce(
        createQueryResult([{ picked_count: 0, qty: 2 }]),
      );
      // 4. INSERT pick_events -- success
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
      mockDraftMeta(mockClient);
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
      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
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
      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
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

    it('completes a full cascade: second INSERT happens and both picks are returned', async () => {
      const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      // Seat 2 has auto-pick enabled
      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      // Seat 2's candidate is card 10
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 10, entryIndex: 0,
      });
      // After cascade pick, seat 1 is next — but no auto-pick set for seat 1 → cascade stops

      // 1. Draft meta: 2 seats, 3 picks each (6 total)
      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
      // 2. Pick count: 0 (seat 1's turn)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
      // 3. Availability check for seat 1's card (cardId=42)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
      // 4. INSERT for seat 1 -- success
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // isLastCopy=true → removeCardFromAllQueues (mocked)
      // 5. Available cards query (for advanceAutoPick: seat 2's turn)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 10 }]));
      // getAutoPickCandidate returns candidate for seat 2 (mocked)
      // fulfillGroupEntry (mocked, cards=[])
      // 6. Card name lookup for cardId=10 → success
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Lightning Bolt' }]));
      // Now cascadeDepth increments to 1; loop iteration 2:
      // 7. INSERT for seat 2, card 10 -- success (second INSERT)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // Cascade pick copy check (cascadeDepth > 0):
      // 8. getRemainingCopiesForPick for cardId=10
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));
      // isLastCopy=true → removeCardFromAllQueues (mocked)
      // totalAfter = 2 < 6, continue; advanceAutoPick for seat 1:
      // 9. Available cards query
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 50 }]));
      // getAutoPickCandidate returns 'empty' (default mock) → break

      const result = await processPick(mockClient as never, baseInput);

      // Both picks must be present
      expect(result.picks).toHaveLength(2);
      expect(result.picks[0]).toEqual({ pickN: 1, seat: 1, cardId: 42, cardName: 'Counterspell' });
      expect(result.picks[1]).toEqual({ pickN: 2, seat: 2, cardId: 10, cardName: 'Lightning Bolt' });
      expect(result.phaseChanged).toBe(false);
    });

    it('rejects a cascaded pick whose card is not in the cube (S1 cascade path)', async () => {
      // Arrange: seat 2 has auto-pick; its candidate is selected, but when we
      // re-check copy counts at cascadeDepth=1, the card has zero cube rows.
      const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 99, entryIndex: 0,
      });

      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
      // Availability for initial pick OK
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
      // INSERT seat 1 success
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // Available cards query
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 99 }]));
      // Card name lookup for cardId=99 → found
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Off Cube Card' }]));
      // INSERT seat 2, card 99 -- success
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // Cascade copy check for cardId=99 → ZERO rows (not in cube)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

      await expect(
        processPick(mockClient as never, baseInput),
      ).rejects.toThrow("Off Cube Card is not in this draft's cube");
    });

    it('stops at maxCascade: loop exits after numSeats*2 iterations', async () => {
      // numSeats=2, picksPerPlayer=20 → maxCascade=4, 40 total picks (won't finish draft).
      // With auto-pick on for both seats and candidates always returned, the cascade
      // should produce exactly maxCascade=4 picks then stop — the while condition
      // (cascadeDepth < maxCascade) enforces this bound.
      const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      const numSeats = 2;
      const picksPerPlayer = 20;
      const maxCascade = numSeats * 2; // 4

      vi.mocked(getAllSeatSettings).mockResolvedValue(new Map([
        [1, { autoPick: true, displayName: null }],
        [2, { autoPick: true, displayName: null }],
      ]));
      vi.mocked(getAutoPickCandidate).mockResolvedValue({ kind: 'candidate', cardId: 77, entryIndex: 0 });
      vi.mocked(fulfillGroupEntry).mockResolvedValue({ mode: 'flow-through', cards: [] });

      // Mock sequence for maxCascade=4 iterations:
      // Iteration 0 (cascadeDepth=0): INSERT + [no copy-check query] + available + name-lookup
      // Iteration 1 (cascadeDepth=1): INSERT + copy-check + available + name-lookup
      // Iteration 2 (cascadeDepth=2): INSERT + copy-check + available + name-lookup
      // Iteration 3 (cascadeDepth=3): INSERT + copy-check + [advanceAutoPick starts but
      //   cascadeDepth++ → 4 → loop exits before advanceAutoPick runs]
      // Wait — advanceAutoPick runs BEFORE cascadeDepth++. After it returns a candidate,
      // cascadeDepth increments and then the NEXT loop body starts. So iteration 3 DOES
      // call advanceAutoPick but the result is consumed, cascadeDepth→4, loop exits.
      // So iteration 3 needs: INSERT + copy-check + available + name-lookup.
      // After cascadeDepth=4 the loop exits — no more picks.

      mockDraftMeta(mockClient, { num_seats: numSeats, picks_per_player: picksPerPlayer });
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
      // Initial availability check (cascadeDepth=0 uses availCheck result, no extra query)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));

      // Provide all needed execute mocks for maxCascade iterations
      for (let depth = 0; depth < maxCascade; depth++) {
        // INSERT success
        mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
        if (depth > 0) {
          // Copy-check query (cascadeDepth > 0)
          mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));
        }
        // Available cards query (inside advanceAutoPick)
        mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 77 }]));
        // Card name lookup (inside advanceAutoPick)
        mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Auto Card' }]));
      }

      const result = await processPick(mockClient as never, {
        draftId: 'draft-1',
        seat: 1,
        cardId: 42,
        cardName: 'Counterspell',
      });

      expect(result.picks).toHaveLength(maxCascade);
      expect(result.phaseChanged).toBe(false);
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

      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
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
      // getAutoPickCandidate returns paused — pause-mode exhaustion
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'paused' });

      // 1. Draft metadata -- 2 seats, 3 picks each
      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
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

    it('demotes non-picked group members to float (group-member demotion)', async () => {
      // Verify that when a group entry is fulfilled during cascade,
      // the non-winning cards go to the seat's float, not the picking seat.
      const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
      const { addFloatedCard } = await import('./db/queries/floatedCards');
      const { getAllSeatSettings } = await import('./db/queries/seatTokens');

      vi.mocked(getAllSeatSettings).mockResolvedValueOnce(new Map([
        [2, { autoPick: true, displayName: null }],
      ]));
      vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({
        kind: 'candidate', cardId: 55, entryIndex: 0,
      });
      // Group entry for seat 2: cards 55 (picked) and 66 (demoted to float)
      vi.mocked(fulfillGroupEntry).mockResolvedValueOnce({
        mode: 'flow-through',
        cards: [
          { id: 55, name: 'Dark Ritual' },
          { id: 66, name: 'Demonic Tutor' },
        ],
      });

      mockDraftMeta(mockClient, { num_seats: 2, picks_per_player: 3 });
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 0, qty: 1 }]));
      mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
      // Available cards for seat 2
      mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 55 }]));
      // Card name lookup: cascade break (empty)
      mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

      await processPick(mockClient as never, baseInput);

      // card 66 (Demonic Tutor) should be floated to seat 2
      expect(addFloatedCard).toHaveBeenCalledWith(mockClient, 'draft-1', 2, 'Demonic Tutor');
      // card 55 (Dark Ritual) should NOT be floated
      expect(addFloatedCard).not.toHaveBeenCalledWith(mockClient, 'draft-1', 2, 'Dark Ritual');
    });
  });
});

// ============================================================================
// triggerAutoPickOnDemand Tests
//
// These tests verify that the on-demand endpoint path uses the SAME underlying
// candidate selection (`selectAutoPickCandidateForSeat`) as the cascade path.
// Shared behaviour is exercised here; processPick cascade tests cover the
// shared helper via the cascade path.
// ============================================================================

describe('triggerAutoPickOnDemand', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(async () => {
    mockClient = createMockClient();
    vi.clearAllMocks();
    // This path gates on the seat's auto-pick toggle, so every test here needs a
    // definite answer for seat 1. mockReset drops any one-shot values queued by
    // the cascade tests above, which vi.clearAllMocks leaves in place.
    const { getAllSeatSettings } = await import('./db/queries/seatTokens');
    vi.mocked(getAllSeatSettings).mockReset();
    vi.mocked(getAllSeatSettings).mockResolvedValue(new Map([
      [1, { autoPick: true, displayName: null }],
    ]));
  });

  it('picks nothing and reports autoPickDisabled when the seat has auto-pick off', async () => {
    const { getAllSeatSettings } = await import('./db/queries/seatTokens');
    const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
    vi.mocked(getAllSeatSettings).mockResolvedValue(new Map([
      [1, { autoPick: false, displayName: null }],
    ]));

    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));

    const result = await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1);

    expect(result).toEqual({
      pickedCard: null,
      autoPickDisabled: true,
      phaseChanged: false,
      newPhase: null,
    });
    // Bails before touching the queue at all
    expect(getAutoPickCandidate).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when draft does not exist', async () => {
    // getDraftMeta returns no rows → null
    mockClient.execute.mockResolvedValueOnce(createQueryResult([]));

    await expect(
      triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1),
    ).rejects.toThrow('Draft not found');
  });

  it('throws ValidationError when not in drafting phase', async () => {
    mockDraftMeta(mockClient, { phase: 'complete' });

    await expect(
      triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1),
    ).rejects.toThrow("Draft is in 'complete' phase, not 'drafting'");
  });

  it('throws ValidationError when it is not this seat\'s turn', async () => {
    // 4 seats, 6 picks each; 0 picks so far → seat 1's turn
    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));

    await expect(
      triggerAutoPickOnDemand(mockClient as never, 'draft-1', 2),
    ).rejects.toThrow("It's seat 1's turn, not seat 2's");
  });

  it('returns autoPickDisabled: true on pause-mode queue exhaustion (same as cascade)', async () => {
    const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
    const { updateAutoPick: updateAutoPickFn } = await import('./db/queries/seatTokens');
    vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'paused' });

    // Draft meta: seat 1's turn (0 picks)
    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    // Available cards query (inside selectAutoPickCandidateForSeat)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 5 }]));

    const result = await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1);

    expect(result.pickedCard).toBeNull();
    expect(result.autoPickDisabled).toBe(true);
    expect(result.phaseChanged).toBe(false);
    // Auto-pick must be disabled server-side
    expect(vi.mocked(updateAutoPickFn)).toHaveBeenCalledWith(mockClient, 'draft-1', 1, false);
  });

  it('returns pickedCard: null and autoPickDisabled: false when queue is empty (flow-through)', async () => {
    const { getAutoPickCandidate } = await import('./db/queries/pickQueue');
    vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'empty' });

    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    // Available cards query
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 10 }]));

    const result = await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1);

    expect(result.pickedCard).toBeNull();
    expect(result.autoPickDisabled).toBe(false);
  });

  it('picks the same card the cascade would for an identical queue state', async () => {
    // This test drives both triggerAutoPickOnDemand and processPick's cascade
    // against the same mocked queue to verify they call selectAutoPickCandidateForSeat
    // with the same inputs and get the same candidate.
    const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');

    // Candidate: card 42
    vi.mocked(getAutoPickCandidate).mockResolvedValue({ kind: 'candidate', cardId: 42, entryIndex: 0 });
    vi.mocked(fulfillGroupEntry).mockResolvedValue({ mode: 'pause', cards: [{ id: 42, name: 'Counterspell' }] });

    // --- triggerAutoPickOnDemand ---
    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }])); // pick count
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 42 }])); // available
    // Card name lookup
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Counterspell' }]));
    // INSERT pick_events
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
    // Copy check (getRemainingCopiesForPick after insert)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));
    // isLastCopy=true → removeCardFromAllQueues (mocked, returns pauseSeats:[])
    // No more queries needed

    const result = await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1);

    expect(result.pickedCard?.cardName).toBe('Counterspell');
    expect(result.pickedCard?.cardId).toBe(42);
    expect(result.autoPickDisabled).toBe(false);

    // Verify getAutoPickCandidate was called for seat 1 with the available set
    expect(getAutoPickCandidate).toHaveBeenCalledWith(
      mockClient, 'draft-1', 1, new Set([42]),
    );
  });

  it('throws ConflictError when optimistic INSERT is beaten (cascade fired first)', async () => {
    const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
    vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'candidate', cardId: 7, entryIndex: 0 });
    vi.mocked(fulfillGroupEntry).mockResolvedValueOnce({ mode: 'pause', cards: [{ id: 7, name: 'Bolt' }] });

    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 7 }]));
    // Card name lookup
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Bolt' }]));
    // INSERT returns rowsAffected=0 (cascade already wrote this pick_n)
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 0));

    await expect(
      triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1),
    ).rejects.toThrow('Conflict: pick_n already exists — retry');
  });

  it('demotes non-picked group members to float (same as cascade path)', async () => {
    const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
    const { addFloatedCard } = await import('./db/queries/floatedCards');

    vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'candidate', cardId: 10, entryIndex: 0 });
    vi.mocked(fulfillGroupEntry).mockResolvedValueOnce({
      mode: 'pause',
      cards: [
        { id: 10, name: 'Lightning Bolt' },
        { id: 20, name: 'Swords to Plowshares' },
      ],
    });

    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 0 }]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 10 }]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Lightning Bolt' }]));
    // INSERT
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
    // Copy check
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));

    await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 1);

    expect(addFloatedCard).toHaveBeenCalledWith(mockClient, 'draft-1', 1, 'Swords to Plowshares');
    expect(addFloatedCard).not.toHaveBeenCalledWith(mockClient, 'draft-1', 1, 'Lightning Bolt');
  });

  it('transitions draft to playing when last pick is made', async () => {
    // 4 seats, 6 picks each (24 total); 23 already made → seat 4's turn is last
    const { getAutoPickCandidate, fulfillGroupEntry } = await import('./db/queries/pickQueue');
    vi.mocked(getAutoPickCandidate).mockResolvedValueOnce({ kind: 'candidate', cardId: 99, entryIndex: 0 });
    vi.mocked(fulfillGroupEntry).mockResolvedValueOnce({ mode: 'pause', cards: [{ id: 99, name: 'Final Card' }] });

    mockDraftMeta(mockClient);
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ cnt: 23 }]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ card_id: 99 }]));
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ name: 'Final Card' }]));
    // INSERT success
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
    // Copy check
    mockClient.execute.mockResolvedValueOnce(createQueryResult([{ picked_count: 1, qty: 1 }]));
    // UPDATE drafts SET phase = 'playing'
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 1));
    // Clear all queues
    mockClient.execute.mockResolvedValueOnce(createQueryResult([], 0));

    const result = await triggerAutoPickOnDemand(mockClient as never, 'draft-1', 4);

    expect(result.phaseChanged).toBe(true);
    expect(result.newPhase).toBe('playing');
    expect(result.pickedCard?.cardName).toBe('Final Card');
  });
});
