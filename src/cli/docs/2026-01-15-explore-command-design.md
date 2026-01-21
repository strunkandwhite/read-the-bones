# Explore Command Design

A CLI command for asking general questions about historical draft data.

## Problem

The existing `suggest` command helps with pick decisions during an active draft. Users also want to explore historical data: player win rates, card performance correlations, archetype analysis.

## Solution

New command `./scratch` loads all draft data (picks, pools, matches) and sends it to an LLM for general Q&A.

Example questions:
- "Who are the winningest players?"
- "What archetypes win the most?"
- "Which cards correlate with wins?"
- "What colors does Seat 3 prefer?"

## Invocation

```bash
./scratch              # Production (gpt-5)
./scratch --dev        # Dev mode (cheaper model)
./scratch --dry-run    # Print prompt without API call
```

No draft folder argument needed - loads all data from `data/`.

## Data Format

The prompt contains raw data. The LLM derives all analysis.

```
=== DRAFT: innistrad (10 players) ===

MATCH RESULTS:
  Seat 1 vs Seat 2: 1-2 (Seat 2 wins)
  Seat 1 vs Seat 3: 2-1 (Seat 1 wins)
  ...

PICKS BY PLAYER:
  Seat 1: Phelia Exuberant Shepherd, Ephemerate, Flickerwisp, ...
  Seat 2: Fable of the Mirror-Breaker, Fury, Demonic Tutor, ...
  ...

=== DRAFT: tarkir (10 players) ===
...

=== CARD POOL (from most recent draft) ===
Phelia Exuberant Shepherd, Fable of the Mirror-Breaker, ...
```

Key decisions:
- Raw match results (no pre-computed win rates)
- Raw picks in draft order (no color inference)
- Pool from most recent draft only
- LLM derives all analysis from raw data

## Error Handling

Match data is required. If no drafts have `matches.csv`, exit with error.

All other validation (missing files, incomplete drafts, parse errors) is handled by existing `loadAllDrafts()` infrastructure.

## Implementation

### New Files

| File | Purpose |
|------|---------|
| `src/cli/explore.ts` | Entry point |
| `src/cli/explorePrompt.ts` | Format raw data for LLM |
| `src/cli/repl.ts` | Extracted REPL loop (shared with suggest) |
| `scratch` | Gitignored shell script |

### Modified Files

| File | Change |
|------|--------|
| `src/cli/suggest.ts` | Use extracted REPL from `repl.ts` |
| `.gitignore` | Add `scratch` |

### Reused As-Is

- `loadAllDrafts()` from dataLoader.ts
- `getSuggestion()`, `continueConversation()` from llmClient.ts
- `lookupCard()` from scryfallTool.ts
- `Spinner` from spinner.ts

## System Prompt

```
You are an MTG draft analyst with access to historical rotisserie draft data.

You can answer questions about:
- Player performance (win rates, pick tendencies, color preferences)
- Card performance (correlation with wins, pick patterns)
- Archetype analysis (which strategies win most)
- Draft trends across time

The data follows. Answer questions based only on this data.
```

## Token Budget

With 10 drafts:
- ~47 rows of picks × 10 drafters × 10 drafts = ~4,700 pick entries
- ~45 match results × 10 drafts = ~450 matches
- ~540 cards in pool

Estimated total: 15-25K tokens. Fits comfortably in GPT-5's 128K+ context.
