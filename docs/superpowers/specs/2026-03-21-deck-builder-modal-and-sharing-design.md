# Deck Builder Modal & Sharing Redesign

## Problem

The deck builder renders as an inline panel between the controls bar and the card table. This steals vertical space from both: the deck builder is capped at 45vh, and the card table gets whatever remains. Neither view has enough room to work comfortably.

Sharing compounds the problem. Shared deck links (`/deck/abc123`) load a standalone page with only the deck builder — no card table, no draft context. The viewer sees the deck in isolation, without the stats and pool information that give it meaning.

## Design

### 1. Sticky Controls Bar

The controls bar (search, color filter, deck builder toggle, active draft indicator) becomes `position: sticky; top: 0` with a z-index above the table content and a solid background so it doesn't bleed through. The card table's `<thead>` also sticks, using a `top` offset equal to the controls bar's rendered height (measured via a ref or CSS custom property). Together they form a persistent toolbar: you can always search, filter, and open the deck builder, and you always see what columns you're looking at.

The site header (logo, title, settings gear) and draft stats row scroll away normally. No collapsing or transforming behavior — just CSS sticky positioning.

### 2. Deck Builder Modal

The deck builder becomes a near-fullscreen modal overlay. It fills most of the viewport with small margins, backed by a dark overlay that dims the card table behind it.

The existing deck builder content — toolbar, sideboard zone, deck zone, drag-and-drop — stays the same. It just renders inside the modal instead of inline. The `max-height: 45vh` constraint is removed; the deck zones use the full modal height, with internal scrolling as needed.

**Quick-toggle behavior.** The "Deck Builder" button in the sticky controls bar toggles the modal. Four ways to close: the sticky bar button, the Escape key, clicking the dark overlay, or the close button in the modal header. All four hide the modal without discarding deck state.

**Persisted open/closed state.** The `showDeckBuilder` boolean is stored in localStorage (e.g. key `deckBuilderOpen`) and managed in `PageClient` (not in `useDeckBuilder`, which manages deck content state only). On page load, if the value is `true` and a valid active draft + seat exist, the modal auto-opens. Deselecting the active draft closes the modal and resets the stored state.

**Priority order.** The `?deck=` query param takes precedence over localStorage. If the param is present, the modal opens regardless of the stored `deckBuilderOpen` value.

**Speculative card interactions.** The deck builder has two states: *active* (a deck is being built — the user has opened the deck builder at least once for this draft/seat) and *modal visible* (the overlay is showing). These are decoupled. Speculative add/remove buttons appear on the card table whenever the deck builder is active, regardless of whether the modal is open. When the modal is open, the table is behind the overlay and not interactive. The typical workflow: open modal to review the deck, close modal to browse the table and add speculative picks (buttons visible), reopen modal to see updates.

### 3. Sharing Flow

**Link format.** The share button generates `/?deck=abc123` instead of `/deck/abc123`. The POST `/api/deck` route stays unchanged. The `/deck/[id]` page route, `SharedDeckClient` component, and associated server component are deleted. The GET `/api/deck/[id]` API route remains (it serves the deck JSON with immutable caching headers).

**Landing on a shared link.** `PageClient` reads the `deck` query param on mount. If present, it fetches the shared deck state from GET `/api/deck/{deckId}`, then sets `activeDraft` and `selectedSeat` via the existing `useDraftSelection` setters (`setActiveDraft`, `setSelectedSeat`) — these already exist and trigger card data fetching for the selected draft. It then dispatches `INIT_FROM_SNAPSHOT` to load the deck into the reducer and opens the modal.

**Refresh behavior.** Refreshing with `?deck=abc123` in the URL re-fetches the original shared deck and loads it fresh, overriding whatever was in localStorage. Local edits from before the refresh are lost.

**Fork on edit.** The shared deck in Turso is immutable. Edits after landing on a shared link are local. Clicking "Share Deck" creates a new entry and copies a new `/?deck=xyz789` URL to the clipboard. The address bar retains the original `?deck=abc123` param.

**Query param lifecycle.** The `?deck=` param stays in the URL for the duration of the session. It is not stripped after loading.

## Components Affected

| Component | Change |
|---|---|
| `PageClient.tsx` | Read `deck` query param, fetch shared deck, manage sticky + modal state |
| `DeckBuilderPanel.tsx` | Wrap in modal overlay; remove inline layout styles; remove max-height constraint |
| `CardTable.tsx` | Make `<thead>` sticky below the controls bar |
| `useDraftSelection.ts` | Existing setters used to set draft/seat from shared deck state |
| `handleShareDeck` (in DeckBuilderPanel) | Generate `/?deck=` URLs; re-enable the share button |
| `/app/deck/[id]/` | Delete route, page, and `SharedDeckClient` |
| `/api/deck/[id]/route.ts` | Keep as-is (GET endpoint for shared deck data) |
| `/api/deck/route.ts` | Keep as-is (POST endpoint to create shared deck) |

## Out of Scope

- Collapsing or transforming the header on scroll
- Real-time collaborative editing of shared decks
- Mobile-specific layout changes
