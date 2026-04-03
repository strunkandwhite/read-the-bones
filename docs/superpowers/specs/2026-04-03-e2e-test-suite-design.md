# E2E Test Suite Redesign — Design Spec

## Context

The existing e2e test suite has 15 tests (6 failing from UI drift) across 4 spec files. Coverage is limited to read-only browsing. The live draft flow, deck builder interactions, queue/float management, multi-copy logic, and spectator viewing are untested. The goal is a fresh start: a regression safety net organized around user journeys, using route-mocking with expanded fixtures.

## Architecture

### Approach: Flow-Based Tests with Route Mocking

Tests organized by user journey, not by component. All API routes mocked with JSON fixtures — no real database. The existing `E2E_TEST=1` build approach is kept (fixture data for SSR, separate `.next-e2e` build dir).

### Directory Structure

```
e2e/
  fixtures/
    cards-40.json           # 40 cards with color/type/mv distribution
    draft-stats.json        # Win rates, stats modal data
    drafts-list.json        # 2-3 drafts (one active mid-draft, one completed)
    live-board.json         # Board matrix: 10 seats, ~22 picks, seat 3's turn
    live-me.json            # Auth response: { seat: 3, autoPick: true, displayName: "Alice" }
    live-queue.json         # Queue entries: mix of pause/flow-through, singles+groups
    live-floats.json        # Floated card list
    live-available.json     # Available cards for pick autocomplete
    deck-state.json         # Saved deck: maindeck + sideboard + basics + floated cards
    shared-deck.json        # Shared deck snapshot
    standings.json          # Match results for completed draft
    sync-status.json        # Active draft sync state
    ssr-fixtures.ts         # TypeScript re-exports for SSR (cards-40 + draft-stats)
  helpers/
    mock-api.ts             # createMockContext(scenario) — composes fixture subsets per scenario
    auth.ts                 # authenticateAs(page, {draftId, seat, displayName}) — sets localStorage token + mocks /me
    assertions.ts           # Reusable: expectCardTableToShow(), expectPhase(), expectQueueContains()
    card-table.ts           # DOM helpers: getVisibleCardNames(), clickColumnHeader()
  flows/
    browse.spec.ts          # Read-only analytics experience (10 tests)
    live-draft.spec.ts      # Core drafting loop, authenticated (12 tests)
    deck-builder.spec.ts    # Deck building and sharing (9 tests)
    shared-deck.spec.ts     # Loading shared deck snapshots (3 tests)
    spectator.spec.ts       # Unauthenticated seat/draft viewing (4 tests)
  playwright.config.ts      # Keep existing config, same port/browser/timeouts
```

### Fixture Design: cards-40.json

~40 real MTG cards with deliberate distribution:
- **By color**: ~6 each of W/U/B/R/G, ~4 colorless, ~4 multicolor (gold pairs like UB, RG)
- **By type**: ~12 creatures, ~8 instants, ~5 sorceries, ~4 artifacts, ~3 planeswalkers, ~4 lands, ~2 enchantments
- **By mana value**: spread across 0-7+ for mv queries
- **Oracle text variety**: flying, trample, "draw a card", "destroy target", "counter target"
- **Multi-copy cards**: "Lightning Bolt" (2 copies, 0 taken) and "Scalding Tarn" (2 copies, 1 taken by seat 5)
- **Cross-fixture consistency**: card names in live-board.json picks match cards-40.json exactly

### Helper: createMockContext(scenario)

Scenarios compose fixture subsets:
- **browse**: cards-40, draft-stats, drafts-list, sync-status
- **live-draft**: all of browse + live-board, live-me, live-queue, live-floats, live-available, standings
- **deck-builder**: all of live-draft + deck-state
- **spectator**: browse + live-board (no auth, no queue/float)
- **shared-deck**: browse + shared-deck + draft-stats

## Test Flows

### flows/browse.spec.ts (10 tests)
1. Page loads with 40 cards
2. Name search filters
3. Type search (`t:creature`)
4. Oracle text search (`o:"draw a card"`)
5. Color filter pills
6. Mana value search (`mv<=2`)
7. Combined query (`t:instant c:u`)
8. Column sorting toggle
9. Draft selection triggers refetch
10. Empty state when no drafts selected

### flows/live-draft.spec.ts (12 tests)
1. Auth and turn detection (pulse animation, settings badge)
2. Draft board opens with matrix and phase badge
3. Pick via autocomplete (empty cell → type → select → POST /pick)
4. Pick via card stats modal (hold-to-confirm 1500ms → POST /pick)
5. Board updates on poll (opponent pick appears)
6. Queue from stats modal
7. Unqueue from stats modal
8. Float from stats modal
9. Unfloat from stats modal
10. Multi-copy queue: full availability (2 copies, queue 2, reject 3rd)
11. Multi-copy queue: one publicly taken (2 copies, 1 taken, can only queue 1; but queued copies don't reduce limit)
12. Phase transition (drafting → playing hides queue panel)

### flows/deck-builder.spec.ts (9 tests)
1. Opens on active draft with header info
2. Loads saved deck state into zones
3. Move card between zones (maindeck ↔ sideboard)
4. Promote floated card to queued (click queue button on floated DeckCard)
5. Demote queued card to floated (click unqueue button, card stays in deck builder)
6. Add basic lands (+/- buttons in dialog)
7. Clear deck
8. Share deck (POST /api/deck, URL copied)
9. Save persistence (PUT /deck-state fires on change)

### flows/shared-deck.spec.ts (3 tests)
1. Load shared deck from `?deck=id` URL
2. Shows source draft and seat info
3. Card stats modal opens from shared deck

### flows/spectator.spec.ts (4 tests)
1. Seat picks highlighted in card table
2. Seat deck visible in deck builder
3. Pod view shows full draft snapshot
4. Switch seats updates card table and deck builder

## Total: ~38 tests
