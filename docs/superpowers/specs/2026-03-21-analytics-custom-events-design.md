# Analytics Custom Events Design

## Overview

Add custom event tracking to Read the Bones using Vercel's `track()` function from `@vercel/analytics`. The site already has `<Analytics />` for pageview tracking; this adds targeted events for feature engagement and client-side performance monitoring.

## Constraints

- **Vercel Pro plan**: max 2 custom data properties per event
- **Property values**: strings, numbers, booleans, null — no nested objects, 255 char max
- **User base**: ~30 users max, so event volume is not a concern
- **Package**: `@vercel/analytics@2.0.1` already installed

## Event Catalog

### Engagement Events

| Event Name | Property 1 | Property 2 | Trigger |
|---|---|---|---|
| `search` | `query_type`: "name", "type", "oracle", "color", "cmc", "multi" | `result_count`: number | Debounced search execution |
| `color_filter` | `colors`: e.g. "UB", "R" | `mode`: "inclusive" or "exclusive" (matches `ColorFilterMode` type) | Color filter change |
| `sort_column` | `column`: e.g. "pick_score", "gpwr", "name" | `direction`: "asc" or "desc" | Column header click |
| `active_draft_set` | `draft`: draft name | — | Active draft dropdown change |
| `seat_selected` | `draft`: draft name | `seat`: seat number | Seat dropdown change |
| `pool_as_of_changed` | `draft`: draft name | — | Pool-as-of dropdown change |
| `deck_builder_open` | `draft`: draft name | `seat`: seat number | Deck builder toggle open |
| `deck_card_add` | `zone`: "deck" or "sideboard" | `source`: "table" or "drag" | Card added to deck |
| `deck_shared` | `draft`: draft name | `card_count`: number | Share deck button clicked |
| `settings_open` | — | — | Gear icon click |

### Performance & Monitoring Events

| Event Name | Property 1 | Property 2 | Trigger |
|---|---|---|---|
| `slow_render` | `component`: "card_table", "deck_builder", "draft_stats" | `duration_ms`: number | Render exceeds 500ms threshold |
| `sync_completed` | `duration_ms`: number | `picks_found`: number | Successful active draft sync |
| `sync_failed` | `error`: message (truncated to 255 chars) | `draft`: draft name | Sync polling or manual sync fails |
| `sync_manual` | `draft`: draft name | `seconds_since_last`: number | Sync Now button clicked |
| `page_load` | `duration_ms`: number | `card_count`: number | Initial data load and first render complete |

## Implementation Approach

### Client-Side Events

All events use `import { track } from '@vercel/analytics/react'` and are called directly in event handlers or effect hooks. (Using the `/react` subpath since all tracking is in client components.)

### Engagement Events — Placement

- **`search`**: In the search hook, after debounced query execution. Classify query type by parsing which prefixes are present (t:, o:, c:, cmc). Use "multi" when multiple prefixes appear, "name" for plain text. Note: "multi" loses which specific prefixes were combined, but the 2-property limit prevents adding a second dimension. This is an acceptable trade-off for an initial pass.
- **`color_filter`**: In the color filter change handler. Concatenate selected color letters for the `colors` property.
- **`sort_column`**: In the column header click handler in CardTable.
- **`active_draft_set`**: In the `onActiveDraftChange` callback in PageClient (where state actually changes), not inside Settings.
- **`seat_selected`**: In the seat change handler in PageClient, alongside the state update.
- **`pool_as_of_changed`**: In the `onPoolAsOfDraftChange` callback in PageClient.
- **`deck_builder_open`**: In the deck builder toggle handler, only on open (not close).
- **`deck_card_add`**: In the deck builder card add handler. Distinguish `source` by whether the add came from the table's + button ("table") or drag-and-drop ("drag").
- **`deck_shared`**: In the share deck button handler. This feature is currently disabled and being designed in a separate spec (`2026-03-21-deck-builder-modal-and-sharing-design.md`). Add the `track()` call when the sharing feature is implemented.
- **`settings_open`**: In the Settings component, on gear icon click.

### Performance Events — Placement

- **`slow_render`**: Use `performance.now()` in `useEffect` hooks on key components (CardTable, DeckBuilderPanel, DraftStats). Measure time between render start and effect execution. Fire only when duration exceeds 500ms.
- **`sync_completed`**: In the sync hook, after a successful sync response. Capture elapsed time and number of new picks.
- **`sync_failed`**: In the sync hook's error handler. Truncate error message to 255 chars. Note: `useSyncStatus` currently swallows errors with an empty `catch {}` block — this will need to be modified to surface errors for tracking.
- **`sync_manual`**: In the Sync Now button handler. Compute seconds since last sync from the stored timestamp.
- **`page_load`**: In the main page component's initial load effect. Measure from navigation start (or component mount) to when card data is available.

### Slow Render Measurement

Wrap render-heavy components with a timing pattern:

```tsx
function useSlowRenderTracking(component: string, thresholdMs = 500) {
  const renderStart = performance.now();
  const lastTracked = useRef(0);

  useEffect(() => {
    const now = performance.now();
    const duration = now - renderStart;
    if (duration > thresholdMs && now - lastTracked.current > 30_000) {
      lastTracked.current = now;
      track('slow_render', { component, duration_ms: Math.round(duration) });
    }
  });
}
```

This fires on every render but only tracks when the threshold is exceeded and at most once per 30 seconds per component, to avoid noise during rapid re-renders (e.g. search debouncing, drag-and-drop).

## What We're Not Tracking

- **Draft checkbox selection**: Users aggregate drafts frequently; not actionable.
- **Card hover/image preview**: Too noisy, low signal.
- **Drag-and-drop reordering within deck builder**: Internal arrangement isn't meaningful.
- **Settings close / deck builder close**: Opens tell us about interest; closes don't add much.
- **Server-side events**: No server-side actions warrant tracking at this scale.

## Dashboard Usage

Events appear in Vercel's Analytics > Events panel. With this schema:

- **Feature popularity**: Compare event counts across `search`, `color_filter`, `sort_column`, `deck_builder_open` to see what gets used.
- **Search behavior**: Drill into `search` events by `query_type` to see if users leverage Scryfall syntax or just type names.
- **Sync health**: Monitor `sync_failed` count and `sync_completed` durations over time.
- **Polling cadence**: `sync_manual` with `seconds_since_last` reveals if auto-sync is fast enough.
- **Performance regression**: `slow_render` and `page_load` trends show if things are getting slower as data grows.
