# Head-to-Head Match Matrix & Standings Tiebreakers

## Problem

Players can report their own match results and see aggregate standings (Match W-L, Game W-L), but they cannot see individual match results between other players. The standings table lacks standard MTG tiebreakers (OMW%, OGW%). The match reporting form is a separate section disconnected from the results display.

## Solution

Replace the match reporting form with an interactive cross-table matrix that shows every pairwise match result. Players edit their own cells to report results. Add OMW% and OGW% tiebreaker columns to the standings table. Display standings and the matrix side by side on desktop, stacked vertically on narrow screens.

## Design

### Layout & Responsiveness

**Desktop (>768px):** Side by side. Standings table on the left (~35% width), match matrix on the right (~65%).

**Narrow (<768px):** Vertical stack. Standings on top, matrix below. The matrix scrolls horizontally if needed — a 10-column grid cannot compress further.

The current "Report Match Results" section is removed. Its functionality moves into the matrix.

### Standings Table

Add two columns to the existing table:

| Player | Match W-L | Game W-L | OMW% | OGW% |

**Sort order:** Match wins descending, OMW% as first tiebreaker, OGW% as second tiebreaker. This matches WotC Swiss tournament standard.

**OMW% (Opponent Match Win %):** Average match win percentage across all opponents played. Each opponent's match win percentage is floored at 33% (WotC floor rule).

**OGW% (Opponent Game Win %):** Average game win percentage across all opponents played. Same 33% floor per opponent.

**Display format:** One decimal place (e.g., "51.2%").

### Match Results Matrix

**Grid structure:** Rows and columns represent seats in seat order (1-N). Row and column headers show player display names. Diagonal cells (self vs self) show an em dash (—).

**Cell display (from the row player's perspective):**

| State | Appearance |
|-------|------------|
| Win | Green text: "2-0" or "2-1" |
| Loss | Red text: "0-2" or "1-2" |
| Unplayed (not yours) | Muted dot (·) |
| Unplayed (yours) | Dashed border indicating editability |

**Symmetry:** The matrix is symmetric with inverted perspective. If row A vs column B shows "2-1" (green), row B vs column A shows "1-2" (red). Both cells update when one result is entered.

**Current player highlight:** Light blue background on the authenticated player's row.

### Inline Editing

Players edit only their own cells:

1. Click an unplayed cell in your row
2. Cell becomes a focused text input
3. Type a result (e.g., "2-1")
4. Validation accepts only valid best-of-3 results: `X-Y` where X and Y are integers 0-2 and at least one equals 2
5. Enter or blur saves — optimistic UI update, error toast on failure
6. Escape cancels

Players can also click a previously reported cell in their row to correct it (existing `INSERT OR REPLACE` behavior).

## Data & API Changes

### Standings API (`GET /api/drafts/[id]/standings`)

Add `omwPct` and `ogwPct` fields to each standing object. Compute server-side in `getStandings()`:

```typescript
// Per standing entry
{
  seat: number | "[REDACTED]",
  matchWins: number,
  matchLosses: number,
  gameWins: number,
  gameLosses: number,
  omwPct: number | null,  // null if no matches played
  ogwPct: number | null
}
```

**Calculation (in `aggregateMatchRecords` or a new helper):**

For each player P:
1. Collect all opponents O that P has played
2. For each opponent O, compute their match win % = matchWins / (matchWins + matchLosses), floored at 0.33
3. OMW% = average of all opponents' floored match win percentages
4. Repeat with game wins/losses for OGW%

### Match Reporting (`POST /api/drafts/[id]/match`)

No changes. The matrix calls the same endpoint with the same payload: `{ opponent_seat, wins, losses }`.

### No New Endpoints

The existing standings response already includes a `matches` array with every pairwise result — sufficient for rendering the matrix.

### Polling

Standings already refetch when `matchCount` changes via live polling. The matrix stays in sync through the same mechanism.

## Component Architecture

### Modified

- **`StandingsSection.tsx`** — Adds the side-by-side layout wrapper with responsive breakpoint. Renders both `StandingsTable` and `MatchMatrix`.
- **`StandingsTable`** (within StandingsSection) — Adds OMW% and OGW% columns.

### New

- **`MatchMatrix.tsx`** — Cross-table grid component. Receives the matches array, seat names map, and current player's seat. Renders cells with win/loss/unplayed states. Handles inline editing and calls the existing match POST endpoint.

### Removed

- **`MatchReporting.tsx`** — Fully replaced by the matrix's editable cells.

### Data Flow

`StandingsSection` fetches standings as it does today, then passes `matches` to `MatchMatrix` and `standings` to `StandingsTable`. When a match is reported via the matrix, it triggers the existing `onMatchReported` callback, which refetches standings and updates both components.

## Privacy

Opted-out seats show `"[REDACTED]"` in standings (existing behavior). In the matrix, redacted seats show abbreviated labels and their match cells display results without identifying the player beyond the seat label.
