# Server-Side Card Stats API

Replace client-side draft recomputation with a server-side API. The client becomes a thin display layer; all stat computation and data gating happens on the server.

## Problem

The current architecture precomputes card stats at build time, then ships all raw pick and match data to the client as a JSON blob (~200KB, growing with each draft). When a user changes draft selection, the client recomputes stats in the browser. This creates three problems:

1. **Duplicated logic** — `calculateCardStats()`, `calculateWinEquity()`, and `calculateRawWinRate()` run both at build time (`tursoDataLoader.ts`) and in the browser (`PageClient.tsx`).
2. **Exposed data** — Raw pick positions, match results, and seat-level stats are shipped to the client, even though the UI only displays aggregated rankings.
3. **Growing payload** — `draft-data.json` scales linearly with draft count. At ~200KB for 7 drafts, it will reach ~1.4MB at 50.

## Scope

**In scope:**
- New `getCards()` function: single entry point for card stat computation
- New `/api/cards` API route serving computed stats
- SSR page load using `getCards()` directly (no build-time static generation)
- Edge + browser caching with ingestion-hash-based invalidation
- Server-side localhost detection for gating decklist win rate data
- Remove win equity and raw win rate statistics entirely
- Remove `draft-data.json` generation and all client-side stat computation
- Simplify Settings panel to draft selector only

**Out of scope:**
- Granular API endpoints (split stats/win-rate) — start with one endpoint, decompose later if needed
- ISR or advanced Next.js caching — start with dynamic SSR
- WebSocket or real-time updates

## Architecture

### Shared Computation Function

A single `getCards()` function serves both SSR and the API route:

```typescript
type GetCardsParams = {
  draftIds?: string[];        // defaults to all completed drafts
  includeMatchData: boolean;  // true on localhost, false in production
};

type CardStatsResponse = {
  cards: EnrichedCardStats[];
  draftCount: number;
  cubeCopies: Record<string, number>;
  draftMetadata: Record<string, { name: string; date: string }>;
  draftIds: string[];
  completedDraftIds: string[];
  ingestionHash: string;
};
```

`getCards()` replaces `loadCardDataFromTurso()`. It queries Turso for picks and cube data, runs `calculateCardStats()`, conditionally queries and attaches decklist win rates, enriches with Scryfall data, and returns a `CardStatsResponse`.

### Data Flow

**Initial page load (SSR):**
1. `page.tsx` server component reads the `Host` header to detect localhost.
2. Calls `getCards({ includeMatchData: isLocal })` directly (no HTTP round-trip).
3. Passes the response as a single `initialData` prop to `PageClient`.
4. HTML renders with card data pre-populated. No loading spinner.

**Draft selection change (client):**
1. User toggles drafts in Settings.
2. `PageClient` calls `GET /api/cards?drafts=a,b&v=<hash>`.
3. API route reads `Host` header, calls `getCards()` with the requested draft IDs.
4. Client receives `CardStatsResponse`, swaps it into state. No client-side computation.

### API Route

```
GET /api/cards?drafts=draft-1,draft-2&v=a1b2c3d4
```

**Query parameters:**
- `drafts` — Comma-separated draft IDs. Optional; defaults to all completed drafts.
- `v` — Ingestion hash for cache busting. The client gets this from the SSR page props and includes it in every request.

**Server-derived:**
- `includeMatchData` — Determined from the `Host` request header. `true` for localhost/127.0.0.1, `false` otherwise.

**Response headers:**
- `Cache-Control: public, s-maxage=31536000` — Cache indefinitely at the edge. The `?v=` parameter ensures new ingestions produce new cache keys.
- The API route includes `&local=1` in the cache key when the request originates from localhost. This ensures edge cache entries for localhost (which include decklist win rate) never serve production requests. Simpler and more CDN-compatible than `Vary: Host`.

### Caching Strategy

Two cache layers, both keyed by the full URL (including query parameters):

1. **Vercel edge cache** — Serves cached responses globally without invoking the serverless function. Invalidated naturally when the ingestion hash changes.
2. **Browser cache** — Serves cached responses locally for repeated requests. Toggling back to a previously-viewed draft selection is instant.

**Ingestion hash:** Generated from a hash of draft IDs and the last ingestion timestamp. Stored in Turso (e.g., a metadata row updated by `pnpm ingest`). Queried once during SSR and passed to the client as part of `CardStatsResponse`.

**Invalidation flow:**
1. Run `pnpm ingest` — updates Turso data and ingestion timestamp.
2. Next page load computes a new ingestion hash during SSR.
3. Client receives new hash in page props.
4. All subsequent API requests use the new `?v=` value.
5. Edge and browser caches miss on the new URL, fetch fresh data.

### Localhost Detection

The server determines whether to include match data based on the request's `Host` header:

```typescript
const host = request.headers.get("host") ?? "";
const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
```

This replaces the client-side `useIsLocalhost` hook. The server decides what data to send; the client renders whatever it receives.

## Component Changes

### page.tsx (Server Component)

Changes from calling `loadCardDataFromTurso()` and passing 7 props to calling `getCards()` and passing a single `initialData` prop.

### PageClient.tsx (Client Component)

**Removed:**
- 100-line `useMemo` that recomputed stats via `calculateCardStats()`, `calculateWinEquity()`, `calculateRawWinRate()`
- `draftData` state (the lazy-loaded `DraftDataFile`)
- `showWinEquity` and `showRawWinRate` localStorage state
- `isLocalhost` and `isHydrated` hooks
- Imports of `calculateCardStats`, `calculateWinEquity`, `calculateRawWinRate`, `aggregateSeatStats`, `metadataToMap`

**Added:**
- `cardData` state initialized from `initialData` prop
- `isLoading` state for API fetches
- `handleDraftsChange` becomes a simple fetch-and-swap: build query params, call `/api/cards`, set response into state

**Adapted:**
- Search filtering still runs client-side, but its data source changes. Currently `PageClient` receives a top-level `scryfallData` prop and passes `Object.values(scryfallData)` to `searchLocalCards()`. In the new architecture, the client derives the Scryfall corpus from the cards array: `cardData.cards.map(c => c.scryfall).filter(Boolean)`. The search behavior is identical; only the input wiring changes.

**Unchanged:**
- Color filtering
- `scryfallSearchResults` state and debounced search effect

### Settings.tsx

Props reduced from 8 to 4: `drafts`, `selectedDrafts`, `onDraftsChange`, `isLoading`. The win equity and raw win rate toggles are removed.

### CardTable.tsx

The `showWinEquity`, `showRawWinRate`, and `isLocalhost` props are removed. The decklist win rate column definition is conditionally included based on whether any card in the dataset has a `decklistWinRate` field. When the server omits match data (production), no card has this field, so the column never appears. On localhost, the server includes it, and the column renders automatically.

## Deletions

| File/Module | Reason |
|---|---|
| `scripts/generate-draft-data.ts` | No longer generating client-side JSON |
| `public/api/draft-data.json` | Replaced by API route |
| `src/core/winEquity.ts` | Win equity and raw win rate removed |
| `src/app/hooks/useIsLocalhost.ts` | Server handles environment detection |
| `src/build/tursoDataLoader.ts` | Replaced by `getCards()` |
| `prebuild` / `predev` script hooks | Build is just `next build` |

## Types

The `EnrichedCardStats` type loses the `winEquity` and `rawWinRate` fields. The `decklistWinRate` field remains, present only when the server includes match data.

The `DraftDataFile` type is deleted entirely — no raw data is shipped to the client.

The `CardStatsResponse` type is new and represents the API contract between server and client.

## Build Pipeline

**Before:**
```
predev:   sync-sheets → generate-draft-data.ts
dev:      next dev
prebuild: generate-draft-data.ts
build:    next build
```

**After:**
```
predev:   sync-sheets
dev:      next dev
build:    next build
```

The `prebuild` hook is removed. The `predev` hook retains only `sync-sheets` (still needed to pull CSV updates from Google Sheets before local development).

Note: The app already uses SSR (the server component in `page.tsx` calls `loadCardDataFromTurso()` at render time). This change does not require switching from static export to SSR — it already runs as SSR. The main build change is removing the `prebuild` step that generated `draft-data.json`.

## Migration Checklist

- [ ] Add ingestion metadata row to Turso (hash + timestamp), updated by `pnpm ingest`
- [ ] Remove `public/api/draft-data.json` from `.gitignore` (no longer generated)
- [ ] Delete the generated `draft-data.json` file from `public/api/` if it exists locally
- [ ] Verify Vercel deployment still works as dynamic SSR after removing the prebuild hook
