# Server-Side Deck Persistence

## Problem

Deck builder state persists to localStorage, while most other draft state (picks, queues, floats) flows through the API. This creates a split source of truth. localStorage also accumulates artifacts across drafts and doesn't survive device changes.

The `shared_decks` table stores immutable deck snapshots separately from the work-in-progress deck concept, even though both hold the same `DeckState` shape. Viewing a shared deck currently writes to localStorage as a side effect.

## Design

### 1. Unified `decks` Table

Replace `shared_decks` with a single `decks` table that holds both mutable WIP deck state and immutable shared snapshots:

```sql
CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  seat INTEGER NOT NULL,
  deck_state TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('wip', 'snapshot')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_decks_wip ON decks(draft_id, seat) WHERE kind = 'wip';
```

The partial unique index ensures one WIP row per seat+draft while allowing multiple snapshots. Both kinds store the same `DeckState` JSON shape.

**Access patterns:**

| Operation | Query |
|---|---|
| Load WIP deck | `SELECT ... WHERE draft_id = ? AND seat = ? AND kind = 'wip'` |
| Save WIP deck | `INSERT ... ON CONFLICT (draft_id, seat) WHERE kind = 'wip' DO UPDATE` |
| View shared snapshot | `SELECT ... WHERE id = ? AND kind = 'snapshot'` |
| Create snapshot | `INSERT` new row with `kind = 'snapshot'`, copying `deck_state` from WIP |

### 2. API Endpoints

**`GET /api/drafts/[id]/deck-state`** (authenticated via seat token)
- Seat resolved from token (consistent with `/queue`, `/me`)
- Returns `DeckState` JSON for the authenticated seat's WIP row
- 404 if no WIP exists yet
- Deck contents are sensitive because they include queued and floated picks

**`PUT /api/drafts/[id]/deck-state`** (authenticated via seat token)
- Validates body with `validateDeckState()`
- Upserts into `decks` with `kind = 'wip'`
- Returns `{ ok: true }`

**`GET /api/deck/[id]`** (public, unchanged behavior)
- Queries `decks` where `id = ? AND kind = 'snapshot'`
- Immutable caching: `Cache-Control: public, s-maxage=31536000, immutable`
- 404 if not found

**`POST /api/deck`** (unchanged behavior)
- Creates a snapshot row in `decks` with `kind = 'snapshot'`
- Returns `{ deckId }`

### 3. Client-Side Data Flow

**`useDeckBuilder` hook — localStorage replaced with API:**

- On mount: fetch `GET /api/drafts/[id]/deck-state` with seat token. If found, dispatch `INIT_FROM_SNAPSHOT`. If 404, dispatch `INIT_FROM_PICKS` (fresh deck from picks).
- On state change: debounce 1 second, then `PUT /api/drafts/[id]/deck-state`. A dirty flag prevents PUTting unchanged state.
- On unmount with unsaved changes: flush immediately (no debounce).
- All `localStorage.getItem`/`setItem` calls removed. `getStorageKey` and `loadFromStorage` helpers deleted.

**`useSharedDeckLoader` hook — simplified:**

- Fetches `GET /api/deck/[id]` (snapshot) as today
- Dispatches `INIT_FROM_SNAPSHOT` to populate the view in memory
- No longer calls `loadSnapshot` (which wrote to localStorage)
- Navigating away discards the snapshot view — no side effects

**`loadSnapshot` callback — removed.** It existed to pre-empt localStorage hydration. With localStorage gone, shared deck viewing just dispatches `INIT_FROM_SNAPSHOT` directly.

**`useDeckBuilderSync` hook — unchanged.** `SYNC_PICKS` reconciliation still works the same. New picks are added to the deck, and the debounced save persists the result.

### 4. Debounced Save Strategy

- **Debounce window:** 1 second after the last reducer action.
- **In-flight handling:** If a save is in-flight and the user makes another change, queue the next save for after the current one completes. No concurrent PUTs.
- **Unmount flush:** If the deck builder closes with unsaved changes, fire the save immediately.
- **No conflict resolution:** Only one user can write to a given seat's WIP (enforced by token auth). Last write wins.
- **Error handling:** On PUT failure, keep dirty state and retry on the next debounce cycle. No user-facing error — quiet retry.

### 5. Save Indicator

A subtle status indicator in the deck builder toolbar:

- **Saving:** small spinner or pulsing dot
- **Saved:** green checkmark that fades out after ~2 seconds
- **Idle:** no indicator visible

Non-intrusive visual feedback that changes are persisting.

### 6. Migration

1. Create `decks` table with schema and partial unique index
2. Migrate existing `shared_decks` rows into `decks` with `kind = 'snapshot'`, mapping `deck_id` to `id`
3. Drop `shared_decks` table
4. No localStorage migration — existing localStorage deck states are abandoned. On first load after the change, users get `INIT_FROM_PICKS` (fresh deck from their picks). This is the same experience as opening on a new device today.

## Files Changed

**New files:**

| File | Purpose |
|---|---|
| `src/core/db/queries/decks.ts` | Query functions: `getWipDeck`, `upsertWipDeck`, `createSnapshot`, `getSnapshot` |
| `src/app/api/drafts/[id]/deck-state/route.ts` | GET/PUT for WIP deck state |
| `src/app/hooks/useDeckSaveIndicator.ts` | Save status state (idle/saving/saved) for toolbar indicator |

**Modified files:**

| File | Change |
|---|---|
| `src/core/db/schema.sql` | Add `decks` table, drop `shared_decks` |
| `src/app/hooks/useDeckBuilder.ts` | Replace localStorage with fetch-on-mount + debounced PUT |
| `src/app/hooks/useDeckBuilderSync.ts` | Remove localStorage assumptions |
| `src/app/hooks/useSharedDeckLoader.ts` | Remove `loadSnapshot` call, dispatch `INIT_FROM_SNAPSHOT` in memory only |
| `src/app/components/deck-builder/DeckBuilderPanel.tsx` | Add save indicator to toolbar, remove `loadSnapshot` prop |
| `src/app/api/deck/route.ts` | Insert into `decks` with `kind = 'snapshot'` |
| `src/app/api/deck/[id]/route.ts` | Query `decks` where `kind = 'snapshot'` |

**Deleted files:**

| File | Reason |
|---|---|
| `src/core/db/queries/sharedDecks.ts` | Replaced by `decks.ts` |

**Tests:**

| File | Change |
|---|---|
| `src/core/deckBuilder.test.ts` | Unchanged — reducer tests don't touch persistence |
| `src/app/hooks/useDeckBuilder.test.ts` | Rewrite to mock API calls instead of localStorage |
| `src/app/hooks/useDeckBuilderSync.test.ts` | Minor updates |
| New test files | API route tests, `decks.ts` query tests |

## Scope Boundaries

- **`deck_cards` table untouched.** It stores imported decklists from sealeddeck.tech in a normalized relational format for analytics (play rates, win rates). Different purpose, different shape.
- **No real-time collaboration.** Only the seat owner reads and writes their WIP deck. No multi-viewer support.
- **No offline support.** If the API is unreachable, saves retry silently. No localStorage fallback.
