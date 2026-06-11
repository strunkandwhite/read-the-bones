import { describe, expect, it } from 'vitest';
import { derivePickSeat, getTotalPicks, getNextPick, buildPickMatrix } from './snakeDraft';

describe('derivePickSeat', () => {
  describe('single-pick region (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('round 1 forward: seats 1,2,3,4', () => {
      expect(derivePickSeat(1, opts)).toMatchObject({ seat: 1, round: 1 });
      expect(derivePickSeat(2, opts)).toMatchObject({ seat: 2, round: 1 });
      expect(derivePickSeat(3, opts)).toMatchObject({ seat: 3, round: 1 });
      expect(derivePickSeat(4, opts)).toMatchObject({ seat: 4, round: 1 });
    });

    it('round 2 reverse: seats 4,3,2,1', () => {
      expect(derivePickSeat(5, opts)).toMatchObject({ seat: 4, round: 2 });
      expect(derivePickSeat(6, opts)).toMatchObject({ seat: 3, round: 2 });
      expect(derivePickSeat(7, opts)).toMatchObject({ seat: 2, round: 2 });
      expect(derivePickSeat(8, opts)).toMatchObject({ seat: 1, round: 2 });
    });

    it('round 3 forward: seats 1,2,3,4', () => {
      expect(derivePickSeat(9, opts)).toMatchObject({ seat: 1, round: 3 });
      expect(derivePickSeat(12, opts)).toMatchObject({ seat: 4, round: 3 });
    });

    it('round 4 reverse: seats 4,3,2,1', () => {
      expect(derivePickSeat(13, opts)).toMatchObject({ seat: 4, round: 4 });
      expect(derivePickSeat(16, opts)).toMatchObject({ seat: 1, round: 4 });
    });

    it('all single picks have isDoublePick = false', () => {
      for (let i = 1; i <= 16; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(false);
      }
    });
  });

  describe('double-pick region (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('round 5 forward (double): seats 1,1,2,2,3,3,4,4', () => {
      expect(derivePickSeat(17, opts)).toMatchObject({ seat: 1, round: 5, isDoublePick: true });
      expect(derivePickSeat(18, opts)).toMatchObject({ seat: 1, round: 5 });
      expect(derivePickSeat(19, opts)).toMatchObject({ seat: 2, round: 5 });
      expect(derivePickSeat(20, opts)).toMatchObject({ seat: 2, round: 5 });
      expect(derivePickSeat(21, opts)).toMatchObject({ seat: 3, round: 5 });
      expect(derivePickSeat(22, opts)).toMatchObject({ seat: 3, round: 5 });
      expect(derivePickSeat(23, opts)).toMatchObject({ seat: 4, round: 5 });
      expect(derivePickSeat(24, opts)).toMatchObject({ seat: 4, round: 5 });
    });

    it('round 5 has 8 double picks (all 4 seats x 2)', () => {
      for (let i = 17; i <= 24; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(true);
      }
    });
  });

  describe('every seat gets exactly 6 picks (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('every seat gets exactly 6 picks', () => {
      const counts = new Map<number, number>();
      for (let i = 1; i <= 24; i++) {
        const { seat } = derivePickSeat(i, opts);
        counts.set(seat, (counts.get(seat) ?? 0) + 1);
      }
      for (let s = 1; s <= 4; s++) {
        expect(counts.get(s)).toBe(6);
      }
    });
  });

  describe('10 seats, 45 picks each', () => {
    const opts = { numSeats: 10, picksPerPlayer: 45 };

    it('pick 1 is seat 1 round 1', () => {
      expect(derivePickSeat(1, opts)).toMatchObject({ seat: 1, round: 1 });
    });

    it('pick 10 is seat 10 round 1', () => {
      expect(derivePickSeat(10, opts)).toMatchObject({ seat: 10, round: 1 });
    });

    it('pick 11 is seat 10 round 2 (reverse)', () => {
      expect(derivePickSeat(11, opts)).toMatchObject({ seat: 10, round: 2 });
    });

    it('pick 230 is last single pick', () => {
      const result = derivePickSeat(230, opts);
      expect(result.isDoublePick).toBe(false);
    });

    it('pick 231 is first double pick', () => {
      const result = derivePickSeat(231, opts);
      expect(result.isDoublePick).toBe(true);
      expect(result.round).toBe(24);
    });

    it('total picks = 450', () => {
      expect(getTotalPicks(10, 45)).toBe(450);
    });

    it('every seat gets exactly 45 picks', () => {
      const counts = new Map<number, number>();
      for (let i = 1; i <= 450; i++) {
        const { seat } = derivePickSeat(i, opts);
        counts.set(seat, (counts.get(seat) ?? 0) + 1);
      }
      for (let s = 1; s <= 10; s++) {
        expect(counts.get(s)).toBe(45);
      }
    });
  });

  describe('4 seats, 8 picks each — reverse double-pick round', () => {
    // With 8 picks per player: doublePickRounds = floor(8/4) = 2
    // Rounds 1-4: single-pick (picks 1-16)
    // Round 5 (odd = forward):  double-picks 17-24 → seats 1,1,2,2,3,3,4,4
    // Round 6 (even = reverse): double-picks 25-32 → seats 4,4,3,3,2,2,1,1
    const opts = { numSeats: 4, picksPerPlayer: 8 };

    it('round 5 double-pick goes forward: 1,1,2,2,3,3,4,4', () => {
      expect(derivePickSeat(17, opts)).toMatchObject({ seat: 1, round: 5, isDoublePick: true });
      expect(derivePickSeat(18, opts)).toMatchObject({ seat: 1, round: 5, isDoublePick: true });
      expect(derivePickSeat(19, opts)).toMatchObject({ seat: 2, round: 5 });
      expect(derivePickSeat(20, opts)).toMatchObject({ seat: 2, round: 5 });
      expect(derivePickSeat(21, opts)).toMatchObject({ seat: 3, round: 5 });
      expect(derivePickSeat(22, opts)).toMatchObject({ seat: 3, round: 5 });
      expect(derivePickSeat(23, opts)).toMatchObject({ seat: 4, round: 5 });
      expect(derivePickSeat(24, opts)).toMatchObject({ seat: 4, round: 5 });
    });

    it('round 6 double-pick reverses: 4,4,3,3,2,2,1,1', () => {
      expect(derivePickSeat(25, opts)).toMatchObject({ seat: 4, round: 6, isDoublePick: true });
      expect(derivePickSeat(26, opts)).toMatchObject({ seat: 4, round: 6 });
      expect(derivePickSeat(27, opts)).toMatchObject({ seat: 3, round: 6 });
      expect(derivePickSeat(28, opts)).toMatchObject({ seat: 3, round: 6 });
      expect(derivePickSeat(29, opts)).toMatchObject({ seat: 2, round: 6 });
      expect(derivePickSeat(30, opts)).toMatchObject({ seat: 2, round: 6 });
      expect(derivePickSeat(31, opts)).toMatchObject({ seat: 1, round: 6 });
      expect(derivePickSeat(32, opts)).toMatchObject({ seat: 1, round: 6 });
    });
  });

  describe('2 seats, 10 picks each (no trailing single)', () => {
    const opts = { numSeats: 2, picksPerPlayer: 10 };

    it('has 6 single rounds (picks 1-12) then 2 double rounds (picks 13-20)', () => {
      // Single region: picks 1-12
      for (let i = 1; i <= 12; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(false);
      }
      // Double region: picks 13-20
      for (let i = 13; i <= 20; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(true);
      }
    });

    it('every seat gets exactly 10 picks', () => {
      const counts = new Map<number, number>();
      for (let i = 1; i <= 20; i++) {
        const { seat } = derivePickSeat(i, opts);
        counts.set(seat, (counts.get(seat) ?? 0) + 1);
      }
      expect(counts.get(1)).toBe(10);
      expect(counts.get(2)).toBe(10);
    });

    it('pick 21 throws (exceeds total)', () => {
      expect(() => derivePickSeat(21, opts)).toThrow();
    });
  });
});

describe('getTotalPicks', () => {
  it('returns numSeats * picksPerPlayer', () => {
    expect(getTotalPicks(10, 45)).toBe(450);
    expect(getTotalPicks(4, 6)).toBe(24);
    expect(getTotalPicks(8, 40)).toBe(320);
  });
});

describe('getNextPick', () => {
  it('returns pick 1, seat 1 when no picks have been made', () => {
    const result = getNextPick(0, 4, 6);
    expect(result).toEqual({ pickNumber: 1, seat: 1 });
  });

  it('returns correct next pick mid-round', () => {
    // 4 seats, 6 picks each. After 2 picks, next is pick 3, seat 3.
    const result = getNextPick(2, 4, 6);
    expect(result).not.toBeNull();
    expect(result!.pickNumber).toBe(3);
    expect(result!.seat).toBe(3);
  });

  it('snakes direction in round 2', () => {
    // After 4 picks (round 1 complete), pick 5 = round 2 reverse, seat 4
    const result = getNextPick(4, 4, 6);
    expect(result).not.toBeNull();
    expect(result!.pickNumber).toBe(5);
    expect(result!.seat).toBe(4);
  });

  it('returns null when all picks are made', () => {
    const total = getTotalPicks(4, 6);
    const result = getNextPick(total, 4, 6);
    expect(result).toBeNull();
  });

  it('returns null when currentPickCount exceeds total', () => {
    const result = getNextPick(100, 4, 6);
    expect(result).toBeNull();
  });

  it('handles pick 0 boundary (first pick of small draft)', () => {
    const result = getNextPick(0, 2, 2);
    expect(result).toEqual({ pickNumber: 1, seat: 1 });
  });

  it('handles last pick boundary', () => {
    const total = getTotalPicks(4, 6);
    const result = getNextPick(total - 1, 4, 6);
    expect(result).not.toBeNull();
    expect(result!.pickNumber).toBe(total);
  });
});

describe('buildPickMatrix', () => {
  it('returns correct grid for a 2-seat, 2-pick draft', () => {
    const matrix = buildPickMatrix(2, 2);
    // 2 seats * 2 picks = 4 total picks, 2 rounds
    expect(matrix).toHaveLength(2);

    // Round 1: forward (seats 1, 2)
    expect(matrix[0].round).toBe(1);
    expect(matrix[0].isForward).toBe(true);
    expect(matrix[0].seats).toEqual([1, 2]);

    // Round 2: backward (seats 2, 1)
    expect(matrix[1].round).toBe(2);
    expect(matrix[1].isForward).toBe(false);
    expect(matrix[1].seats).toEqual([2, 1]);
  });

  it('returns empty array for 0 picks per player', () => {
    const matrix = buildPickMatrix(4, 0);
    expect(matrix).toEqual([]);
  });

  it('all seats appear in each single-pick round', () => {
    const matrix = buildPickMatrix(4, 6);
    for (const round of matrix) {
      if (!round.isDoublePick) {
        const uniqueSeats = new Set(round.seats);
        expect(uniqueSeats.size).toBe(4);
      }
    }
  });

  it('total picks across all rounds equals numSeats * picksPerPlayer', () => {
    const matrix = buildPickMatrix(4, 8);
    const totalPicks = matrix.reduce((sum, round) => sum + round.seats.length, 0);
    expect(totalPicks).toBe(4 * 8);
  });

  it('rounds are sorted in ascending order', () => {
    const matrix = buildPickMatrix(4, 6);
    for (let i = 1; i < matrix.length; i++) {
      expect(matrix[i].round).toBeGreaterThan(matrix[i - 1].round);
    }
  });
});
