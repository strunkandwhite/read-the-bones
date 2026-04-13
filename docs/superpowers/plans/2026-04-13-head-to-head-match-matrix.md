# Head-to-Head Match Matrix Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-table match results matrix with inline editing and OMW%/OGW% tiebreaker columns to the live draft pod view.

**Architecture:** Server-side: add OMW%/OGW% calculation to `getStandings()`, tighten match API validation. Client-side: new `MatchMatrix` component with inline editing, updated `StandingsTable` with tiebreaker columns, responsive side-by-side layout in `StandingsSection`. Remove `MatchReporting` component.

**Tech Stack:** Next.js, React, TypeScript, Turso (libsql), Vitest, Playwright

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/db/queries/matches.ts` | Modify | Add `computeTiebreakers()` helper |
| `src/core/db/queries/picks.ts` | Modify | Wire tiebreakers into `getStandings()`, update sort, include all seats |
| `src/app/api/drafts/[id]/match/route.ts` | Modify | Add best-of-3 completion validation |
| `src/app/components/draft-board/MatchMatrix.tsx` | Create | Cross-table grid with inline editing |
| `src/app/components/draft-board/StandingsSection.tsx` | Modify | Side-by-side layout, OMW%/OGW% columns, remove MatchReporting |
| `src/app/components/draft-board/MatchReporting.tsx` | Delete | Replaced by MatchMatrix |
| `src/core/__tests__/tiebreakers.test.ts` | Create | Unit tests for OMW%/OGW% calculation |
| `src/core/match-validation.ts` | Create | Extracted match result validation logic |
| `src/core/__tests__/match-validation.test.ts` | Create | Unit tests for match validation |
| `e2e/flows/match-matrix.spec.ts` | Create | E2E tests for matrix rendering and inline editing |

---

## Chunk 1: Server-Side — Tiebreakers & Validation

### Task 1: OMW%/OGW% Calculation

**Files:**
- Create: `src/core/__tests__/tiebreakers.test.ts`
- Modify: `src/core/db/queries/matches.ts`
- Modify: `src/core/db/queries/picks.ts:242-328`

- [ ] **Step 1: Write failing tests for tiebreaker calculation**

Create `src/core/__tests__/tiebreakers.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { computeTiebreakers } from '../db/queries/matches';
import type { SeatRecord } from '../db/queries/matches';

describe('computeTiebreakers', () => {
  it('returns null for seats with no matches', () => {
    const stats = new Map<number, SeatRecord>();
    const matches: Array<{ seat1: number; seat2: number; seat1Wins: number; seat2Wins: number }> = [];
    const result = computeTiebreakers(stats, matches);
    expect(result.size).toBe(0);
  });

  it('computes OMW% as average of opponents match win rates', () => {
    // Seat 1 beat seat 2 (2-0) and lost to seat 3 (0-2)
    // Seat 2: 0 match wins, 1 match loss → MW% = max(0/1, 1/3) = 1/3
    // Seat 3: 1 match win, 0 match losses → MW% = max(1/1, 1/3) = 1.0
    // Seat 1 OMW% = (1/3 + 1.0) / 2 = 0.6667
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 1, matchLosses: 1, gameWins: 2, gameLosses: 2 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
      [3, { matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 },
      { seat1: 1, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
    ];
    const result = computeTiebreakers(stats, matches);
    expect(result.get(1)!.omwPct).toBeCloseTo(2 / 3, 4);
  });

  it('floors opponent win rate at 1/3', () => {
    // Seat 1 beat seat 2 (2-0). Seat 2 has 0 wins, 1 loss → MW% floored to 1/3
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 1, matchLosses: 0, gameWins: 2, gameLosses: 0 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 0 },
    ];
    const result = computeTiebreakers(stats, matches);
    expect(result.get(1)!.omwPct).toBeCloseTo(1 / 3, 4);
  });

  it('computes OGW% similarly with game win rates', () => {
    // Seat 1 beat seat 2 (2-1) and beat seat 3 (2-0)
    // Seat 2: 1 game win, 2 game losses → GW% = max(1/3, 1/3) = 1/3
    // Seat 3: 0 game wins, 2 game losses → GW% = max(0/2, 1/3) = 1/3
    // Seat 1 OGW% = (1/3 + 1/3) / 2 = 1/3
    const stats = new Map<number, SeatRecord>([
      [1, { matchWins: 2, matchLosses: 0, gameWins: 4, gameLosses: 1 }],
      [2, { matchWins: 0, matchLosses: 1, gameWins: 1, gameLosses: 2 }],
      [3, { matchWins: 0, matchLosses: 1, gameWins: 0, gameLosses: 2 }],
    ]);
    const matches = [
      { seat1: 1, seat2: 2, seat1Wins: 2, seat2Wins: 1 },
      { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 0 },
    ];
    const result = computeTiebreakers(stats, matches);
    expect(result.get(1)!.ogwPct).toBeCloseTo(1 / 3, 4);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/__tests__/tiebreakers.test.ts`
Expected: FAIL — `computeTiebreakers` does not exist

- [ ] **Step 3: Implement computeTiebreakers in matches.ts**

Add to `src/core/db/queries/matches.ts` after the existing exports:

```typescript
export interface Tiebreakers {
  omwPct: number;
  ogwPct: number;
}

/**
 * Compute OMW% and OGW% tiebreakers per WotC Swiss tournament rules.
 * Each opponent's win rate is floored at 1/3.
 */
export function computeTiebreakers(
  stats: Map<number, SeatRecord>,
  matches: Array<{ seat1: number; seat2: number; seat1Wins: number; seat2Wins: number }>
): Map<number, Tiebreakers> {
  // Build adjacency: for each seat, collect opponent seats
  const opponents = new Map<number, Set<number>>();
  for (const m of matches) {
    if (!opponents.has(m.seat1)) opponents.set(m.seat1, new Set());
    if (!opponents.has(m.seat2)) opponents.set(m.seat2, new Set());
    opponents.get(m.seat1)!.add(m.seat2);
    opponents.get(m.seat2)!.add(m.seat1);
  }

  const FLOOR = 1 / 3;
  const result = new Map<number, Tiebreakers>();

  for (const [seat, opps] of opponents) {
    let omwSum = 0;
    let ogwSum = 0;
    let count = 0;

    for (const opp of opps) {
      const oppStats = stats.get(opp);
      if (!oppStats) continue;

      const oppMatches = oppStats.matchWins + oppStats.matchLosses;
      const oppMwPct = oppMatches > 0 ? oppStats.matchWins / oppMatches : 0;
      omwSum += Math.max(oppMwPct, FLOOR);

      const oppGames = oppStats.gameWins + oppStats.gameLosses;
      const oppGwPct = oppGames > 0 ? oppStats.gameWins / oppGames : 0;
      ogwSum += Math.max(oppGwPct, FLOOR);

      count++;
    }

    result.set(seat, {
      omwPct: count > 0 ? omwSum / count : 0,
      ogwPct: count > 0 ? ogwSum / count : 0,
    });
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/__tests__/tiebreakers.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Wire tiebreakers into getStandings()**

Modify `src/core/db/queries/picks.ts`:

1. Add import: `import { computeTiebreakers } from './matches';`
2. Update `StandingsEntry` interface (around line 242) — add `omwPct: number | null` and `ogwPct: number | null`
3. After `aggregateMatchRecords()` call (around line 288), call `computeTiebreakers(stats, matchRecords)`
4. When building each `StandingsEntry`, look up tiebreakers for that seat
5. Update sort (around line 313): primary = matchWins DESC, secondary = omwPct DESC (nulls last), tertiary = ogwPct DESC (nulls last)
6. After building sorted standings, append any seats (1..numSeats) that have no matches — these get `omwPct: null, ogwPct: null` and sort last

Note: `getStandings()` currently doesn't know `numSeats`. Add it as a parameter: `getStandings(draftId, numSeats, optedOutSeats?)`. Before changing the signature, grep for all callers: `grep -r "getStandings" src/` to find every call site that needs updating. The caller in `standings/route.ts` will need to fetch `numSeats` from the draft record. The existing `stats` variable in `getStandings()` (line 289) is already `Map<number, SeatRecord>` — pass it directly to `computeTiebreakers`.

Note: `MatchRecord` is already defined and exported from `picks.ts` (line 250). Reuse it — do not re-export from `matches.ts`. The `computeTiebreakers` function accepts `Array<{ seat1, seat2, seat1Wins, seat2Wins }>` which matches the existing `MatchRecord` shape.

- [ ] **Step 6: Update standings API route**

Modify `src/app/api/drafts/[id]/standings/route.ts`:
- Fetch draft metadata to get `numSeats` (query `drafts` table for the draft)
- Pass `numSeats` to `getStandings(id, numSeats)`

- [ ] **Step 7: Run all tests**

Run: `pnpm test`
Expected: PASS — existing tests should still pass since the new fields are additive

- [ ] **Step 8: Commit**

```bash
git add src/core/db/queries/matches.ts src/core/db/queries/picks.ts src/app/api/drafts/[id]/standings/route.ts src/core/__tests__/tiebreakers.test.ts
git commit -m "Add OMW%/OGW% tiebreaker calculation to standings"
```

---

### Task 2: Match API Validation

**Files:**
- Modify: `src/app/api/drafts/[id]/match/route.ts:25-31`

- [ ] **Step 1: Write failing test for validation**

Extract validation into `src/core/` so it's testable without crossing the core→app boundary. Create `src/core/__tests__/match-validation.test.ts`:

```typescript
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
  });

  it('rejects negative values', () => {
    expect(validateMatchResult(-1, 2)).toBe('Wins and losses must be between 0 and 2');
  });
});
```

- [ ] **Step 2: Create validation module**

Create `src/core/match-validation.ts`:

```typescript
/** Returns error message or null if valid */
export function validateMatchResult(wins: number, losses: number): string | null {
  if (wins < 0 || wins > 2 || losses < 0 || losses > 2) {
    return 'Wins and losses must be between 0 and 2';
  }
  if (wins !== 2 && losses !== 2) {
    return 'At least one side must have 2 wins';
  }
  return null;
}
```

- [ ] **Step 3: Wire validation into route handler**

Modify `src/app/api/drafts/[id]/match/route.ts`:
1. Import `validateMatchResult` from `@/core/match-validation`
2. Replace the existing `wins > 2 || losses > 2` check (around line 29) with:
```typescript
const validationError = validateMatchResult(wins, losses);
if (validationError) {
  return NextResponse.json({ error: validationError }, { status: 400 });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/core/__tests__/match-validation.test.ts`
Expected: PASS

Run: `pnpm test`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/core/match-validation.ts src/app/api/drafts/[id]/match/route.ts src/core/__tests__/match-validation.test.ts
git commit -m "Tighten match API validation to require completed best-of-3 results"
```

---

## Chunk 2: Client-Side — MatchMatrix Component

### Task 3: MatchMatrix Component (Display Only)

**Files:**
- Create: `src/app/components/draft-board/MatchMatrix.tsx`

**Style note:** The code snippets below use inline styles for clarity. The existing codebase uses Tailwind CSS classes — convert all inline styles to Tailwind equivalents during implementation (e.g., `style={{ color: '#555' }}` → `className="text-gray-600"`). Add `data-testid` attributes to key elements (matrix table, editable cells, input field) for e2e test selectors.

- [ ] **Step 1: Define component props and types**

Create `src/app/components/draft-board/MatchMatrix.tsx`:

```typescript
'use client';

import { useState, useCallback } from 'react';

interface MatchRecord {
  seat1: number;
  seat2: number;
  seat1Wins: number;
  seat2Wins: number;
}

interface MatchMatrixProps {
  matches: MatchRecord[];
  numSeats: number;
  seatNames: Record<string, string>;
  mySeat: number | null;
  token: string | null;
  draftId: string;
  phase: string;
  onMatchReported: (data: { mySeat: number; opponent: number; wins: number; losses: number }) => void;
  onMatchReverted: () => void;
}
```

- [ ] **Step 2: Build the match lookup and read-only grid**

Continue in `MatchMatrix.tsx`:

```typescript
function getMatchResult(
  matches: MatchRecord[],
  rowSeat: number,
  colSeat: number
): { myWins: number; theirWins: number } | null {
  for (const m of matches) {
    if (
      (m.seat1 === rowSeat && m.seat2 === colSeat) ||
      (m.seat1 === colSeat && m.seat2 === rowSeat)
    ) {
      const myWins = m.seat1 === rowSeat ? m.seat1Wins : m.seat2Wins;
      const theirWins = m.seat1 === rowSeat ? m.seat2Wins : m.seat1Wins;
      return { myWins, theirWins };
    }
  }
  return null;
}

function truncateName(name: string, max = 8): string {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

function CellDisplay({ myWins, theirWins }: { myWins: number; theirWins: number }) {
  const won = myWins > theirWins;
  return (
    <span style={{ color: won ? '#22c55e' : '#ef4444' }}>
      {myWins}-{theirWins}
    </span>
  );
}
```

- [ ] **Step 3: Render the full grid (read-only)**

```typescript
export function MatchMatrix({ matches, numSeats, seatNames, mySeat, token, draftId, phase, onMatchReported, onMatchReverted }: MatchMatrixProps) {
  const seats = Array.from({ length: numSeats }, (_, i) => i + 1);
  const getName = (seat: number) => truncateName(seatNames[String(seat)] || `Seat ${seat}`);
  const canEdit = mySeat !== null && token !== null && (phase === 'playing' || phase === 'complete');

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.8rem', width: '100%' }}>
        <thead>
          <tr>
            <th />
            {seats.map(col => (
              <th key={col} style={{ padding: '4px 6px', fontWeight: 'normal', color: '#9ca3af', whiteSpace: 'nowrap' }}>
                {getName(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {seats.map(row => (
            <tr key={row} style={{ backgroundColor: row === mySeat ? 'rgba(59,130,246,0.08)' : undefined }}>
              <td style={{ padding: '4px 6px', color: '#9ca3af', whiteSpace: 'nowrap', fontWeight: row === mySeat ? 600 : 'normal' }}>
                {getName(row)}
              </td>
              {seats.map(col => (
                <td key={col} style={{ padding: '4px 6px', textAlign: 'center', borderBottom: '1px solid #222' }}>
                  {row === col ? (
                    <span style={{ color: '#444' }}>—</span>
                  ) : (
                    <MatchCell
                      matches={matches}
                      rowSeat={row}
                      colSeat={col}
                      isMyRow={row === mySeat && canEdit}
                      draftId={draftId}
                      token={token}
                      mySeat={mySeat}
                      onMatchReported={onMatchReported}
                      onMatchReverted={onMatchReverted}
                    />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Implement MatchCell with read-only display**

```typescript
function MatchCell({
  matches, rowSeat, colSeat, isMyRow, draftId, token, mySeat,
  onMatchReported, onMatchReverted
}: {
  matches: MatchRecord[];
  rowSeat: number;
  colSeat: number;
  isMyRow: boolean;
  draftId: string;
  token: string | null;
  mySeat: number | null;
  onMatchReported: (data: { mySeat: number; opponent: number; wins: number; losses: number }) => void;
  onMatchReverted: () => void;
}) {
  const result = getMatchResult(matches, rowSeat, colSeat);

  if (result) {
    return <CellDisplay myWins={result.myWins} theirWins={result.theirWins} />;
  }

  // Unplayed — show editable affordance for own row, dot for others
  if (!isMyRow) {
    return <span style={{ color: '#555' }}>·</span>;
  }

  return <span style={{ color: '#555', border: '1px dashed #555', padding: '0 4px', cursor: 'pointer' }}>·</span>;
}
```

- [ ] **Step 5: Verify component compiles**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/components/draft-board/MatchMatrix.tsx
git commit -m "Add read-only MatchMatrix component with cell display logic"
```

---

### Task 4: Inline Editing in MatchMatrix

**Files:**
- Modify: `src/app/components/draft-board/MatchMatrix.tsx`

- [ ] **Step 1: Add editing state and input handling to MatchCell**

Update the `MatchCell` component to support inline editing. When `isMyRow` and the user clicks an unplayed (or played) cell, show a text input:

```typescript
function MatchCell({ matches, rowSeat, colSeat, isMyRow, draftId, token, mySeat, onMatchReported, onMatchReverted }: { /* same props */ }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const result = getMatchResult(matches, rowSeat, colSeat);
  const previouslySaved = result !== null;

  const handleClick = useCallback(() => {
    if (!isMyRow) return;
    setEditing(true);
    setValue(result ? `${result.myWins}-${result.theirWins}` : '');
    setError(null);
  }, [isMyRow, result]);

  const handleSave = useCallback(async () => {
    const match = value.match(/^([012])-([012])$/);
    if (!match) { setError('Use format: 2-1'); return; }
    const wins = parseInt(match[1]);
    const losses = parseInt(match[2]);
    if (wins !== 2 && losses !== 2) { setError('One side must have 2 wins'); return; }

    setSaving(true);
    setError(null);

    // Optimistic update for new reports only
    if (!previouslySaved && mySeat !== null) {
      onMatchReported({ mySeat, opponent: colSeat, wins, losses });
    }

    try {
      const res = await fetch(`/api/drafts/${draftId}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Seat-Token': token! },
        body: JSON.stringify({ opponent_seat: colSeat, wins, losses }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to save');
      }
      setEditing(false);
      // Re-reports: trigger full refetch
      if (previouslySaved) onMatchReverted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      // Revert optimistic update
      if (!previouslySaved) onMatchReverted();
    } finally {
      setSaving(false);
    }
  }, [value, previouslySaved, mySeat, colSeat, draftId, token, onMatchReported, onMatchReverted]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') { setEditing(false); setError(null); }
  }, [handleSave]);

  if (editing) {
    return (
      <div>
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleSave}
          disabled={saving}
          autoFocus
          style={{
            width: '3em', textAlign: 'center', fontSize: '0.8rem',
            background: '#1a1a2e', color: '#e0e0e0', border: '1px solid #4a9',
            borderRadius: '2px', padding: '1px 2px',
          }}
          placeholder="2-1"
        />
        {error && <div style={{ color: '#ef4444', fontSize: '0.65rem', marginTop: '2px' }}>{error}</div>}
      </div>
    );
  }

  if (result) {
    return (
      <span onClick={handleClick} style={{ cursor: isMyRow ? 'pointer' : 'default' }}>
        <CellDisplay myWins={result.myWins} theirWins={result.theirWins} />
      </span>
    );
  }

  if (!isMyRow) {
    return <span style={{ color: '#555' }}>·</span>;
  }

  return (
    <span onClick={handleClick} style={{ color: '#555', border: '1px dashed #555', padding: '0 4px', cursor: 'pointer' }}>·</span>
  );
}
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/components/draft-board/MatchMatrix.tsx
git commit -m "Add inline editing to MatchMatrix cells with validation and optimistic updates"
```

---

## Chunk 3: Integration — Layout, Wiring & Cleanup

### Task 5: Update StandingsSection Layout & StandingsTable Columns

**Files:**
- Modify: `src/app/components/draft-board/StandingsSection.tsx`

- [ ] **Step 1: Add OMW%/OGW% to StandingsRow type and table columns**

Update the `StandingsRow` interface (around line 17):

```typescript
interface StandingsRow {
  seat: number;
  displayName: string;
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
  omwPct: number | null;
  ogwPct: number | null;
}
```

Update the standings fetch mapping (around line 120) to include the new fields:

```typescript
omwPct: s.omwPct ?? null,
ogwPct: s.ogwPct ?? null,
```

Add columns to the table header and body:
- Header: add `<th>OMW%</th>` and `<th>OGW%</th>` after Game W-L
- Body: add cells that display `row.omwPct !== null ? (row.omwPct * 100).toFixed(1) + '%' : '—'`

- [ ] **Step 2: Update sort in optimistic handler**

The existing optimistic update handler (around line 145) sorts by matchWins then game win rate. Update to sort by matchWins DESC, then omwPct DESC (nulls last), then ogwPct DESC (nulls last) — matching the server-side sort.

- [ ] **Step 3: Add side-by-side responsive layout**

The flex layout goes inside the `StandingsTable` inner function component (not the exported `StandingsSection`), since `StandingsTable` is where both the standings table and the former `MatchReporting` currently render. Replace the `MatchReporting` block with the flex container wrapping both the standings `<table>` and `<MatchMatrix>`. Use Tailwind classes (`className="flex gap-6 flex-wrap"`, `className="flex-1 min-w-[280px]"`, etc.) instead of inline styles:

```typescript
// When phase is "playing" or "complete"
<div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
  <div style={{ flex: '1 1 280px', minWidth: '280px' }}>
    {/* StandingsTable */}
  </div>
  <div style={{ flex: '2 1 400px', minWidth: '300px' }}>
    <MatchMatrix
      matches={matches}
      numSeats={board.numSeats}
      seatNames={board.seatNames}
      mySeat={mySeat}
      token={token}
      draftId={draftId}
      phase={status?.phase ?? 'setup'}
      onMatchReported={handleMatchReported}
      onMatchReverted={handleMatchReverted}
    />
  </div>
</div>
```

The `flexWrap: 'wrap'` with `minWidth` values handles the responsive collapse — when the container is too narrow for both, they stack vertically.

- [ ] **Step 4: Pass matches state to MatchMatrix**

The `StandingsTable` already fetches standings which includes `matches`. Lift the `matches` array into state alongside standings so it can be passed to `MatchMatrix`. Update `fetchStandings` to store `response.matches` in a new `matches` state variable.

- [ ] **Step 5: Add handleMatchReverted callback**

The existing `onMatchReported` prop triggers a refetch. Add `handleMatchReverted` that does the same — calls `fetchStandings()` to reload from server. Wire this through as `onMatchReverted` prop to `MatchMatrix`.

- [ ] **Step 6: Remove MatchReporting import and usage**

Remove the `MatchReporting` import and the conditional rendering block (around lines 183-195 in StandingsSection.tsx).

- [ ] **Step 7: Verify typecheck and lint pass**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/app/components/draft-board/StandingsSection.tsx
git commit -m "Integrate MatchMatrix into StandingsSection with responsive layout and OMW%/OGW% columns"
```

---

### Task 6: Delete MatchReporting & Clean Up References

**Files:**
- Delete: `src/app/components/draft-board/MatchReporting.tsx`
- Possibly modify: any file importing MatchReporting

- [ ] **Step 1: Check for other imports of MatchReporting**

Run: `grep -r "MatchReporting" src/`

If only imported in `StandingsSection.tsx` (already removed in Task 5), proceed.

- [ ] **Step 2: Delete MatchReporting.tsx**

```bash
rm src/app/components/draft-board/MatchReporting.tsx
```

- [ ] **Step 3: Run full quality checks**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: PASS — no unused exports or dead references

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "Remove MatchReporting component, replaced by MatchMatrix"
```

---

### Task 7: E2E Tests

**Files:**
- Create: `e2e/flows/match-matrix.spec.ts`
- Modify: `e2e/helpers/mock-api.ts` (add standings/match mock overrides)

E2E tests live in `e2e/flows/` and use `createMockContext` from `e2e/helpers/mock-api.ts`. Key setup requirements:

1. **Override live board fixture** to set `phase: "playing"` (see `live-draft.spec.ts` line ~487 for pattern: `{ ...liveBoardFixture, phase: "playing" }`)
2. **Override standings mock** — the current mock returns `{ standings: [] }` (mock-api.ts line ~245). Add a `MockOverrides.standings` option, or use `page.route()` to provide standings + matches arrays with actual test data
3. **Mock the match POST endpoint** — `POST /api/drafts/*/match` is not currently mocked. Add a route mock that returns `{ success: true, ... }` for save tests

- [ ] **Step 1: Write e2e tests for matrix display and editing**

Create `e2e/flows/match-matrix.spec.ts` with tests covering:

1. **Matrix renders in playing phase** — verify the matrix grid is visible with correct number of rows/columns
2. **Match results display with correct colors** — provide match data in standings mock, verify green/red text
3. **Own row is highlighted** — verify the authenticated player's row has blue background
4. **Unplayed cells in own row show editable affordance** — verify dashed border via `data-testid`
5. **Inline editing flow** — click own unplayed cell, verify input appears, type "2-1", press Enter, verify cell updates
6. **Invalid input rejected** — click cell, type "1-0", press Enter, verify error message
7. **Escape cancels editing** — click cell, type text, press Escape, verify input disappears
8. **OMW% and OGW% columns visible** — verify standings table headers include OMW% and OGW%

Use `data-testid` selectors (e.g., `[data-testid="match-matrix"]`, `[data-testid="match-cell-3-5"]`) added in Task 3.

- [ ] **Step 2: Run e2e tests**

Run: `pnpm test:e2e e2e/flows/match-matrix.spec.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm precommit`
Expected: PASS — typecheck, lint, knip, unit tests, e2e tests all green

- [ ] **Step 4: Commit**

```bash
git add e2e/flows/match-matrix.spec.ts e2e/helpers/mock-api.ts
git commit -m "Add e2e tests for match matrix display and inline editing"
```

---

## Chunk 4: Visual Verification

### Task 8: Manual Visual Check

- [ ] **Step 1: Start dev server and verify in browser**

Run: `pnpm dev`

Navigate to a live draft in playing phase. Verify:
1. Standings table shows OMW% and OGW% columns
2. Match matrix appears to the right of standings on desktop
3. Matrix shows correct player names as row/column headers
4. Own row is highlighted in blue
5. Clicking an unplayed cell in your row opens the inline editor
6. Typing a valid result and pressing Enter saves it
7. Both the cell and the symmetric cell update
8. Standings table updates with new match result
9. Narrowing the browser window causes the layout to stack vertically

- [ ] **Step 2: Take screenshot for verification**

Use Chrome DevTools MCP or `pnpm screenshot` to capture the final state.

- [ ] **Step 3: Kill dev server**
