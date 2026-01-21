# Decklist Win Rate Column (Localhost-Only)

## Summary

Add a "Decklist Win Rate" column to the card table that shows the actual win rate of players who maindecked each card. This column is always visible when the app runs on localhost, and hidden in production. Unlike the existing Win Equity and Raw Win Rate columns (which use attribution models to estimate win contribution), this column uses real decklist data — it answers "when someone put this card in their deck, how often did they win?"

## Data

### New field on `CardStats`

```typescript
decklistWinRate?: {
  winRate: number;          // gameWins / (gameWins + gameLosses)
  gameWins: number;         // total games won by seats that maindecked this card
  gameLosses: number;       // total games lost by seats that maindecked this card
  timesMaindecked: number;  // number of distinct (draft, seat) pairs that maindecked this card
  draftsWithData: number;   // distinct drafts where this card was maindecked (not total drafts with data)
}
```

Note: `timesMaindecked` counts deck-seat pairs, not card copies. A seat with `qty=2` of a card counts as one maindeck instance, since we care about "did the player who chose this card win?" not "how many copies were in the deck."

### Build-time calculation (`tursoDataLoader.ts`)

Add a new bulk query (a new database round-trip, placed after the existing match data query) that joins `deck_cards`, `match_events`, and `cards` to compute win stats for all cards at once. This follows the existing pattern — a single query that returns per-card aggregates, attributed back to `CardStats` objects.

Note on opt-outs: The existing `calculateWinEquity` and `calculateRawWinRate` in `tursoDataLoader.ts` do not filter opt-outs — opt-outs are only enforced in the query API layer (`queries/`). This new query also omits opt-out filtering for consistency with the existing build-time calculations. Opt-out filtering remains enforced in API query responses.

Query shape:

```sql
SELECT c.name as card_name,
       COUNT(DISTINCT dc.draft_id || '-' || dc.seat) as times_maindecked,
       COUNT(DISTINCT dc.draft_id) as drafts_with_data,
       SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins
                WHEN me.seat2 = dc.seat THEN me.seat2_wins
                ELSE 0 END) as game_wins,
       SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins
                WHEN me.seat2 = dc.seat THEN me.seat1_wins
                ELSE 0 END) as game_losses
FROM deck_cards dc
JOIN cards c ON dc.card_id = c.card_id
JOIN match_events me ON me.draft_id = dc.draft_id
     AND (me.seat1 = dc.seat OR me.seat2 = dc.seat)
WHERE dc.zone = 'deck'
GROUP BY c.name
```

The result is a `Map<string, DecklistWinRate>` keyed by normalized card name, attributed to `CardStats` the same way `winEquity` and `rawWinRate` are.

### No client-side recalculation

Unlike Win Equity and Raw Win Rate (which recalculate when the user changes draft selection), decklist win rate is **build-time only**. The column always shows the global value across all drafts. This avoids adding deck card data to `draft-data.json` and keeps the data out of the client bundle.

When the user selects a custom draft subset, the column continues to show the all-drafts value. No changes to `generate-draft-data.ts`, `DraftDataFile`, or `PageClient.tsx` recalculation logic.

## UI

### Localhost detection hook

New hook: `src/app/hooks/useIsLocalhost.ts`

```typescript
export function useIsLocalhost(): boolean {
  // useSyncExternalStore for SSR safety
  // getSnapshot: window.location.hostname === 'localhost' || === '127.0.0.1'
  // getServerSnapshot: returns false
}
```

### Column in `CardTable.tsx`

A new column after the existing win rate columns, conditionally included when `isLocalhost` is true. Passed as a prop from `PageClient.tsx`.

Display:
- Cell: `{pct}%` in monospace (same style as Win Equity / Raw Win Rate)
- Tooltip on hover: `{gameWins}W / {gameLosses}L across {timesMaindecked} decks ({draftsWithData} drafts)`
- Empty state: `—` when no decklist win data exists for that card
- Header: "Deck WR" with an `InfoTooltip` explaining it uses actual decklist + match data

No Settings toggle. Always visible on localhost, never visible in production.

### Props threading

- `PageClient` calls `useIsLocalhost()`, passes `isLocalhost` to `CardTable`
- `CardTable` conditionally includes the column definition based on the prop
- The `columns` useMemo dependency array in `CardTable` must include `isLocalhost`

## What this does NOT change

- Existing Win Equity and Raw Win Rate columns are untouched
- No new database tables or migrations
- No runtime database calls from the web app
- No server-side rendering changes
