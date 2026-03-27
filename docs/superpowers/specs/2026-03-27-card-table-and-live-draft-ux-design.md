# Card Table and Live Draft UX Rework

## Problem

The card table crams too much into limited space. Pick and queue buttons are 4×4px — unusable on mobile. Stats like distribution histograms and sparklines are hidden on anything below 1200px wide. The table tries to serve two roles (scanning cards and analyzing stats) and does neither well on small screens.

Additionally, there is no per-card data on what color pair archetypes a card is typically played in.

## Goals

1. Separate card scanning (table) from card analysis (modal) so each surface can do its job well
2. Make pick, queue, and deck-building actions usable on all screen sizes
3. Add a color pair breakdown stat showing which archetypes play a given card
4. Slim the `getCards()` pipeline to return only what the table needs
5. Improve queue management with reordering and auto-pick invalidation controls

6. Move float state server-side (eliminate localStorage dependency for card state)

## Non-Goals

- Real-time push updates (WebSocket/SSE) for pick events
- Changes to the deck builder panel itself (maindeck/sideboard management stays as-is)
- Cross-draft player identity
- Migrating existing deck builder state (maindeck/sideboard) out of localStorage (future work)

---

## Design

### 1. Card Table (Slimmed)

The table becomes a scannable list of cards with identity and pick score. All analytical stats and action buttons move to the modal.

**Columns retained:**
- Card name (with status icon — see Section 3)
- Mana cost
- Colors
- Type
- Pick score (P#)

**Columns removed:**
- Distribution histogram
- History sparkline
- GPWR / Decklist Win Rate
- Picked (X / Y drafts)

**Responsive breakpoints** remain at four thresholds (mobile, tablet, desktop, wide). Desktop and wide now display the same columns since histogram and sparkline are gone. The breakpoint infrastructure is preserved for other consumers (e.g., nav header).

| Breakpoint | Columns |
|---|---|
| Mobile (<580px) | Card name, Pick score |
| Tablet (580–940px) | + Mana cost, Colors |
| Desktop (940–1200px) | + Type |
| Wide (≥1200px) | Same as Desktop |

**Row interaction:**
- Clicking a card row opens the CardStatsModal
- Rows show hover/pointer styling to indicate clickability
- Card image hover preview remains (quick glance, separate from modal)
- Column header clicks still sort

**Action icons removed from rows.** All pick, queue, and deck-builder icons in `CardNameCell` are replaced by a single status icon (Section 3).

### 2. Card Stats Modal

A responsive modal that shows detailed stats and provides pick/queue/float actions for a single card.

**Trigger:** Click any card row in the table.

**Layout:**
- Desktop (≥640px): side-by-side. Card image + action buttons on the left, stats on the right.
- Mobile (<640px): stacked. Image → action buttons → stats, vertically.

**Content:** No card name, oracle text, type line, or mana cost. The card image conveys identity. The modal is purely for stats and actions.

**Stats displayed** (fetched from `/api/cards/stats` on modal open):
- Pick score (P#)
- Picked count (X / Y drafts)
- Decklist Win Rate — localhost-only, same conditional as the current table column
- Color pair breakdown — new stat (Section 4)
- Pick distribution histogram
- Draft history sparkline

The card image loads immediately using the Scryfall image URL from the row data. Stats show a loading state while the API responds.

**Dismissal:** Escape key or click outside the modal.

**After a successful pick:** Modal closes, table updates to reflect the new pick.

#### Action Buttons

Actions are contextual based on card state and draft context.

**Card has no relationship to you:**
- **Hold to Pick** — green, prominent. ~1.5-second hold with a progress bar filling left-to-right. Releasing early cancels. On completion: visual flash + haptic pulse on mobile via `navigator.vibrate()` (progressive enhancement, no-op on unsupported browsers). Only shown when it is the user's turn.
- **Queue** — blue, secondary. Simple tap. Adds to end of queue.
- **Float** — tertiary styling. Simple tap. Adds to deck builder speculatively.

**Card is floated:**
- Hold to Pick (if your turn)
- Queue (promotes to queued, stays in deck builder)
- Unfloat (removes from deck builder entirely)

**Card is queued:**
- Hold to Pick (if your turn)
- Unqueue (drops back to floated, stays in deck builder)
- Queue position displayed

**Card is picked by you:**
- No action buttons. Stats only. Deck management happens in the deck builder.

**Card is taken by someone else:**
- No action buttons. Stats only. Float is not available.

**Outside live draft mode (historical drafts):**
- No action buttons. Modal is stats-only.

### 3. Card State Model

Each card has exactly one state relative to the current user. This replaces the current system of independent pick/queue/deck-builder icons.

```
States: None | Floated | Queued | Picked

Forward transitions:
  None → Floated (float from modal)
  None → Queued  (queue from modal)
  Floated → Queued (queue from modal, promotes)
  Queued → Picked (pick from modal or auto-pick)

Backward transitions:
  Queued → Floated (unqueue from modal or pod view)
  Floated → None   (unfloat from modal)

Picked is permanent (no backward transition).
```

All three active states (Floated, Queued, Picked) add the card to the deck builder.

**Table row status icon** — a single small icon next to the card name:
- **Picked by you:** solid green checkmark
- **Queued:** blue badge with queue position number
- **Floated:** lighter outline icon (bookmark or pin style)
- **None:** no icon

#### Server-Side Storage

Float state is stored server-side, scoped to the seat token. This eliminates the localStorage dependency for card state (the current `speculativeCards` in `DeckState`).

**New table: `floated_cards`**
```sql
CREATE TABLE floated_cards (
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  card_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (draft_id, seat, card_name),
  FOREIGN KEY (draft_id) REFERENCES drafts(id)
);
```

**API endpoints for float:**
- `PUT /api/drafts/[id]/float` — token-authenticated. Body: `{ card_name: string }`. Adds a card to floated state.
- `DELETE /api/drafts/[id]/float` — token-authenticated. Body: `{ card_name: string }`. Removes a card from floated state.
- `GET /api/drafts/[id]/float` — token-authenticated. Returns all floated cards for the seat.

The deck builder reads floated cards from this table (via the seat token) instead of localStorage. When a floated card is promoted to queued or picked, the float row is deleted (the card is now tracked by the queue or picks table). Conversely, when a card is unqueued, the server automatically creates a `floated_cards` row so the card drops to floated rather than disappearing entirely.

**Accessibility:** Hold-to-pick requires a keyboard-accessible fallback. When the pick button is focused, pressing and holding Enter or Space for the same 1.5-second duration triggers the pick. The progress bar animates identically for both pointer and keyboard holds.

### 4. Color Pair Breakdown (New Stat)

A new field on the existing `/api/cards/stats` response showing which color pair archetypes typically play a given card. Added to the `CardStatsResult` type alongside the existing `pick`, `play`, and `wins` fields.

**Query logic** (new function in `src/core/db/queries/stats/`, alongside existing `cardStats.ts`):
1. Find all decks that maindecked the card (mainboard only, consistent with existing play rate and win rate logic)
2. Infer each deck's color pair using the existing `inferDeckColor` function (30% threshold for second color, canonical WUBRG order)
3. Aggregate by color pair, compute percentage of total decks

**Response shape** (new field on the existing `CardStatsResult`):
```json
{
  "colorPairBreakdown": [
    { "colorPair": "RW", "percentage": 55, "deckCount": 5 },
    { "colorPair": "RB", "percentage": 30, "deckCount": 3 },
    { "colorPair": "UR", "percentage": 15, "deckCount": 1 }
  ]
}
```

**Rules:**
- Top 3 color pairs only
- Filtered to ≥10% of total decks that played the card
- May return fewer than 3 if not enough pairs clear the threshold
- Empty array if the card has never been maindecked
- Respects existing draft ID filters on the stats endpoint

**Display:** Color pills with WUBRG-colored letters and percentage, shown in the modal stats section.

### 5. `getCards()` Pipeline Refactor

The `getCards()` function currently computes analytical stats for every card (distribution arrays, score history, win rates). After this change, the table no longer displays these fields.

**Retained in `getCards()` / `EnrichedCardStats`:**
- `cardName`
- `weightedGeomean` (pick score — exception, needed for table sort)
- `colors` (color identity)
- `maxCopiesInDraft` (badge: "×N" for multiples)
- `timesAvailable` / `draftsPickedIn` (badge: "1d" for low confidence)
- `scryfall` (image URL, mana cost, type line — card identity for table display)
- Draft-contextual state: taken (by whom, when), banned

**Removed from `getCards()`:**
- `pickDistribution` (15-element array per card)
- `scoreHistory` (array of DraftScore objects)
- `decklistWinRate` (win rate object)
- `totalPicks`, `timesUnpicked` (detail stats)

**Benefit:** Reduces initial page payload and computation. Score history arrays and distribution buckets across hundreds of cards add up.

### 5a. `/api/cards/stats` Expansion

The existing `/api/cards/stats` endpoint returns aggregate scalars (`pick`, `play`, `wins` objects). The modal needs additional per-draft detail fields that currently live in `getCards()`. These are added to the `CardStatsResult` response:

**New fields on `CardStatsResult`:**

```typescript
// Per-draft pick positions, ordered by draft date
pickHistory: Array<{
  draftId: string;
  draftName: string;
  draftDate: string;
  pickPosition: number;  // absolute pick number, or poolSize if unpicked
  picked: boolean;
}>;

// 15-bucket distribution (same as current pickDistribution)
pickDistribution: number[];

// Color pair breakdown (Section 4)
colorPairBreakdown: Array<{
  colorPair: string;
  percentage: number;
  deckCount: number;
}>;
```

**`pickHistory`** replaces the current `scoreHistory` array. It contains the raw per-draft pick positions, which the modal uses to render the sparkline. The sparkline component in the modal computes its own x-axis positioning from the `draftDate` fields — it does not need a shared `draftTimeline` array since it renders only one card at a time.

**`pickDistribution`** is the same 15-element bucket array currently computed in `getCards()`. The computation moves to the stats query.

The existing fields (`pick`, `play`, `wins`, `oracle_text`, `type_line`, `mana_cost`, `color_identity`) remain unchanged.

### 6. Queue Management in Pod View

The draft board modal (pod view) gains a queue panel for managing queue order and auto-pick settings.

**Queue panel contents:**
- Ordered list of queued cards
- Drag-to-reorder (or up/down controls)
- Per-card remove button (drops the card back to Floated)
- Visual strike-through for cards that were recently taken by another player (before cleanup)

**Auto-pick settings:**
- Auto-pick toggle (on/off)
- When auto-pick is on, a mode selector:
  - **Resilient:** Skip taken cards, auto-pick next available card in queue. "I trust my queue order."
  - **Cautious:** Pause auto-pick when any queued card is taken by another player. "Something changed, let me reassess." The user must manually re-enable auto-pick or make their pick.

**Queue behavior:**
- Adding a card to the queue (from the card stats modal) always appends to the end
- Unqueueing a card drops it back to Floated (remains in deck builder)
- Queue invalidation (card taken by another player) triggers behavior based on the selected mode

#### Schema Change: Auto-Pick Mode

The `seat_tokens` table currently has `auto_pick INTEGER` (0 or 1). This is extended:

```sql
ALTER TABLE seat_tokens ADD COLUMN auto_pick_mode TEXT NOT NULL DEFAULT 'resilient';
-- Values: 'resilient' | 'cautious'
```

`auto_pick` remains the on/off toggle. `auto_pick_mode` controls behavior when a queued card is invalidated.

#### API Changes

**`PUT /api/drafts/[id]/seat-settings`** — updated request body:
```typescript
{
  autoPick?: boolean;
  autoPickMode?: 'resilient' | 'cautious';
  displayName?: string;
}
```

**`PUT /api/drafts/[id]/queue`** — existing endpoint. Accepts the full ordered queue as an array of card names. This is a full replacement (not a patch), which supports both reordering and removal in a single call:
```typescript
{
  queue: string[];  // ordered list of card names, first = highest priority
}
```

**`GET /api/drafts/[id]/me`** — updated response to include auto-pick mode:
```typescript
{
  seat: number;
  autoPick: boolean;
  autoPickMode: 'resilient' | 'cautious';
  displayName: string;
}
```

#### Auto-Pick Cascade Logic Change

The existing cascade in `processPick.ts` (lines ~116-153) currently checks `auto_pick === 1` and dequeues the next available card. The change:

1. When processing a pick, check if any other seat's queue contained the just-picked card
2. For each affected seat:
   - Remove the taken card from their queue
   - If `auto_pick_mode === 'cautious'`: set `auto_pick = 0` for that seat (pauses auto-pick)
   - If `auto_pick_mode === 'resilient'`: no change, auto-pick continues with next available card
3. When it is a seat's turn and auto-pick is on, pick the first available card in their queue (unchanged from current behavior, but now respects the cautious pause)

---

## Data Flow Summary

```
Page load:
  getCards() → table renders (identity + pick score + draft state + badges)

User clicks row:
  GET /api/cards/stats?card_name=X
    → modal renders (histogram, sparkline, GPWR, picked count, color pairs)
  Card image loads immediately from Scryfall URL (known from row data)

User picks (hold-to-pick completes):
  POST /api/drafts/[id]/pick  { card_name }
    → modal closes
    → table re-fetches getCards() to reflect new pick state
    (same polling mechanism as current live draft status)

User queues:
  PUT /api/drafts/[id]/queue  { queue: [...existing, newCard] }
    → modal updates button state
    → table row shows queue position badge

User floats:
  PUT /api/drafts/[id]/float  { card_name }
    → modal updates button state
    → table row shows float icon
    → deck builder includes card

User unfloats:
  DELETE /api/drafts/[id]/float  { card_name }
    → card removed from deck builder
    → table row icon clears

User unqueues:
  PUT /api/drafts/[id]/queue  { queue: [...withoutCard] }
    → card drops to floated (float row auto-created)
    → table row shows float icon instead of queue badge

Pod view queue panel:
  PUT /api/drafts/[id]/queue → full queue replacement (reorder/remove)
  PUT /api/drafts/[id]/seat-settings → auto-pick toggle + mode

Auto-pick cascade (server-side, on each pick):
  1. Process the pick
  2. Check all other seats' queues for the picked card
  3. Remove from affected queues
  4. If affected seat has auto_pick_mode = 'cautious': set auto_pick = 0
  5. If next seat has auto_pick = 1 and queue is non-empty: auto-pick first available
```

## Table Reactivity After Picks

After a successful pick from the modal, the table updates via the existing live draft polling mechanism (`useLiveDraftStatus`). The status poll detects the new pick, which triggers a `getCards()` re-fetch. This is the same flow used today when another player's pick appears — no new reactivity mechanism is needed. The modal closes optimistically on pick completion; the table catches up on the next poll cycle.

## Migration Notes

- The existing `EnrichedCardStats` type narrows. Components that currently read `pickDistribution`, `scoreHistory`, or `decklistWinRate` from the table data must be updated to fetch from the stats API instead. After this change, those fields only exist in the modal context.
- The `CardNameCell` component loses its action icons (pick, queue, deck-builder indicators). These are replaced by the single status icon and the modal actions.
- The current two-click pick confirmation (click → confirm pulse) is replaced by hold-to-pick in the modal.
- The auto-pick cautious mode is a new concept. The existing auto-pick cascade logic in `processPick.ts` must be extended to check the mode setting and detect queue invalidation events.
- The current `speculativeCards` in `DeckState` (localStorage) is replaced by the server-side `floated_cards` table. The deck builder hook reads floated cards from the API instead of localStorage. Existing localStorage speculative data is not migrated — it is simply ignored once the new system is active.
- New DB migration needed: `floated_cards` table and `auto_pick_mode` column on `seat_tokens`.
