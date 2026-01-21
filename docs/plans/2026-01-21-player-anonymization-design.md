# Player Anonymization Design

## Overview

Remove player identity from the entire application to address privacy concerns. Players are identified only by seat number within each draft, with no cross-draft identity. Some participants can opt out of LLM queries entirely.

This affects both the LLM layer and the web app (removing the "top player" feature which depends on cross-draft player identity).

## Motivation

Some community members are uncomfortable with their data being accessible through the chat interface or sent to LLMs. This design:
- Anonymizes all players by default (identified by seat, not name)
- Allows players to opt out of LLM queries entirely
- Removes cross-draft player identity (no way to track a person across drafts)

## Design Principles

1. **Within a draft**: Player data available with "Seat N" labels
2. **Across drafts**: No player identity concept - Seat 3 in draft A ≠ Seat 3 in draft B
3. **Opt-out**: Excluded from attributable results, but picks still affect game state (e.g., available cards)

## Database Schema Changes

### Remove Player Identity

Delete these tables:
- `players` (display names)
- `draft_players` (player-to-seat mapping)

### Modify Existing Tables

**pick_events:**
```sql
-- Before: draft_id, player_id, card_id, pick_n
-- After:  draft_id, seat, card_id, pick_n
```

**match_events:**
```sql
-- Before: draft_id, player1_id, player2_id, player1_wins, player2_wins
-- After:  draft_id, seat1, seat2, seat1_wins, seat2_wins
```

### New Opt-Out Table

```sql
CREATE TABLE llm_opt_outs (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  PRIMARY KEY (draft_id, seat)
);
```

## Migration Strategy

### Step 1: Add seat columns

```sql
ALTER TABLE pick_events ADD COLUMN seat INTEGER;

UPDATE pick_events
SET seat = (
  SELECT dp.seat
  FROM draft_players dp
  WHERE dp.draft_id = pick_events.draft_id
    AND dp.player_id = pick_events.player_id
);

ALTER TABLE match_events ADD COLUMN seat1 INTEGER;
ALTER TABLE match_events ADD COLUMN seat2 INTEGER;

UPDATE match_events
SET seat1 = (SELECT seat FROM draft_players dp WHERE dp.draft_id = match_events.draft_id AND dp.player_id = match_events.player1_id),
    seat2 = (SELECT seat FROM draft_players dp WHERE dp.draft_id = match_events.draft_id AND dp.player_id = match_events.player2_id);
```

### Step 2: Drop old columns and tables

```sql
ALTER TABLE pick_events DROP COLUMN player_id;
ALTER TABLE match_events DROP COLUMN player1_id;
ALTER TABLE match_events DROP COLUMN player2_id;

DROP TABLE draft_players;
DROP TABLE players;
```

### Step 3: Create opt-out table

```sql
CREATE TABLE llm_opt_outs (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  PRIMARY KEY (draft_id, seat)
);
```

## Tool Changes

### Remove Entirely

- `get_player_summary` - no cross-draft player identity concept

### Modify Parameters

**list_drafts:**
- Remove `player_id` filter

**get_picks:**
- Change `player_id` param → `seat` param
- Returns `seat` instead of `player_id` in results

### Modify Output

**get_draft:**
- Return seats list or count, not player names
- Exclude opted-out seats

**get_standings:**
- Return standings by seat number
- Exclude opted-out seats (but their matches count toward opponents' records)

**get_draft_pool:**
- `drafted_by` becomes seat number
- Null out for opted-out seats

### Opt-Out Filtering

| Tool | Behavior |
|------|----------|
| `get_picks` | Omit rows where (draft_id, seat) is opted out |
| `get_standings` | Omit opted-out seats from results |
| `get_draft` | Omit opted-out seats from seat list |
| `get_available_cards` | Include opted-out picks in calculation (game state accuracy) |
| `get_draft_pool` | Null out `drafted_by` for opted-out seats |

## Query Layer Changes

### getPicks

```sql
SELECT pe.pick_n, pe.seat, c.name as card_name
FROM pick_events pe
JOIN cards c ON pe.card_id = c.card_id
LEFT JOIN llm_opt_outs oo ON oo.draft_id = pe.draft_id AND oo.seat = pe.seat
WHERE pe.draft_id = ? AND oo.seat IS NULL
ORDER BY pe.pick_n ASC
```

### Remove

- `getPlayerSummary` function
- `normalizePlayerId` helper

## Ingestion Changes

Current behavior:
1. Extract player names from CSV headers
2. Create `players` table entries
3. Create `draft_players` entries (player_id → seat)
4. Record `pick_events` with player_id

New behavior:
1. Extract column positions as seat numbers
2. Skip `players` and `draft_players` tables
3. Record `pick_events` with seat (column position)
4. Record `match_events` with seat numbers

Seat assignment: Column position in CSV (1-indexed) = seat number. Original drafter names are used only to determine seat order, then discarded.

## Repository Cleanup

CSV files contain real player names. Remove from git history:

```bash
git filter-repo --path data/ --invert-paths
git reflog expire --expire=now --all && git gc --prune=now --aggressive
```

Update .gitignore:
```gitignore
data/
```

Update CLAUDE.md to note that `data/` is local-only.

## LLM Prompt Updates

### Terminology

Replace "player" with "seat" throughout. Clarify seats are 1-N per draft, not persistent across drafts.

### Redaction Explanation

Add to system prompt:

> Some drafters have opted out of LLM queries. Their picks and match results are excluded from tool responses. This means:
> - `get_picks` may have gaps in seat coverage
> - `get_standings` may show fewer seats than participated
> - `get_draft` may report fewer seats than actually drafted
>
> Do not speculate about opted-out drafters. If a user asks about missing data, explain that some participants have opted out of data sharing.

### Behavioral Guidance

- Don't guess who opted out or why
- Don't try to infer opted-out data from gaps
- Treat missing seats as simply not available

## Remove Top Player Feature

The web app's "top player" filtering feature depends on persistent player identity across drafts. Since we're removing that concept, the feature must be removed.

### Remove from Card Stats

- `src/core/types.ts` - Remove `topPlayerGeomean` from `CardStats`, remove `PlayerConfig` type
- `src/core/calculateStats.ts` - Remove `topPlayers` parameter, remove `topPlayerGeomean` calculation
- `src/core/utils.ts` - Remove `topPlayers`/`useTopPlayerMultiplier` from `calculatePickWeight`

### Remove from Data Loaders

- `src/build/tursoDataLoader.ts`:
  - Remove `topPlayers` parameter from `loadCardDataFromTurso`
  - Remove `players` from return value
  - Remove `extractPlayers` call
- `src/build/dataLoader.ts` (if still used) - Same changes

### Remove from Web App

- `src/app/components/Settings.tsx` - Remove top player selection UI
- `src/app/components/CardTable.tsx` - Remove top player column/sorting
- `src/app/components/PageClient.tsx` - Remove top player state and localStorage handling

### Data Flow Simplification

Before:
1. Load all picks with `drafterName`
2. Extract unique player names
3. User selects "top players" in Settings
4. Pass `topPlayers` to stats calculation
5. Calculate `topPlayerGeomean` with higher weights for top player picks

After:
1. Load all picks (no `drafterName` needed for stats)
2. Calculate single `weightedGeomean` (no player-based weighting)

## CLI Changes

The CLI has extensive player-related code that must be removed or refactored.

### Remove Entirely

- `src/cli/promptBuilder.ts`:
  - `TOP_PLAYERS` constant (line 28) - hardcoded player names
  - Player dictionary formatting for prompts

- `src/cli/cardCodes.ts`:
  - `buildPlayerDictionary()` - creates codes for player names
  - `formatPlayerDict()` - formats player codes for prompts
  - `encodePlayer()` - encodes player names
  - `normalizePlayerNameForDict()` - normalizes player variants

- `src/core/parseCsv.ts`:
  - `PLAYER_ALIASES` constant - **contains real player names** (must be removed)
  - `normalizePlayerName()` - uses aliases
  - `buildPlayerNameMap()` - builds canonical name map

### Refactor to Use Seats

- `src/cli/types.ts`:
  - `DraftState.drafters: string[]` → remove or change to seat count
  - `currentDrafterIndex` → `currentSeat`
  - `picksByDrafter` → `picksBySeat`

- `src/cli/draftState.ts`:
  - `getDrafterForPick()` - refactor to return seat number, not name

- `src/cli/promptBuilder.ts`:
  - Opponent analysis sections - use "Seat N" instead of names

### Test Files

- `src/cli/draftState.test.ts` - Update for seat-based system
- `src/cli/cardCodes.test.ts` - Remove player encoding tests

## Additional Core Changes

### Functions to Remove

- `src/core/db/queries.ts`:
  - `normalizePlayerId()` helper function

- `src/core/calculateStats.ts`:
  - `extractPlayers()` function - extracts unique player names

### Fields to Remove/Change

- `src/core/types.ts`:
  - `CardPick.drafterName` field - remove entirely (not needed for stats)

## Test File Updates

All test files with player data need refactoring:

- `src/core/calculateStats.test.ts` - Uses "Alice", "Bob", "Charlie" test data
- `src/core/llm/toolExecutor.test.ts` - Uses `player_id: "alice"`
- `src/core/db/queries.test.ts` - Player-based test scenarios

## Files to Modify

**Database Layer:**
- `src/core/db/schema.ts` - Update types (player_id → seat)
- `src/core/db/schema.sql` - SQL migration script
- `src/core/db/queries.ts` - Update all query functions, remove `normalizePlayerId`
- `src/core/db/ingest.ts` - Remove player identity handling

**LLM Layer:**
- `src/core/llm/tools.ts` - Update tool definitions
- `src/core/llm/toolExecutor.ts` - Update tool routing
- `src/core/llm/client.ts` - Update system prompts

**Core Types/Utils:**
- `src/core/types.ts` - Remove `PlayerConfig`, `topPlayerGeomean`, `drafterName`
- `src/core/calculateStats.ts` - Remove top player logic, remove `extractPlayers`
- `src/core/utils.ts` - Simplify weight calculation
- `src/core/parseCsv.ts` - Remove `PLAYER_ALIASES`, `normalizePlayerName`, `buildPlayerNameMap`

**Data Loaders:**
- `src/build/tursoDataLoader.ts` - Remove player extraction

**Web App:**
- `src/app/components/Settings.tsx` - Remove top player UI
- `src/app/components/CardTable.tsx` - Remove top player column
- `src/app/components/PageClient.tsx` - Remove top player state

**CLI:**
- `src/cli/promptBuilder.ts` - Remove TOP_PLAYERS, player dict formatting
- `src/cli/cardCodes.ts` - Remove player encoding functions
- `src/cli/types.ts` - Refactor DraftState to use seats
- `src/cli/draftState.ts` - Refactor to return seat numbers

**Tests:**
- `src/core/calculateStats.test.ts` - Refactor test data
- `src/core/llm/toolExecutor.test.ts` - Remove player_id tests
- `src/core/db/queries.test.ts` - Update for seat-based queries
- `src/cli/draftState.test.ts` - Update for seats
- `src/cli/cardCodes.test.ts` - Remove player tests

**Config:**
- `CLAUDE.md` - Document local-only data directory
- `.gitignore` - Add data/

## Implementation Order

### Phase 1: Remove Top Player Feature
1. Remove from web app (Settings, CardTable, PageClient)
2. Remove from core (types.ts - `PlayerConfig`, `topPlayerGeomean`)
3. Remove from calculateStats.ts (`extractPlayers`, top player params)
4. Remove from utils.ts (top player weighting)
5. Update tursoDataLoader.ts (remove player extraction)

### Phase 2: Remove Player Aliases & Hardcoded Names
6. Remove `PLAYER_ALIASES` from parseCsv.ts
7. Remove `normalizePlayerName`, `buildPlayerNameMap` from parseCsv.ts
8. Remove `TOP_PLAYERS` from cli/promptBuilder.ts
9. Remove player encoding from cli/cardCodes.ts

### Phase 3: Database Schema Migration
10. Write migration script (add seat columns, populate from draft_players)
11. Update schema.ts types (player_id → seat)
12. Update ingest.ts (skip player tables, use seat directly)
13. Run migration on Turso
14. Re-ingest all drafts

### Phase 4: LLM Layer Updates
15. Update queries.ts (remove `normalizePlayerId`, change to seat, add opt-out)
16. Remove `getPlayerSummary` from queries.ts
17. Update tools.ts definitions
18. Update toolExecutor.ts routing
19. Update LLM prompts in client.ts

### Phase 5: CLI Refactoring
20. Refactor cli/types.ts (DraftState to use seats)
21. Refactor cli/draftState.ts (return seat numbers)
22. Update cli/promptBuilder.ts (use "Seat N" for opponent analysis)

### Phase 6: Test Updates
23. Update calculateStats.test.ts
24. Update toolExecutor.test.ts
25. Update queries.test.ts
26. Update cli/draftState.test.ts
27. Remove cli/cardCodes.test.ts player tests

### Phase 7: Repository Cleanup
28. Purge data/ from git history
29. Update .gitignore
30. Update CLAUDE.md

### Phase 8: Verification
31. Run full test suite
32. Test web app end-to-end
33. Test CLI end-to-end
34. Test LLM tools with opt-out scenarios
