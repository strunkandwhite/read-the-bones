# Turso Migration Design

Migration from CSV-based data to Turso (hosted SQLite) as the single source of truth, with tool-based LLM retrieval to prevent hallucinations.

## Problem

The LLM hallucinates/misattributes picks when given too much data in the prompt. As the dataset grows, this will worsen. We need:
- Strict data integrity with citable references
- Both broad queries (cross-draft) and specific queries (single pick)
- A single source of truth for CLI and web app

## Architecture

### Current State
```
Google Sheets → CSV files (git) → Build-time parsing → Web app (static)
                     ↓
              CLI reads CSVs → Giant prompt blob → LLM → Hallucinations
```

### New State
```
Google Sheets → CSV files → Ingestion script → Turso (SQLite)
                                                    ↓
                                    ┌───────────────┴───────────────┐
                                    ↓                               ↓
                              Web app                             CLI
                         (build-time queries                (LLM + tools)
                          + /api/chat)                           ↓
                                                         Tool calls with
                                                         citable responses
```

### Key Changes

1. **Turso becomes the single source of truth** - All draft data, picks, matches, card metadata
2. **CSVs are ingestion-only** - Run `pnpm ingest` after updating Sheets
3. **LLM uses retrieval tools** - Calls `get_picks()`, `get_available_cards()`, etc. with citable sources
4. **Web app queries Turso** - At build time for stats, plus `/api/chat` for LLM queries
5. **Submodule removed** - CLI merges into main repo, shares `src/core/` with web app

### What Stays the Same
- Google Sheets remains the human entry point for picks/matches
- Scryfall cache for card details
- Conversation resumption via OpenAI response IDs

## Database Schema

Six canonical tables, plus derived views for computed stats.

```sql
-- Card identity registry
cards (
  card_id INTEGER PRIMARY KEY,
  oracle_id TEXT NOT NULL UNIQUE,  -- Scryfall stable ID
  name TEXT NOT NULL,
  scryfall_json TEXT               -- Cached Scryfall data as JSON
)

-- Player registry
players (
  player_id TEXT PRIMARY KEY,      -- Normalized: lowercase, alphanumeric only
  display_name TEXT NOT NULL       -- Pretty form: "Reid Duke"
)

-- Cube snapshots (the pool for a specific draft)
cube_snapshots (
  cube_snapshot_id INTEGER PRIMARY KEY,
  cube_hash TEXT NOT NULL UNIQUE   -- SHA256 of card list for deduplication
)

cube_snapshot_cards (
  cube_snapshot_id INTEGER REFERENCES cube_snapshots,
  card_id INTEGER REFERENCES cards,
  qty INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cube_snapshot_id, card_id)
)

-- Draft metadata
drafts (
  draft_id TEXT PRIMARY KEY,       -- e.g., "tarkir-2024"
  draft_name TEXT NOT NULL,
  draft_date TEXT NOT NULL,        -- ISO date
  cube_snapshot_id INTEGER REFERENCES cube_snapshots,
  import_hash TEXT NOT NULL        -- For idempotent reimports
)

draft_players (
  draft_id TEXT REFERENCES drafts,
  player_id TEXT REFERENCES players,
  seat INTEGER,                    -- Draft order position
  PRIMARY KEY (draft_id, player_id)
)

-- Canonical pick log
pick_events (
  draft_id TEXT REFERENCES drafts,
  pick_n INTEGER NOT NULL,
  player_id TEXT REFERENCES players,
  card_id INTEGER REFERENCES cards,
  PRIMARY KEY (draft_id, pick_n)
)

-- Match results
match_events (
  draft_id TEXT REFERENCES drafts,
  player1_id TEXT REFERENCES players,
  player2_id TEXT REFERENCES players,
  player1_wins INTEGER NOT NULL,
  player2_wins INTEGER NOT NULL,
  PRIMARY KEY (draft_id, player1_id, player2_id)
)
```

### Design Decisions

- **oracle_id for card identity** - Stable across printings
- **cube_hash deduplicates** - Identical cubes share a snapshot
- **import_hash enables idempotency** - Same CSV content = no-op on reimport
- **pick_n is citable** - LLM citations reference `[draft:X, pick:N]`
- **Player normalization** - `normalizePlayerId("Reid Duke") → "reidduke"`

## Ingestion Pipeline

```bash
pnpm ingest              # Ingest all drafts from data/
pnpm ingest tarkir-2024  # Ingest specific draft
```

### Steps

1. **DISCOVER** - Scan `data/<draft-name>/` directories
2. **HASH** - Compute import_hash; skip if unchanged, delete+reimport if changed
3. **RESOLVE CARDS** - Parse pool.csv, strip suffixes, look up Scryfall oracle_id
4. **CREATE CUBE SNAPSHOT** - Hash card list, reuse or create snapshot
5. **RESOLVE PLAYERS** - Normalize names, insert if new
6. **CREATE DRAFT** - Insert draft + draft_players with seats
7. **IMPORT PICKS** - Parse picks.csv, validate contiguity, insert pick_events
8. **IMPORT MATCHES** - Parse matches.csv if exists, validate players, insert

### Validation

Errors halt ingestion with clear messages:
- "Pick 47 references 'Blotning Bolt' - no matching card"
- "Pick 23 missing - picks jump from 22 to 24"
- "Player 'mike' in matches.csv not found in draft"

## LLM Tools

Instead of a giant prompt blob, the LLM calls tools and must cite sources.

### Tool Definitions

```typescript
list_drafts({ player_id?, date_from?, date_to?, draft_name? })
→ [{ draft_id, draft_name, draft_date }]

get_draft({ draft_id })
→ { draft_id, draft_name, draft_date, players: [{ player_id, display_name, seat }] }

get_picks({ draft_id, player_id?, pick_n_min?, pick_n_max?, card_name? })
→ { draft_id, picks: [{ pick_n, player_id, card_name }] }

get_available_cards({ draft_id, before_pick_n, color?, type_contains? })
→ { draft_id, before_pick_n, cards: [{ card_name, remaining_qty }] }

get_standings({ draft_id })
→ [{ player_id, match_wins, match_losses, game_wins, game_losses }]

get_card_pick_stats({ card_name, date_from?, date_to?, draft_name? })
→ {
    card_name, drafts_seen, times_picked,
    avg_pick_n, median_pick_n,
    weighted_geomean,      # "Pick Score"
    top_player_geomean
  }

get_player_summary({ player_id, draft_name? })
→ { player_id, drafts_played, match_winrate, most_picked_cards }

lookup_card({ card_name })
→ { oracle_text, type_line, mana_cost, ... }  # Scryfall data
```

### Citation Enforcement

System prompt includes:

```
CRITICAL: You MUST call a tool before making claims about picks, stats, or standings.
When referencing a pick, ALWAYS cite: [draft:{draft_id}, pick:{pick_n}]
When referencing stats, cite: [source:get_card_pick_stats]

WRONG: "Jack picked Lightning Bolt early in Tarkir."
RIGHT: "Jack picked Lightning Bolt at pick 5 [draft:tarkir-2024, pick:5]."
```

### Example Workflow

```
User: "Why was my pick 5 in the Tarkir draft bad?"

LLM calls: get_picks({ draft_id: "tarkir-2024", player_id: "jack", pick_n_min: 5, pick_n_max: 5 })
LLM calls: get_available_cards({ draft_id: "tarkir-2024", before_pick_n: 5 })

LLM responds: "At pick 5 you took Siege Rhino [draft:tarkir-2024, pick:5].
Looking at what was available, Lightning Helix and Swords to Plowshares
were still in the pool [source:get_available_cards]. Given your existing
white cards, Swords would have been stronger because..."
```

## Code Structure

```
src/core/
  db/
    client.ts        # Turso client (works in Node + edge)
    queries.ts       # Shared query functions
    schema.ts        # Type definitions matching tables
  llm/
    tools.ts         # Tool definitions
    toolExecutor.ts  # Executes tools against database
    client.ts        # OpenAI client wrapper

src/cli/
  analyze.ts         # Entry point (uses src/core/llm)
  ...

src/app/
  api/
    chat/
      route.ts       # POST /api/chat - LLM queries
  components/
    QueryBox.tsx     # Chat UI
  ...
```

### Model Configuration

```typescript
// CLI
const client = createLLMClient({
  model: devMode ? 'gpt-4o-mini' : 'gpt-5.2',
  useBackgroundMode: true
});

// Web API
const client = createLLMClient({
  model: 'gpt-5-mini-2025-08-07'
});
```

## Migration Phases

### Phase 1: Database & Ingestion
1. Set up Turso database
2. Create schema
3. Build ingestion script (`pnpm ingest`)
4. Ingest all existing drafts
5. Validate data integrity

### Phase 2: Core Library
1. Create `src/core/db/` with Turso client and queries
2. Create `src/core/llm/` with tools and executor
3. Port tool logic
4. Write tests against test database

### Phase 3: CLI Migration
1. Remove submodule, merge CLI into main repo
2. Refactor CLI to use `src/core/llm/` tools
3. Update prompts for citation requirements
4. Test citation-based queries

### Phase 4: Web App Migration
1. Replace `dataLoader.ts` with Turso queries
2. Update prebuild to query database
3. Add `/api/chat` route
4. Build `QueryBox` component
5. Test web queries return cited responses

### Phase 5: Cleanup ✓ COMPLETE
1. ✓ Remove CSV files from Vercel deployment
2. ✓ Update `pnpm dev` / `pnpm build` scripts
3. ✓ Update documentation
4. ✓ Delete private submodule repo

**Completed 2026-01-20.** All cleanup tasks finished. Codebase cleanup design doc (`docs/plans/2026-01-20-codebase-cleanup-design.md`) tracked additional cleanup work.

### Rollback Safety

Keep CSVs in git throughout migration. Old CSV-based code paths remain functional until confidence is established.
