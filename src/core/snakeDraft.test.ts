import { describe, expect, it } from 'vitest';
import { derivePickSeat, getTotalPicks } from './snakeDraft';

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

    it('all single picks have isDoublePick = false', () => {
      for (let i = 1; i <= 12; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(false);
      }
    });
  });

  describe('double-pick region (4 seats, 6 picks each)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('round 4 reverse (double): seats 4,4,3,3,2,2,1,1', () => {
      expect(derivePickSeat(13, opts)).toMatchObject({ seat: 4, round: 4, isDoublePick: true });
      expect(derivePickSeat(14, opts)).toMatchObject({ seat: 4, round: 4 });
      expect(derivePickSeat(15, opts)).toMatchObject({ seat: 3, round: 4 });
      expect(derivePickSeat(16, opts)).toMatchObject({ seat: 3, round: 4 });
      expect(derivePickSeat(17, opts)).toMatchObject({ seat: 2, round: 4 });
      expect(derivePickSeat(18, opts)).toMatchObject({ seat: 2, round: 4 });
      expect(derivePickSeat(19, opts)).toMatchObject({ seat: 1, round: 4 });
      expect(derivePickSeat(20, opts)).toMatchObject({ seat: 1, round: 4 });
    });

    it('round 4 has 8 double picks (all 4 seats x 2)', () => {
      for (let i = 13; i <= 20; i++) {
        expect(derivePickSeat(i, opts).isDoublePick).toBe(true);
      }
    });
  });

  describe('trailing single-pick round (4 seats, 6 picks each, odd remainder)', () => {
    const opts = { numSeats: 4, picksPerPlayer: 6 };

    it('round 5 forward (trailing single): seats 1,2,3,4', () => {
      expect(derivePickSeat(21, opts)).toMatchObject({ seat: 1, round: 5, isDoublePick: false });
      expect(derivePickSeat(22, opts)).toMatchObject({ seat: 2, round: 5, isDoublePick: false });
      expect(derivePickSeat(23, opts)).toMatchObject({ seat: 3, round: 5, isDoublePick: false });
      expect(derivePickSeat(24, opts)).toMatchObject({ seat: 4, round: 5, isDoublePick: false });
    });

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

    it('pick 220 is last single pick', () => {
      const result = derivePickSeat(220, opts);
      expect(result.isDoublePick).toBe(false);
    });

    it('pick 221 is first double pick', () => {
      const result = derivePickSeat(221, opts);
      expect(result.isDoublePick).toBe(true);
      expect(result.round).toBe(23);
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
});

describe('getTotalPicks', () => {
  it('returns numSeats * picksPerPlayer', () => {
    expect(getTotalPicks(10, 45)).toBe(450);
    expect(getTotalPicks(4, 6)).toBe(24);
    expect(getTotalPicks(8, 40)).toBe(320);
  });
});
