# Read the Bones

MTG rotisserie draft analytics tool.

## Project Structure

```
src/
  core/           # Framework-agnostic logic (parsing, stats, Scryfall)
    db/           # Turso database client, queries, ingestion
    llm/          # LLM client with tool-based retrieval
  build/          # Build-time data loading (Turso and legacy CSV loaders)
  app/            # Next.js web app
  cli/            # CLI for draft analysis (merged from submodule)
data/
  <draft-name>/
    picks.csv     # Draft picks (ingestion source)
    pool.csv      # Available card pool (ingestion source)
    matches.csv   # Match results (optional)
    metadata.json # Draft metadata (name, date, sheetId)
```

## Key Commands

```bash
pnpm dev         # Start dev server (syncs sheets + regenerates draft data)
pnpm build       # Build static site (regenerates draft data only - no sync)
pnpm test        # Run tests
pnpm screenshot  # Take screenshot (requires dev server running)

# Database commands
pnpm db:migrate  # Run database migrations (creates tables in Turso)
pnpm ingest      # Ingest all drafts from data/ into Turso database

# CLI (requires OPENAI_API_KEY in .env or .env.local)
tsx src/cli/analyze.ts data          # Explore mode - chat about historical data
tsx src/cli/analyze.ts draft         # Draft mode - active draft advice
tsx src/cli/analyze.ts --resume      # Resume a previous conversation
```

**CLI flags:** `--dev` (cheaper model), `--dry-run` (print prompts without API call), `--verbose` (loading progress)

**Database warning:** Never clear the entire Turso database. The `pnpm ingest` command uses hash-based deduplication - it only re-imports drafts whose source CSV files have changed. If you need to force re-ingestion of a specific draft, delete just that draft's rows from the database, not all data.

**Data flow:** The web app reads from Turso database at build time. To update draft data:
1. Sync from Google Sheets: `pnpm sync-sheets` (or `pnpm dev` runs this automatically)
2. Ingest CSVs into Turso: `pnpm ingest`
3. Rebuild the site: `pnpm build`

**Note:** CSV files are the ingestion source but are NOT tracked in git (privacy - they contain player names). Keep local backups. The `predev`/`prebuild` hooks still generate `draft-data.json` for client-side draft filtering.

## Important: Process Management

Kill running dev processes as soon as they're no longer needed. Don't leave `pnpm dev` running in the background - it blocks the port and causes issues when trying to restart.

## Data Format

**picks.csv:** Row 3 = drafter names, rows 4+ = picks. Pick number in column A, card names in drafter columns. Card colors in rightmost columns.

**pool.csv:** List of all cards available in the cube for that draft.

## Card Name Normalization

Strip numeric suffixes from duplicate cards: "Scalding Tarn 2" → "Scalding Tarn"

## Search Syntax

Local Scryfall-style search (searches only cards in the cube):

- `t:creature` - type search
- `o:flying` - oracle text search
- `o:"draw a card"` - quoted phrases
- `c:r` - color (w/u/b/r/g, c=colorless)
- `c:ub` - multicolor (blue AND black)
- `cmc=3` - exact mana value
- `cmc<=2` - comparison (<, >, <=, >=)
- `bolt` - name search (plain text)
- `t:instant c:u` - combine terms (AND logic)

Search is debounced (500ms) and runs locally against cached card data.

## Terminology: Picks vs Rounds

- **Pick position**: Absolute number (1-450). The order a card was selected in a draft.
- **Round**: Which pass through the drafters. Round = `ceil(pickPosition / numDrafters)`.
  - With 10 drafters: Round 1 = picks 1-10, Round 2 = picks 11-20, etc.
- **Unpicked penalty**: Cards not selected get pickPosition = poolSize (540), which converts to `ceil(540 / numDrafters)` rounds (e.g., round 54 with 10 drafters).

The UI displays "Pick Score" which is the weighted geometric mean of pick positions across drafts.

## LLM Tools (Chat Interface)

The web app and CLI use tool-based LLM retrieval to answer questions about draft data. Tools query Turso and return citable results:

- `list_drafts` - Find drafts by date range or name
- `get_draft` - Get draft details including seats and metadata
- `get_picks` - Get picks with optional filters (seat, pick range, card)
- `get_available_cards` - Get cards available before a specific pick
- `get_standings` - Get match standings for a draft
- `get_card_pick_stats` - Get aggregate pick statistics for a card
- `get_draft_pool` - Get the card pool (cube snapshot) for a draft
- `lookup_card` - Look up card details from Scryfall

The LLM must call tools before making factual claims and cite sources in responses.

**Privacy:** Players are identified by seat number (1-N) within each draft only. No cross-draft player identity is tracked.

## Design Documents

- `docs/plans/2026-01-08-card-rankings-design.md` - Architecture and algorithm details
- `docs/plans/2026-01-20-turso-migration-design.md` - Turso database migration plan
