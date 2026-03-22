# Winning Decks by Color Pair

## Purpose

Surface the top-performing decklists for any color archetype across all drafts. A drafter preparing for an upcoming rotisserie draft can query "show me the best UB decks" and see which builds won, what cards they shared, and where to find the full lists.

## API Endpoint

**`GET /api/decks/winning`**

### Parameters

| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `color_pair` | yes | string | Exact inferred color identity (e.g. `UB`, `R`, `WUG`) |
| `draft_ids` | no | string | Comma-separated draft IDs to restrict the search |

### Response

```json
{
  "color_pair": "UB",
  "decks": [
    {
      "draft_id": "tarkir",
      "draft_name": "Tarkir",
      "seat": 3,
      "record": { "match_wins": 7, "match_losses": 2 }
    }
  ],
  "overlap_cards": [
    { "name": "Counterspell", "count": 3 },
    { "name": "Fatal Push", "count": 2 }
  ]
}
```

- **`decks`** — Top 4 decks of the requested archetype, sorted by match wins DESC then game win rate DESC.
- **`overlap_cards`** — Cards maindecked in two or more of the returned decks, sorted by count DESC then name ASC.

### Caching

`Cache-Control: s-maxage=300` — consistent with other aggregate endpoints.

## Query Logic

1. Find all seats with decklists across all drafts (or drafts matching `draft_ids`).
2. Exclude privacy-opted-out seats.
3. Infer each seat's deck color from maindecked cards using the existing 30% threshold algorithm (`inferDeckColor`).
4. Keep only seats whose inferred color exactly matches `color_pair`.
5. Join with `match_events` to compute each seat's match record (wins, losses).
6. Rank by match wins DESC, then game win rate DESC.
7. Take the top 4.
8. Compute overlap: collect all maindecked card names across the 4 decks, return those appearing in 2+ decks with their count.

### Why color-first, not standings-first

Filtering by color before ranking avoids the failure mode where a color archetype never appears in the top 3 finishers of any draft. By gathering all decks of the archetype first, we always return the best-performing builds for that color pair, regardless of overall draft placement.

## Deck Lookup

Each returned deck provides `draft_id` and `seat` — enough to fetch the full decklist via the existing `GET /api/drafts/[id]/deck?seat=N` endpoint or the `get_deck` MCP tool.

## MCP Tool

**Tool name:** `get_winning_decks`

| Field | Value |
|-------|-------|
| **Input** | `color_pair` (required string), `draft_ids` (optional string array) |
| **Output** | Same JSON shape as the API response |
| **Implementation** | HTTP GET to `/api/decks/winning` |

A thin proxy, consistent with the existing MCP tools in the adjacent server.

## Privacy

Opted-out seats are excluded entirely — they do not appear in the returned decks and their cards do not contribute to overlap counts.

## Implementation Scope

### New code
- Query function `getWinningDecksByColor()` in `src/core/db/queries/decklists.ts`
- API route handler at `src/app/api/decks/winning/route.ts`
- MCP tool `get_winning_decks` in the adjacent MCP server

### Reused code
- `inferDeckColor()` from `src/core/inferDeckColor.ts`
- `getOptedOutSeats()` from `src/core/db/queries/helpers.ts`
- `parseScryfallJson()` from `src/core/db/queries/helpers.ts`
- Turso client from `src/core/db/client.ts`

### No schema changes
All required data already exists in `deck_cards`, `match_events`, `drafts`, and `cards` tables.
