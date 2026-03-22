# Winning Decks by Color Pair

## Purpose

Surface the top-performing decklists for any color archetype across all drafts. A drafter preparing for an upcoming rotisserie draft can query "show me the best UB decks" and see which builds won, what cards they shared, and where to find the full lists.

## API Endpoint

**`GET /api/decks/winning`**

This is a cross-draft query, so it lives at the top level rather than under `/api/drafts/[id]/`.

### Parameters

| Param | Required | Type | Description |
|-------|----------|------|-------------|
| `color_pair` | yes | string | Exact inferred color identity: 1-2 uppercase WUBRG characters, or `C` for colorless |
| `draft_ids` | no | string | Comma-separated draft IDs to restrict the search |

**Validation:** `color_pair` must be 1-2 characters from `WUBRG` (in WUBRG order) or the single character `C`. Invalid values return 400. This matches the output space of `inferDeckColor`, which produces at most two colors.

### Response

```json
{
  "color_pair": "UB",
  "decks": [
    {
      "draft_id": "tarkir",
      "draft_name": "Tarkir",
      "seat": 3,
      "record": {
        "match_wins": 7,
        "match_losses": 2,
        "game_wins": 14,
        "game_losses": 7
      }
    }
  ],
  "overlap_cards": [
    { "name": "Counterspell", "count": 3 },
    { "name": "Fatal Push", "count": 2 }
  ]
}
```

- **`decks`** — Up to 4 decks of the requested archetype, sorted by match wins DESC then game win rate DESC. May return 0-3 if fewer matching decks exist.
- **`overlap_cards`** — Cards maindecked in two or more of the returned decks, sorted by count DESC then name ASC. Empty array when fewer than 2 decks are returned.

### Caching

`Cache-Control: s-maxage=300` — consistent with other aggregate endpoints.

## Query Logic

1. Find all seats with maindecked cards (`deck_cards` where `zone = 'deck'`) across all drafts (or drafts matching `draft_ids`).
2. Exclude privacy-opted-out seats. Since this is a cross-draft query, gather opt-outs for all relevant drafts in a single query rather than calling `getOptedOutSeats()` per draft.
3. Infer each seat's deck color from maindecked cards using the existing 30% threshold algorithm (`inferDeckColor`).
4. Keep only seats whose inferred color exactly matches `color_pair`.
5. Join with `match_events` to compute each seat's match record (match wins/losses, game wins/losses). Seats without match data are excluded — a deck without results cannot be ranked.
6. Rank by match wins DESC, then game win rate (game_wins / (game_wins + game_losses)) DESC.
7. Take the top 4.
8. Compute overlap: collect all maindecked card names across the returned decks, return those appearing in 2+ decks with their count.

### Why color-first, not standings-first

Filtering by color before ranking avoids the failure mode where a color archetype never appears in the top finishers of any draft. By gathering all decks of the archetype first, we always return the best-performing builds for that color pair, regardless of overall draft placement.

## Deck Lookup

Each returned deck provides `draft_id` and `seat` — enough to fetch the full decklist via the existing `GET /api/drafts/[id]/deck?seat=N` endpoint or the `get_deck` MCP tool.

## MCP Tool

**Tool name:** `get_winning_decks`

| Field | Value |
|-------|-------|
| **Input** | `color_pair` (required string), `draft_ids` (optional string array) |
| **Output** | Same JSON shape as the API response |
| **Implementation** | HTTP GET to `/api/decks/winning`, joining `draft_ids` array into comma-separated string |

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
- `parseScryfallJson()` from `src/core/db/queries/helpers.ts`
- Turso client from `src/core/db/client.ts`

### No schema changes
All required data already exists in `deck_cards`, `match_events`, `drafts`, and `cards` tables.
