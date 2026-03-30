# Data Flow Consolidation Design

## Problem

The app's client-side data flow is fragmented across 17 independent hooks in PageClient, each managing its own state and fetch logic. Two uncoordinated polling loops (live draft status at 3s, sync status at 10s) cascade refetches through useEffect chains. The same data (taken cards, seat info, card metadata) is derived in multiple places. Server-side, some endpoints return overlapping data, and query functions make redundant DB calls.

This makes the codebase hard to reason about: tracing what triggers what requires reading across many files, and adding features means threading data through more hooks and props.

## Goals

- **Single source of truth per domain.** Each piece of state lives in one place. Consumers read from that place.
- **Traceable data flow.** Given a state change, you can follow one path to see all downstream effects.
- **Fewer, smarter network requests.** Unified polling, no redundant fetches, merged endpoints where data overlaps.
- **Thinner PageClient.** Components subscribe to stores directly; PageClient is layout only.

## Non-Goals

- Real-time push (SSE/WebSocket). Polling at 10s is acceptable for rotisserie drafts.
- Server-side rendering changes. The SSR → client hydration boundary stays the same.
- New features. This is a refactor for maintainability.

---

## Architecture: Three Zustand Stores

Replace the 17 hooks with three domain-scoped Zustand stores. Each store owns its state, fetch logic, and derived data. Cross-store communication uses Zustand's `subscribe` API.

```
                    SSR (page.tsx)
                         │
                    initialCardData + initialDraftStats
                         │
                         ▼
              ┌─── useHydration() ───┐
              │                      │
              ▼                      ▼
      ┌──────────────┐      ┌──────────────┐
      │  useDraftStore│◄────►│  useCardStore │
      │              │      │              │
      │  selection   │      │  cardData    │
      │  polling     │──────►  search      │
      │  status      │ data │  filtering   │
      │  board       │ Ver  │  stats modal │
      └──────┬───────┘      └──────────────┘
             │                      ▲
             │ activeDraft          │ seatCardNames
             │ dataVersion          │ takenCardNamesSet
             ▼                      │
      ┌──────────────┐              │
      │  useLiveStore │─────────────┘
      │              │
      │  auth/token  │
      │  queue       │
      │  float       │
      │  picking     │
      │  deck builder│
      └──────────────┘
```

### Store 1: `useDraftStore`

**File:** `src/app/stores/draftStore.ts`

**Owns:** Draft selection, unified polling, live draft status, board data, sync status.

**Replaces:** `useDraftSelection`, `useSyncStatus`, `useLiveDraftStatus`, `useDraftBoard`

#### State

```typescript
interface DraftStoreState {
  // Selection
  selectedDrafts: Set<string>;
  activeDraft: string | null;
  selectedSeat: number | null;
  hideTaken: boolean;
  poolAsOfDraft: string | null;
  completedDraftIds: string[];

  // Polling output
  dataVersion: number;               // Increments when upstream data changes
  liveDraftStatus: LiveDraftStatus | null;
  board: BoardData | null;
  syncStatus: {
    lastSyncedAt: string;
    syncInProgress: boolean;
    activeDrafts: Array<{ id: string; numSeats: number }>;
  };
}
```

#### Actions

```typescript
interface DraftStoreActions {
  // Selection
  setSelectedDrafts(drafts: Set<string>): void;
  setActiveDraft(draftId: string | null): void;   // Resets seat, clears live state
  setSelectedSeat(seat: number | null): void;
  setHideTaken(hide: boolean): void;
  setPoolAsOfDraft(draftId: string | null): void;

  // Polling control
  startPolling(): void;
  stopPolling(): void;
  refreshNow(): Promise<void>;        // Force immediate poll cycle

  // Sync
  triggerSync(): Promise<void>;        // POST /api/sync

  // Board
  patchSeatName(seat: number, name: string): void;  // Optimistic update

  // Hydration
  hydrate(props: { completedDraftIds: string[]; initialDraftId?: string }): void;
}
```

#### Polling Logic

Single 10s interval when `activeDraft` is set:

```
poll():
  1. GET /api/drafts/{id}/live      → liveDraftStatus + board
  2. GET /api/sync-status           → syncStatus
  3. Compare latestPickN, seatNames, lastSyncedAt against previous
  4. If anything changed → increment dataVersion
  5. Schedule next poll in 10s
```

The `/api/drafts/{id}/live` endpoint is new (see Server-Side Changes). It returns both status and board data in one response, eliminating two separate fetches.

#### localStorage Persistence

On every selection change, persist to localStorage:
- `activeDraft` → `localStorage.activeDraft`
- `selectedSeats` → `localStorage.selectedSeats` (JSON map of draftId → seat)
- `hideTaken` → `localStorage.hideTaken`

On hydration, restore from localStorage if available, falling back to SSR props.

---

### Store 2: `useCardStore`

**File:** `src/app/stores/cardStore.ts`

**Owns:** Card data, search, filtering, derived maps, card stats modal.

**Replaces:** `useCardData`, `useCardSearch`, `useCardFiltering`, `useCardStats`

#### State

```typescript
interface CardStoreState {
  // Core data
  cardData: CardStatsResponse;
  draftStats: DraftStatsResponse;
  isLoading: boolean;

  // Search & filtering
  searchQuery: string;
  colorFilter: string[];
  colorFilterMode: string;

  // Card stats modal
  selectedCard: string | null;
  cardStatsDetail: CardStatsData | null;
  cardStatsLoading: boolean;
}
```

#### Derived State (Zustand selectors)

These are computed from `cardData` and memoized. Components subscribe to specific selectors to avoid unnecessary re-renders.

```typescript
// Computed once when cardData changes:
scryfallDataMap: Map<string, ScryCard>       // cardName → Scryfall data
cardStatsMap: Map<string, CardStats>         // cardName → stats
takenCardNamesSet: Set<string>               // Cards taken in active draft
takenCardCounts: Map<string, number>         // cardName → times taken
bannedCardNamesSet: Set<string>              // Banned in active draft

// Computed from cardData + search + draft selection:
displayCards: EnrichedCardStats[]            // After banned/taken filtering
searchFilteredCards: EnrichedCardStats[]     // After search + color filter

// Computed from cardData metadata:
drafts: DraftInfo[]                          // For selector dropdown
availableCount: number                       // Non-banned, non-taken count
```

#### Actions

```typescript
interface CardStoreActions {
  // Search
  setSearchQuery(query: string): void;       // Debounced 500ms
  setColorFilter(colors: string[]): void;
  clearSearch(): void;

  // Card stats modal
  selectCard(name: string): void;            // Fetches /api/cards/stats
  clearSelectedCard(): void;

  // Data
  fetchCardData(): Promise<void>;            // Reads selection from draftStore
  hydrate(initial: CardStatsResponse, draftStats: DraftStatsResponse): void;
}
```

#### Cross-Store Subscription

```typescript
// Inside cardStore initialization:
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => cardStore.getState().fetchCardData()
);
```

When `dataVersion` increments (picks detected, sync completed), the card store refetches. It reads `selectedDrafts`, `activeDraft`, and `poolAsOfDraft` directly from `useDraftStore.getState()` — no prop threading needed.

#### Search Implementation

The Scryfall-style local search currently in `useCardSearch` moves here. On `setSearchQuery`:
1. Update `searchQuery` immediately (for controlled input)
2. After 500ms debounce, parse the query and compute `scryfallMatchNames` against `cardData.cards`
3. Recompute `searchFilteredCards` selector

---

### Store 3: `useLiveStore`

**File:** `src/app/stores/liveStore.ts`

**Owns:** Authentication, pick queue, floated cards, live picking, deck builder.

**Replaces:** `useSeatToken`, `useMySeat`, `usePickQueue`, `useFloatedCards`, `useLiveDraftPicking`, `useDeckBuilder`, `useDeckBuilderSync`

#### State

```typescript
interface LiveStoreState {
  // Auth
  token: string | null;
  mySeat: number | null;
  autoPick: boolean;
  autoPickMode: "resilient" | "cautious";
  displayName: string | null;

  // Queue
  queue: QueueEntry[];
  queuedCards: Map<string, number>;     // cardName → priority

  // Float
  floatedCards: string[];

  // Picking
  pickError: string | null;

  // Deck builder
  deckState: DeckState;
  deckReady: boolean;
  saveStatus: "idle" | "saving" | "saved";
}
```

#### Derived State

```typescript
isAuthed: boolean          // mySeat !== null && mySeat === draftStore.selectedSeat
isMyTurn: boolean          // draftStore.liveDraftStatus?.nextSeat === mySeat
floatedCardsSet: Set<string>
queuedCardNames: string[]
```

#### Actions

```typescript
interface LiveStoreActions {
  // Auth
  initAuth(draftId: string): Promise<void>;  // Read token, fetch /me
  toggleAutoPick(): Promise<void>;
  updateDisplayName(name: string): Promise<void>;
  updateAutoPickMode(mode: string): Promise<void>;
  refreshSettings(): Promise<void>;

  // Queue
  addToQueue(cardName: string): Promise<void>;
  removeFromQueue(cardName: string): Promise<void>;
  reorderQueue(newOrder: QueueEntry[]): Promise<void>;

  // Float
  addFloat(cardName: string): Promise<void>;
  removeFloat(cardName: string): Promise<void>;

  // Picking
  submitPick(cardName: string): Promise<void>;
  clearPickError(): void;

  // Deck builder
  dispatchDeck(action: DeckAction): void;

  // Lifecycle
  reset(): void;    // Called when activeDraft changes
}
```

#### Cross-Store Subscriptions

```typescript
// Reset when active draft changes
useDraftStore.subscribe(
  (state) => state.activeDraft,
  (activeDraft) => {
    liveStore.getState().reset();
    if (activeDraft) liveStore.getState().initAuth(activeDraft);
  }
);

// Refetch queue + sync deck on data version change
useDraftStore.subscribe(
  (state) => state.dataVersion,
  () => {
    const { activeDraft } = useDraftStore.getState();
    const { token, deckReady } = liveStore.getState();
    if (activeDraft && token) {
      // Refetch queue (a picked card may have been removed server-side)
      fetchQueue(activeDraft, token);
      // Sync deck builder with new picks
      if (deckReady) syncDeckWithPicks();
    }
  }
);

// Auto-pick when it's my turn
useDraftStore.subscribe(
  (state) => state.liveDraftStatus?.nextSeat,
  (nextSeat) => {
    const { mySeat, autoPick, queuedCards } = liveStore.getState();
    if (nextSeat === mySeat && autoPick && queuedCards.size > 0) {
      liveStore.getState().submitPick(/* first queued card */);
    }
  }
);
```

#### Pick Flow

```
submitPick(cardName):
  1. POST /api/drafts/{id}/pick with token
  2. If success → draftStore.refreshNow() (triggers immediate poll)
  3. If error → set pickError

  draftStore.refreshNow():
    → Polls /api/drafts/{id}/live
    → Detects latestPickN changed
    → Increments dataVersion
    → Card store refetches (subscription)
    → Live store refetches queue + syncs deck (subscription)
```

#### Deck Builder Sync

The deck builder sync logic (currently in `useDeckBuilderSync`) moves into the store. On `dataVersion` change:

1. Read `seatCardList` from `useCardStore` (cards picked by selected seat)
2. Read `floatedCards` and `queuedCardNames` from own state
3. Dispatch `SYNC_PICKS` to reconcile picks into deck zones
4. Auto-save fires (debounced 1s) via PUT `/api/drafts/{id}/deck-state`

---

### Cross-Store Utility: `getCardStatus`

**File:** `src/app/stores/selectors.ts`

```typescript
export function getCardStatus(cardName: string): CardStatusResult {
  const { takenCardNamesSet } = useCardStore.getState();
  const seatCardNames = useCardStore.getState().seatCardNames;
  const { queuedCards, floatedCardsSet, isAuthed } = useLiveStore.getState();

  if (seatCardNames?.has(cardName)) return { status: "picked" };
  if (isAuthed) {
    const queuePriority = queuedCards.get(cardName);
    if (queuePriority != null) return { status: "queued", queuePosition: queuePriority };
    if (floatedCardsSet.has(cardName)) return { status: "floated" };
  }
  if (takenCardNamesSet?.has(cardName)) return { status: "taken" };
  return { status: "none" };
}
```

Components that need reactive updates to card status use Zustand's `useStore` with a selector that calls this function, ensuring re-renders when the underlying data changes.

---

## PageClient After Migration

```tsx
export function PageClient({ initialCardData, initialDraftStats, initialDraftId }: PageClientProps) {
  // One-time SSR hydration into stores
  useHydration(initialCardData, initialDraftStats, initialDraftId);

  // Pure UI hooks (no data fetching, no store logic)
  const modals = useModalManagement({
    activeDraft: useDraftStore(s => s.activeDraft),
    selectedSeat: useDraftStore(s => s.selectedSeat),
  });
  useScrollLock(modals.deckBuilderModalOpen);
  useSharedDeckLoader();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="mx-auto max-w-7xl px-4 pb-0 pt-4 sm:px-6 lg:px-8">
        <Toolbar />
        <CardTable />
        <Settings />
      </div>
      <CardStatsModal />
      {modals.draftBoardOpen && <DraftBoardModal />}
      {modals.deckBuilderActive && <DeckBuilderPanel />}
    </div>
  );
}
```

Components import stores directly:
- `CardTable` → `useCardStore(s => s.searchFilteredCards)`, `useLiveStore` for card status
- `Settings` → `useDraftStore` for selection + sync, `useLiveStore` for auth display
- `DraftBoardModal` → `useDraftStore(s => s.board)`
- `DeckBuilderPanel` → `useLiveStore` for deck state
- `CardStatsModal` → `useCardStore(s => s.selectedCard)`

---

## Server-Side Changes

### New Endpoint: `GET /api/drafts/[id]/live`

Replaces `/api/drafts/[id]/status` and `/api/drafts/[id]/board`.

**Implementation:** Merge the queries from both routes into one handler.

```typescript
// Queries (run in parallel):
const [draft, latestPickN, recentPicks, picksWithDetails, seatNames, matchCount] =
  await Promise.all([
    getDraftMetadata(client, draftId),
    getLatestPickNumber(client, draftId),
    getRecentPicks(client, draftId, 10),
    getPicksWithCardDetails(client, draftId),
    getSeatDisplayNames(client, draftId),
    getMatchCount(client, draftId),
  ]);
```

**Response shape:**
```typescript
{
  // From old /status
  phase: string;
  numSeats: number;
  picksPerPlayer: number;
  latestPickN: number;
  nextSeat: number | null;
  recentPicks: Array<{ pickN: number; seat: number; cardName: string }>;
  seatNames: Record<string, string>;
  matchCount: number;
  totalMatches: number;
  // From old /board
  picks: Array<{ pickN: number; seat: number; cardName: string; oracleId: string; colorIdentity: string; manaCost: string }>;
  bannedCards: string[];
}
```

**Caching:** `no-cache` (same as current `/status`).

**Delete:** Remove `/api/drafts/[id]/status/route.ts` and `/api/drafts/[id]/board/route.ts`.

### Thread Opt-Outs Through Route Handlers

Add optional `optedOutSeats` parameter to query functions that currently call `getOptedOutSeats` internally:

**Affected functions:** `getPicks`, `getStandings`, `getDraftPool`, `getCardPlayStats`, `getCardWinStats`, `getWinningDecksByColor`

**Change pattern:**
```typescript
// Before (each function fetches internally):
export async function getPicks(params: PickParams) {
  const optedOut = await getOptedOutSeats(params.draftId);
  // ... use optedOut
}

// After (optional parameter, fetch only if not provided):
export async function getPicks(params: PickParams & { optedOutSeats?: Set<number> }) {
  const optedOut = params.optedOutSeats ?? await getOptedOutSeats(params.draftId);
  // ... use optedOut
}
```

Route handlers that call multiple query functions for the same draft fetch opt-outs once and pass them through.

### Consolidate `getCardStats` Sub-Queries

**Current:** 10+ sequential queries for one card.

**Target:** 4-5 queries via consolidation.

1. **Merge pick stats + pick history** — Use a CTE that resolves the card once, then computes both aggregate stats and per-draft history in one pass.

2. **Merge play stats + win stats** — Single query joining `deck_cards` with `match_events`:
```sql
SELECT
  COUNT(DISTINCT dc.draft_id || '-' || dc.seat) as times_maindecked,
  SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat1_wins ELSE me.seat2_wins END) as wins,
  SUM(CASE WHEN me.seat1 = dc.seat THEN me.seat2_wins ELSE me.seat1_wins END) as losses
FROM deck_cards dc
LEFT JOIN match_events me ON dc.draft_id = me.draft_id
  AND (dc.seat = me.seat1 OR dc.seat = me.seat2)
WHERE dc.card_id = ?
```

3. **Cache card resolution** — Resolve card name to card_id once at the start and pass the ID to all sub-queries.

### Batch processPick Seat Queries

**Current:** Per-seat query during auto-pick cascade.
```typescript
for (const seat of affectedSeats) {
  const settings = await getSeatSettings(client, draftId, seat);
  // ...
}
```

**After:** One query, cached for cascade duration.
```typescript
const allSettings = await getAllSeatSettings(client, draftId);
// allSettings: Map<number, SeatSettings>
for (const seat of affectedSeats) {
  const settings = allSettings.get(seat);
  // ...
}
```

---

## Hooks Retained As-Is

These hooks remain because they're pure UI concerns with no data fetching:

| Hook | Reason |
|------|--------|
| `useModalManagement` | Tracks which modal is open. Pure UI state. |
| `useScrollLock` | DOM side effect (body scroll lock). |
| `useHoldToConfirm` | Interaction pattern (long-press gesture). |
| `useSharedDeckLoader` | One-time URL parsing on mount. |
| `useSlowRenderTracking` | Dev tooling. |

---

## Hooks Deleted

These hooks are fully absorbed into stores:

| Hook | Absorbed Into |
|------|---------------|
| `useDraftSelection` | `useDraftStore` |
| `useSyncStatus` | `useDraftStore` |
| `useLiveDraftStatus` | `useDraftStore` |
| `useDraftBoard` (from useLiveDraftStatus) | `useDraftStore` |
| `useCardData` | `useCardStore` |
| `useCardSearch` | `useCardStore` |
| `useCardFiltering` | `useCardStore` |
| `useCardStats` | `useCardStore` |
| `useSeatToken` | `useLiveStore` |
| `useMySeat` | `useLiveStore` |
| `usePickQueue` | `useLiveStore` |
| `useFloatedCards` | `useLiveStore` |
| `useLiveDraftPicking` | `useLiveStore` |
| `useDeckBuilder` | `useLiveStore` |
| `useDeckBuilderSync` | `useLiveStore` |

---

## API Routes Deleted

| Route | Replaced By |
|-------|-------------|
| `/api/drafts/[id]/status` | `/api/drafts/[id]/live` |
| `/api/drafts/[id]/board` | `/api/drafts/[id]/live` |

---

## Migration Strategy

The migration is incremental. Each store can be built and tested independently, with hooks replaced one at a time.

**Phase 1: Draft store** — Replace `useDraftSelection`, `useSyncStatus`, `useLiveDraftStatus`, `useDraftBoard`. Create `/api/drafts/[id]/live` endpoint, delete old routes. This has the highest impact (unified polling) with the fewest downstream consumers.

**Phase 2: Card store** — Replace `useCardData`, `useCardSearch`, `useCardFiltering`, `useCardStats`. Wire up `dataVersion` subscription. This is the largest change (most derived state moves here).

**Phase 3: Live store** — Replace auth, queue, float, picking, deck builder hooks. Wire up cross-store subscriptions. This is the most complex store but has the most self-contained scope.

**Phase 4: PageClient cleanup** — Remove all hook orchestration from PageClient. Update components to import stores directly. Delete hook files and tests.

**Phase 5: Server-side consolidation** — Thread opt-outs, consolidate getCardStats queries, batch processPick. These are independent of the client migration and can be done in parallel.

---

## Verification

### Functional

- All existing tests pass (`pnpm test`)
- E2E tests pass (`pnpm test:e2e`)
- Manual smoke test: open draft page, switch drafts, switch seats, search cards, open stats modal, open draft board, queue/float/pick cards, build a deck

### Performance

- Open browser DevTools Network tab during live draft
- Verify polling is 10s interval (not 3s)
- Verify no duplicate requests per poll cycle
- Count total requests/min during live draft — target: <15/min (down from ~30-40)

### Quality

- `pnpm typecheck` — no type errors
- `pnpm lint` — no warnings
- `pnpm knip` — no unused exports (deleted hooks should not leave orphans)

### Architecture

- No hook imports remaining in PageClient except UI hooks (modal, scroll, shared deck)
- No prop drilling of card data, draft status, or live state through PageClient
- Each store file is self-contained: state + actions + subscriptions + fetch logic
