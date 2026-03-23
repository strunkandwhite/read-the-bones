# Server-Side Oracle Search API

Expose a server-side API route for Scryfall-style card search, reusing the existing `localSearch.ts` parser. Enables MCP tools to query cards by Oracle text, type, color, and mana value without a browser.

## Problem

The Oracle search implementation (`localSearch.ts`) runs entirely on the client. MCP tools and external integrations have no way to query cards by Oracle text, type line, color, or mana value. The existing `/api/drafts/[id]/available` endpoint supports only basic color and type substring filters, not the full search syntax.

## Scope

**In scope:**
- New `GET /api/cards/search` route accepting a Scryfall-style query string
- Global search (all cards in `cards` table) by default
- Optional `draft_id` parameter to scope search to a draft's cube pool
- Optional `available_only` parameter to exclude already-picked cards (requires `draft_id`)
- Optional `before_pick_n` to control the availability cutoff point
- Reuse `searchLocalCards()` from `localSearch.ts` for query parsing and matching

**Out of scope:**
- New search operators beyond what `localSearch.ts` supports
- Pick statistics or ranking data in search results
- Pagination (card pools are bounded; ~540 cards max per draft, ~2000 globally)

## API Design

### `GET /api/cards/search`

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `q` | yes | string | Scryfall-style query (e.g., `t:creature c:r mv<=3`) |
| `draft_id` | no | string | Scope to this draft's cube pool |
| `available_only` | no | `true` | Exclude picked cards. Requires `draft_id`; returns 400 without it. |
| `before_pick_n` | conditional | integer | Show availability as of this pick number. Required when `available_only` is set; returns 400 without it. |

### Response

```json
{
  "query": "t:creature c:r",
  "total": 12,
  "draft_id": null,
  "before_pick_n": null,
  "cards": [
    {
      "name": "Goblin Guide",
      "image_uri": "https://...",
      "mana_cost": "{R}",
      "mana_value": 1,
      "type_line": "Creature — Goblin Scout",
      "colors": ["R"],
      "color_identity": ["R"],
      "oracle_text": "Whenever Goblin Guide attacks, ..."
    }
  ]
}
```

`draft_id` and `before_pick_n` echo back the scoping parameters (null when not provided).

When `available_only` is set, each card includes an additional `remaining_qty` field (integer).

Response uses snake_case to match the existing REST API convention (see `/api/cards/stats`, `/api/drafts/[id]/available`).

### Error responses

| Condition | Status | Body |
|-----------|--------|------|
| Missing `q` parameter | 400 | `{ "error": "q parameter is required" }` |
| `available_only` without `draft_id` | 400 | `{ "error": "available_only requires draft_id" }` |
| `available_only` without `before_pick_n` | 400 | `{ "error": "before_pick_n is required when available_only is set" }` |
| `before_pick_n` without `available_only` | 400 | `{ "error": "before_pick_n requires available_only" }` |
| Draft not found | 404 | `{ "error": "Draft not found" }` |
| Unexpected server error | 500 | `{ "error": "Internal server error" }` |

## Architecture

### Data flow

```
Request
  │
  ├─ No draft_id: SELECT all cards from `cards` table
  │
  ├─ With draft_id: SELECT cards via cube_snapshot_cards JOIN
  │
  └─ With available_only: subtract pick_events (same pattern as getAvailableCards)
       │
       ▼
  Parse scryfall_json → ScryCard[]
       │
       ▼
  searchLocalCards(q, cards) → matching ScryCard[]
       │
       ▼
  Map to snake_case response + attach remaining_qty if applicable
```

### New query function

Add a new query module `src/core/db/queries/search.ts` to avoid stretching `cards.ts` (which handles card resolution) with cube/pick join patterns:

```typescript
type SearchCardsParams = {
  draftId?: string;
  availableOnly?: boolean;
  beforePickN?: number;
};

type SearchCardResult = {
  name: string;
  scryfall_json: string;
  remaining_qty?: number;
};

async function searchCards(params: SearchCardsParams): Promise<SearchCardResult[]>
```

Three query paths:

1. **Global** (no `draftId`): `SELECT name, scryfall_json FROM cards WHERE scryfall_json IS NOT NULL`
2. **Draft-scoped**: Join `cards` → `cube_snapshot_cards` → `drafts` on `cube_snapshot_id`
3. **Available only**: Same as draft-scoped, but subtract picked cards using `pick_events` aggregation (reuse the pattern from `getAvailableCards` in `picks.ts`)

### ScryCard conversion

Reuse `transformScryfallJson()` from `getCards.ts` to convert `scryfall_json` → `ScryCard`. This function already handles double-faced cards and missing fields. It is currently file-private; extract it to `src/core/db/queries/helpers.ts` alongside the existing `parseScryfallJson()`. The two functions serve different purposes: `parseScryfallJson` returns the minimal snake_case `ScryfallCardData` shape for DB-level filtering, while `transformScryfallJson` returns the full camelCase `ScryCard` shape for display and search.

### Search execution

Call `searchLocalCards(q, scryfallCards)` from `localSearch.ts`. This returns the filtered `ScryCard[]`. The existing parser handles all supported operators (type, oracle, color, mana value, name) with AND logic.

### Response mapping

Map `ScryCard` (camelCase, used by the UI) to snake_case for the API response:

```typescript
function toSearchResult(card: ScryCard) {
  return {
    name: card.name,
    image_uri: card.imageUri,
    mana_cost: card.manaCost,
    mana_value: card.manaValue,
    type_line: card.typeLine,
    colors: card.colors,
    color_identity: card.colorIdentity,
    oracle_text: card.oracleText,
  };
}
```

### Caching

- Global queries (no `draft_id`): `Cache-Control: s-maxage=300` (5 minutes)
- Draft-scoped queries: `Cache-Control: no-store` (draft data may be actively syncing)

## Files to modify

| File | Change |
|------|--------|
| `src/app/api/cards/search/route.ts` | **New.** API route handler. |
| `src/core/db/queries/search.ts` | **New.** `getSearchableCards()` query function with three paths (global, draft-scoped, available-only). |
| `src/core/db/queries/index.ts` | Re-export from `search.ts`. |
| `src/core/getCards.ts` | Extract `transformScryfallJson()` to helpers. |
| `src/core/db/queries/helpers.ts` | Receive extracted `transformScryfallJson()` alongside existing `parseScryfallJson()`. |

## Testing

- Unit tests for the API route covering: global search, draft-scoped, available-only, parameter validation errors
- Verify parity with client-side search by running the same queries through both paths
