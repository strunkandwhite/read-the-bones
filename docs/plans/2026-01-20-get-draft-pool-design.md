# Get Draft Pool Endpoint Design

New LLM tool to return the complete card pool for a specific draft, independent of whether cards were ultimately drafted.

## Problem

The cube changes over time. To answer questions like "what green creatures were available in the Tarkir draft?" the LLM needs to know the exact pool for that draft, not a global card list. The existing `get_available_cards` tool returns cards remaining *before* a specific pick, but there's no way to get the full pool snapshot.

## Solution

Add `get_draft_pool` tool that queries the `cube_snapshot_cards` table for a given draft, with optional filtering, grouping, and draft result annotation.

## Tool Definition

```typescript
get_draft_pool({
  draft_id: string,              // Required - e.g., "tarkir"
  include_draft_results?: bool,  // Default false - adds drafted_by, drafted_pick_n
  include_card_details?: bool,   // Default false - adds mana_cost, type_line, colors, color_identity
  group_by?: "none" | "color_identity" | "type",  // Default "none"
  color?: string,                // Filter by color identity (W/U/B/R/G/C)
  type_contains?: string,        // Filter by type substring
  name_contains?: string         // Filter by name substring (case-insensitive)
})
```

## Response Schema

```typescript
interface DraftPoolResult {
  draft_id: string;
  draft_name: string;
  draft_date: string;           // YYYY-MM-DD
  total_cards: number;          // Count after filtering
  cards: PoolCard[] | null;     // Flat list when group_by == "none", else null
  grouped: Record<string, PoolCard[]> | null;  // When group_by != "none", else null
}

interface PoolCard {
  card_name: string;
  quantity: number;             // Usually 1, but cubes can have duplicates
  drafted: boolean;             // Always populated
  drafted_by: string | null;    // Only when include_draft_results
  drafted_pick_n: number | null;// Only when include_draft_results
  mana_cost?: string | null;    // Only when include_card_details
  type_line?: string | null;    // Only when include_card_details
  colors?: string[] | null;     // Only when include_card_details
  color_identity?: string | null;// Only when include_card_details
}
```

## Query Strategy

Single query joining drafts → cube_snapshot_cards → cards with LEFT JOIN to pick_events:

```sql
SELECT
  d.draft_id, d.draft_name, d.draft_date,
  c.name AS card_name,
  csc.qty AS quantity,
  c.scryfall_json,
  pe.player_id AS drafted_by,
  pe.pick_n AS drafted_pick_n
FROM drafts d
JOIN cube_snapshot_cards csc ON d.cube_snapshot_id = csc.cube_snapshot_id
JOIN cards c ON csc.card_id = c.card_id
LEFT JOIN pick_events pe ON pe.draft_id = d.draft_id AND pe.card_id = c.card_id
WHERE d.draft_id = ?
ORDER BY c.name ASC
```

Post-query processing in TypeScript:
1. Parse Scryfall JSON for card details (color_identity, type_line, mana_cost)
2. Apply filters (color, type_contains, name_contains)
3. Build flat `cards` array or `grouped` object based on `group_by`
4. Strip fields based on `include_draft_results` and `include_card_details`

## Grouping Logic

### Color Identity (`group_by: "color_identity"`)

- Each card appears in exactly one group
- Groups: mono colors (W, U, B, R, G), colorless (C), multicolor (UB, WUG, etc.)
- Color identity normalized to WUBRG order (e.g., "UG" not "GU")

### Type (`group_by: "type"`)

- Cards can appear in multiple groups if they have multiple major types
- Groups: Creature, Planeswalker, Artifact, Enchantment, Instant, Sorcery, Land
- Example: "Artifact Creature" appears in both Artifact and Creature groups
- Parse type_line and check for each major type keyword

### Filter + Group Interaction

Filters apply first, then grouping. `total_cards` reflects post-filter count.

## Examples

### Minimal call
```json
{ "draft_id": "tarkir" }
```

Response:
```json
{
  "draft_id": "tarkir",
  "draft_name": "Tarkir",
  "draft_date": "2025-12-01",
  "total_cards": 540,
  "cards": [
    { "card_name": "Abrupt Decay", "quantity": 1, "drafted": true, "drafted_by": null, "drafted_pick_n": null },
    { "card_name": "Acidic Slime", "quantity": 1, "drafted": false, "drafted_by": null, "drafted_pick_n": null }
  ],
  "grouped": null
}
```

### With draft results
```json
{ "draft_id": "tarkir", "include_draft_results": true }
```

Response includes who picked each card and when:
```json
{
  "cards": [
    { "card_name": "Abrupt Decay", "quantity": 1, "drafted": true, "drafted_by": "arborist77", "drafted_pick_n": 42 },
    { "card_name": "Acidic Slime", "quantity": 1, "drafted": false, "drafted_by": null, "drafted_pick_n": null }
  ]
}
```

### Filtered and grouped
```json
{ "draft_id": "tarkir", "color": "G", "group_by": "type", "include_card_details": true }
```

Response groups green cards by type:
```json
{
  "draft_id": "tarkir",
  "total_cards": 87,
  "cards": null,
  "grouped": {
    "Creature": [
      { "card_name": "Llanowar Elves", "quantity": 1, "drafted": true, "drafted_by": null, "drafted_pick_n": null, "mana_cost": "{G}", "type_line": "Creature — Elf Druid", "colors": ["G"], "color_identity": "G" }
    ],
    "Instant": [...],
    "Sorcery": [...],
    "Enchantment": [...]
  }
}
```

## Implementation

### Files to modify

| File | Change |
|------|--------|
| `src/core/db/queries.ts` | Add `getDraftPool()` function with params/result interfaces |
| `src/core/llm/tools.ts` | Add `get_draft_pool` to tools array |
| `src/core/llm/toolExecutor.ts` | Add routing case for `get_draft_pool` |

### No schema changes required

Existing tables support this query:
- `cube_snapshot_cards` has pool data per draft
- `pick_events` has draft results for annotation
- `cards.scryfall_json` has card details for filtering/grouping
