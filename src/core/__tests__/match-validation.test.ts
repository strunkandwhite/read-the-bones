import { describe, it, expect } from 'vitest';
import { validateMatchResult } from '../match-validation';

describe('validateMatchResult', () => {
  it('rejects when neither side has 2 wins', () => {
    expect(validateMatchResult(1, 0)).toBe('At least one side must have 2 wins');
    expect(validateMatchResult(1, 1)).toBe('At least one side must have 2 wins');
    expect(validateMatchResult(0, 0)).toBe('At least one side must have 2 wins');
  });

  it('accepts valid best-of-3 results', () => {
    expect(validateMatchResult(2, 0)).toBeNull();
    expect(validateMatchResult(2, 1)).toBeNull();
    expect(validateMatchResult(0, 2)).toBeNull();
    expect(validateMatchResult(1, 2)).toBeNull();
  });

  it('rejects wins or losses > 2', () => {
    expect(validateMatchResult(3, 1)).toBe('Wins and losses must be between 0 and 2');
    expect(validateMatchResult(1, 3)).toBe('Wins and losses must be between 0 and 2');
    expect(validateMatchResult(3, 0)).toBe('Wins and losses must be between 0 and 2');
    expect(validateMatchResult(0, 3)).toBe('Wins and losses must be between 0 and 2');
  });

  it('rejects negative values', () => {
    expect(validateMatchResult(-1, 2)).toBe('Wins and losses must be between 0 and 2');
    expect(validateMatchResult(2, -1)).toBe('Wins and losses must be between 0 and 2');
  });

  it('rejects 2-2 — impossible in best-of-3', () => {
    expect(validateMatchResult(2, 2)).toBe('Result 2-2 is impossible in best-of-3');
  });
});
