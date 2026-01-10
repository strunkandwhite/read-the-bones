# Read the Bones

MTG rotisserie draft analytics tool.

## Project Structure

```
src/
  core/           # Framework-agnostic logic (parsing, stats, Scryfall)
  app/            # Next.js web app
data/
  <draft-name>/
    picks.csv     # Draft picks
    pool.csv      # Available card pool
cache/
  scryfall.json   # Cached Scryfall card data
```

## Key Commands

```bash
pnpm dev         # Start dev server
pnpm build       # Build static site
pnpm test        # Run tests
pnpm screenshot  # Take screenshot (requires dev server running)
```

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

The UI displays rounds, not raw pick positions. When aggregating multiple drafts on the same date, convert positions to rounds BEFORE averaging.

## Design Document

See `docs/plans/2026-01-08-card-rankings-design.md` for full architecture and algorithm details.
