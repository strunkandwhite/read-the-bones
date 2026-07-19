# Deck Builder for Synced Sheet Drafts — Design

**Date:** 2026-07-19
**Status:** Approved

## Problem

The deck builder works fully only for live (in-app) drafts: adding speculative
cards (floats), and persistence of the work-in-progress deck arrangement, both
require a seat token. Synced sheet drafts have no tokens, so while the deck
builder panel already opens and auto-populates from the selected seat's picks,
there is no way to add an unpicked card, and any arrangement (maindeck/sideboard
moves, columns, basic lands) is lost on reload.

## Goals

- Add an "Add to deck builder" button for sheet drafts — the float-button
  analog — so unpicked cards can be added to the seat's WIP deck.
- Persist the full WIP deck (added cards + arrangement + basic lands) in
  localStorage, keyed by draft **and** seat, so nothing leaks between seats.
- No draft-state DB writes and no auth for sheet drafts.
- Live drafts (all phases, including spectators) are unaffected.

## Non-goals

- Queue mechanics for sheet drafts (queue stays live-only).
- Cleanup of stale localStorage keys for old drafts (negligible size).
- Cross-device sync of sheet-draft WIP decks.

## Design

### 1. Local deck mode

A derived condition: **local deck mode** = active draft is a sheet draft AND
`selectedSeat !== null`.

The client cannot currently distinguish sheet drafts from live drafts (both
share the `setup → drafting → playing → complete` phase lifecycle and
`sheet_id` never leaves the server). The `/api/drafts/[id]/live` route adds an
`isSheetDraft` boolean (derived from `sheet_id IS NOT NULL`) to the board
payload, flowing into `BoardData` in `draftStore`. Read-only; no schema or
write changes.

### 2. The button

In `CardStatsModal`, the existing float button renders in local mode, relabeled
**"Add to deck builder"** ("Remove from deck builder" when already added). It
calls the same `addFloat`/`removeFloat` liveStore actions. Queue and pick
buttons remain live-only.

In the deck builder panel, locally-added cards get the existing floated-card
treatment: dimmed styling and the ✕ remove button. The queue-toggle button on
floated cards is suppressed in local mode.

### 3. State & persistence

Two localStorage keys, both scoped by draft and seat:

- **`localFloats:<draftId>:<seat>`** — the added-cards list, backing the
  existing `floatedCards` slice. `mutateFloat` branches: in local mode it
  updates state + localStorage and skips the HTTP call. `fetchFloatedCards`
  loads from this key in local mode.
- **`localDeckState:<draftId>:<seat>`** — the full `DeckState` (zones, columns,
  basic lands). `flushDeckSave` branches to a localStorage write. The save key
  is derived from `deckState.draftId`/`deckState.seat` — not the current
  selection — so a mid-debounce seat switch cannot write to the wrong key.
  `fetchDeckState` gains an else-branch: load, run `migrateDeckState`, dispatch
  `INIT_FROM_SNAPSHOT`. Empty state is initialized with correct identity via
  `createEmptyDeckState(activeDraft, selectedSeat)` — fixing the current
  `draftId: "", seat: 0` fallback (wrong panel header, broken share identity).

The `isAuthed` gates in `computeMyDeckCardNames`, `DeckBuilderPanel`'s
`effectiveFloatedCards`, and `syncDeckWithPicks` widen to
`isAuthed || localDeckMode`. Existing dedup against picks means a locally-added
card that the seat later actually picks (via sheet sync) simply becomes a real
pick — no duplicate.

Share Deck (`POST /api/deck`) already requires no auth; with identity fields
fixed, sharing sheet-draft decks works with no further changes.

### 4. Seat switching

Today `fetchDeckState`/`fetchFloatedCards` run only on draft switch. New
wiring: when `selectedSeat` changes in local mode, flush any pending save (to
the old seat's key), then reload floats + deck state for the new seat. Each
seat has an independent WIP deck.

### 5. Error handling & edge cases

- localStorage reads/writes wrapped in try/catch, failing silently to
  in-memory-only behavior (matches existing ad-hoc localStorage usage:
  `selectedSeats`, `seatToken:<draftId>`, `deckBuilderOpen`).
- Corrupt/unparseable stored JSON → fall back to an empty deck.
- Save-status indicator shows the normal "Saved" flow (localStorage writes are
  synchronous, so effectively instant).
- Shared-deck viewing (`?deck=`) already bypasses save paths — unchanged.

### 6. Testing

- Unit tests for the localStorage persistence branches: save/load,
  `migrateDeckState` on load, corrupt-data fallback, per-seat keying, and
  local-mode gating logic.
- One e2e spec: sheet draft → select seat → add card via the card stats modal →
  arrange → reload → verify the deck (including the added card) is restored;
  switch seat → verify isolation.

## Key integration points

| Concern | File |
| --- | --- |
| Sheet-draft flag in board payload | `src/app/api/drafts/[id]/live/route.ts`, `src/app/stores/draftStore.ts` (`BoardData`) |
| Button gating & label | `src/app/components/CardStatsModal.tsx` |
| Float mutate/fetch branch | `src/app/stores/live/queueFloat.ts` |
| Deck save/load branch, identity | `src/app/stores/live/deckSave.ts` |
| Auth-gate widening | `src/app/stores/computeMyDeckCardNames.ts`, `src/app/components/deck-builder/DeckBuilderPanel.tsx` |
| Seat-switch wiring | `src/app/stores/liveStore.ts` / `src/app/stores/wiring.ts` |
