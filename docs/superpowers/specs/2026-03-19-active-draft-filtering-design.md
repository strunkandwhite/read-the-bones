# Active Draft Filtering

Filter out taken cards during an active rotisserie draft, with automatic data freshness via server-side polling.

## Problem

During an active draft, players visit the site to evaluate remaining cards. The site currently shows all cards with no awareness of draft progress — players must mentally track which cards are taken. Data only updates through manual CLI commands (`pnpm sync-sheets` then `pnpm ingest`), so picks made minutes ago may not appear.

## Users

The current drafting group. Not a general-audience feature.

## Design

### Core Concept

A card is **taken** if it has a row in `pick_events` for the active draft. A card is **available** if it has no row in `pick_events` for that draft. (The synthetic `seat = -1` unpicked entries are generated at query time in `getCards.ts` — they do not exist in the `pick_events` table.) The distinction is binary — no per-seat breakdown, though the data model supports adding that later.

### Schema Changes

**Migration:**

```sql
ALTER TABLE drafts ADD COLUMN sheet_id TEXT;
INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('sync_lock', '');
INSERT OR IGNORE INTO ingestion_meta (key, value) VALUES ('last_synced_at', '0');
```

Add a `sheet_id TEXT` column to the `drafts` table. `createDraft()` gains a `sheetId: string | null` parameter, and its `INSERT` statement adds `sheet_id` to the column list. `processDraftInner()` reads `metadata.sheetId` and passes it through. The API sync route queries `SELECT draft_id, sheet_id FROM drafts WHERE is_complete = 0 AND sheet_id IS NOT NULL` to discover which sheets to fetch. This removes the dependency on filesystem access to `metadata.json` at runtime.

Seed the `sync_lock` and `last_synced_at` rows in `ingestion_meta`. Both store Unix timestamps in seconds as text. `sync_lock` uses `''` (empty string) to represent "unlocked." `last_synced_at` uses `'0'` as its initial value.

### Incremental Ingestion

A fundamental change to `ingest.ts`, not specific to this feature.

**Prerequisite:** A draft must be seeded via CLI (`pnpm ingest`) before the serverless path can operate on it. The CLI handles first-time full imports — pool, cube snapshot, Scryfall card resolution, initial picks, and `sheet_id`. The serverless path only performs incremental pick inserts; it never does full reimports (which require the Scryfall cache file, unavailable on Vercel).

**Serverless incremental path** (used by `/api/sync`):

The serverless path does not use import hashes. It compares pick counts directly:

1. Query `SELECT MAX(pick_n) FROM pick_events WHERE draft_id = ?` and compare against the max pick number parsed from the fetched CSV.
2. If the CSV's max pick number is higher, insert only picks with `pick_n` greater than the database's current max. Card name → `card_id` resolution looks up cards already registered in the `cards` table from the initial CLI import. If a pick references a card name not found in the `cards` table, log a warning and skip that pick.
3. After inserting, re-check `isDraftComplete()`. If the draft just completed, set `is_complete = 1` on the draft row. This stops further serverless syncing. A subsequent CLI `pnpm ingest` run performs the full reimport to finalize data (catching any mid-draft corrections and updating `last_hash`).
4. If the data diverges — max pick number decreased, or the CSV has fewer total picks than the database (e.g., a correction in the spreadsheet) — log a warning and skip this draft. The divergence requires a CLI `pnpm ingest` to resolve (full delete-and-reimport with Scryfall cache). Mid-draft corrections that change a card at an existing pick position without changing the count are also not detected; they resolve on the next CLI run.

**CLI path** (used by `pnpm ingest`):

The existing `processDraft` behavior applies: hash-based deduplication, full delete-and-reimport when the hash changes. The incremental optimization (steps 1–2 above) also applies here to speed up CLI runs for active drafts — but the CLI can fall back to full reimport when needed since it has access to the Scryfall cache.

Complete drafts remain unchanged — the existing hash-skip logic handles them.

**Expected performance:** Google Sheets API call takes 1–2 seconds. Inserting a few new picks takes milliseconds. The full cycle fits well within Vercel Pro's 60-second function timeout.

### API Routes

**`GET /api/sync`** — Syncs Google Sheets and runs incremental ingestion for active drafts. Uses GET because Vercel cron jobs only send GET requests.

- Vercel cron requests include an `Authorization: Bearer <CRON_SECRET>` header. The GET handler verifies this header against the `CRON_SECRET` environment variable. Requests without a valid secret receive a 401 response. This prevents external parties from triggering syncs and consuming Google Sheets API quota.
- Checks a `sync_lock` row in `ingestion_meta` using compare-and-swap: `UPDATE ingestion_meta SET value = :now WHERE key = 'sync_lock' AND (value = '' OR CAST(value AS INTEGER) < :threshold)`. The threshold is current time minus 2 minutes (120 seconds), which serves as a stale-lock timeout — if a sync crashes without releasing its lock, the next attempt proceeds after 2 minutes. If the update affects zero rows, a sync is already in progress — return `{ status: "in_progress" }`.
- Queries `drafts` table for active drafts (`is_complete = 0`) with a `sheet_id`. Fetches sheet data via Google Sheets API.
- Passes fetched CSV data in-memory to the ingestion step. No filesystem writes — Vercel's serverless filesystem is read-only outside `/tmp`, and data need not persist across invocations.
- Writes current Unix timestamp (seconds) to `last_synced_at` in `ingestion_meta`. Clears the lock by setting `sync_lock` value to `''` (empty string). Lock release happens in a `finally` block so it clears even if the sync throws an error. The 2-minute stale-lock timeout remains as a safety net for catastrophic failures (process killed).
- Short-circuits with one Turso query when no active drafts exist.
- Returns `{ status: "completed", lastSyncedAt: "..." }`.

**`POST /api/sync`** — The "Sync Now" endpoint. Same sync logic as GET, but no `CRON_SECRET` check (called from the client). Rate-limited: if `last_synced_at` is less than 30 seconds ago, return `{ status: "rate_limited" }` with a 429 response. This prevents quota exhaustion from repeated requests.

**`GET /api/sync-status`** — Lightweight polling endpoint.

- Reads `last_synced_at` and `sync_lock` from `ingestion_meta`.
- Also returns the list of currently active draft IDs (`is_complete = 0`), so the client can detect when its selected draft completes.
- Returns `{ lastSyncedAt: "1773974000", syncInProgress: boolean, activeDraftIds: ["tarkir", ...] }`. `lastSyncedAt` is a Unix timestamp in seconds (as a string). The client converts it for "Synced Xs ago" display.

**Vercel cron** — Hits `/api/sync` every minute via GET. Add the `crons` key to the existing `vercel.json` at the project root (create the file if absent).

```json
{
  "crons": [{ "path": "/api/sync", "schedule": "* * * * *" }]
}
```

### Shared Sync Module

The sync+ingest logic gets extracted into `src/core/sync.ts`. This module accepts CSV data as strings (not file paths) so it works both in Vercel's serverless environment and from the CLI.

- **API route path:** Fetches sheet data via Google Sheets API → passes CSV strings to `sync.ts` → writes results to Turso.
- **CLI path:** `pnpm sync-sheets` writes CSVs to disk as today, `pnpm ingest` reads them from disk and passes the contents to the same shared functions.

### Draft Completeness: Source of Truth

The database column `is_complete` is authoritative at runtime. The API route uses it to decide which drafts to sync.

`metadata.json`'s `status` field is used only by the CLI's `sync-sheets` script to skip fetching sheets for complete drafts. When the API route syncs a draft and detects completion (via `isDraftComplete()`), it sets `is_complete = 1` in the database. The `metadata.json` file is not updated by the API route (since Vercel has no persistent filesystem).

For CLI workflows, the user should set `metadata.status = "complete"` manually when a draft ends, as they do today.

**Note:** `isDraftComplete()` detects completion by checking whether the ✪ marker row in the CSV has picks. All draft sheets in this project use this convention. If a sheet lacks the ✪ marker, the function returns `true` by default — the draft would be marked complete prematurely. This is acceptable since the sheet format is controlled by the drafting group.

### Extending `/api/cards` for Active Draft Data

The existing `/api/cards` endpoint returns aggregate stats across selected completed drafts. To support active draft filtering, it gains an optional `activeDraft` query parameter:

`GET /api/cards?drafts=draft1,draft2&activeDraft=tarkir`

When `activeDraft` is provided, the response includes an additional field:

```json
{
  "cards": [ ... ],
  "takenCardNames": ["Swords to Plowshares", "Lightning Bolt", ...]
}
```

`takenCardNames` comes from `SELECT c.name FROM pick_events pe JOIN cards c ON pe.card_id = c.card_id WHERE pe.draft_id = ?`. These names match the existing `cardName` field in `EnrichedCardStats` (both sourced from the `cards` table), so the client can match them directly without a separate ID mapping.

`GetCardsParams` gains an `activeDraft?: string` field. The `takenCardNames` query runs only when this field is present.

The active draft is not included in the `drafts` parameter — it does not contribute to aggregate stats.

### Caching Strategy

The existing `/api/cards` route sets `Cache-Control: public, s-maxage=31536000` and busts the cache with a `?v=` hash parameter. During active drafting, the client needs fresh data after each sync.

When the `activeDraft` parameter is present, the route sets `Cache-Control: no-store` instead. Active draft data changes frequently and must not be cached. When no `activeDraft` is specified, the existing aggressive caching behavior remains unchanged.

The serverless incremental path does not update the `last_hash` value in `ingestion_meta` (the hash that drives `?v=` cache busting for non-active-draft requests). This is intentional: active draft requests use `no-store` and don't need the hash, while aggregate stats from completed drafts haven't changed. `last_hash` updates when the CLI runs a full reimport (e.g., after a draft completes).

### UI: Settings Panel

The existing gear icon opens a settings panel. Two new controls:

- **"Active Draft" dropdown** — Lists drafts where `is_complete = 0`. The client calls `GET /api/sync-status` once on page load to discover active drafts (via the `activeDraftIds` field). Absent or disabled when none exist. Selecting one activates draft mode and starts the polling loop.
- **"Hide taken cards" checkbox** — Visible only when an active draft is selected. Checked by default. Unchecking reveals taken cards with reduced opacity.

Both selections persist in `localStorage`. When the selected draft completes, the UI clears the selection.

The active draft selector is independent of the existing draft checkboxes that control which completed drafts contribute to aggregate stats. An active draft does not contribute to stats (no match results yet).

### UI: Status Indicator

When an active draft is selected, a status line appears right-aligned on the search/filter bar — on the same horizontal line as the search input and color filter icons.

Contents: green dot · draft name · available count · last sync time · "Sync Now" button.

**States:**
- **Normal:** Green dot, "Synced 30s ago", active Sync Now button.
- **Syncing:** Pulsing amber dot, "Syncing…", disabled Sync Now button.
- **Draft complete:** Neutral dot, "Draft complete." Polling stops.
- **No active draft:** Status line absent entirely. The search/filter bar looks exactly as it does today.

### UI: Taken Card Appearance

When "Hide taken cards" is unchecked (Show All mode), taken cards appear in the table with `opacity: 0.35`. The entire row — thumbnail, name, stats — fades uniformly. No strikethrough, no badge.

When "Hide taken cards" is checked (the default), taken cards are removed from the table entirely.

### Client Polling

When an active draft is selected:

1. Poll `GET /api/sync-status` every 10 seconds.
2. If `lastSyncedAt` changed since the last check, refetch card data from `/api/cards?activeDraft=...`. The response includes `takenCardNames`, which the client uses to determine card availability and update the available count in the status indicator.
3. Update the "Synced Xs ago" display on every tick using client-side time math (no extra API call).
4. If the selected draft's ID no longer appears in `activeDraftIds` from the sync-status response, the draft has completed. Transition to "Draft complete" state and stop polling.

The "Sync Now" button pauses the polling interval, calls `POST /api/sync`, waits for the response, refetches card data, updates the client's `lastSyncedAt` value, then resumes polling. This prevents a double-fetch from the polling loop detecting the same `lastSyncedAt` change.

When no active draft is selected, polling does not run.

### Concurrency

Multiple users clicking "Sync Now" simultaneously is safe. The `sync_lock` uses compare-and-swap in Turso, so only one writer wins. Additional requests return `{ status: "in_progress" }` — the client can poll `sync-status` until it completes.

Even if two syncs run concurrently (the CAS has a small race window), ingestion is idempotent: inserting a pick with the same `(draft_id, pick_n)` is a no-op or conflict, and the final state is consistent.

The Vercel cron respects the same lock. If a user-triggered sync is running when the cron fires, the cron short-circuits.

## Infrastructure Requirements

- **Vercel Pro plan** ($20/month) — required for 1-minute cron jobs and 60-second function timeouts.
- **`GOOGLE_SHEETS_API_KEY`** set as an environment variable in Vercel's dashboard.
- **`CRON_SECRET`** set as an environment variable in Vercel's dashboard (Vercel auto-generates this).
- No new databases, services, or platforms.

## Out of Scope

- Per-seat card filtering (showing "my picks" vs "opponent's picks"). The data model supports this; the UI does not expose it yet.
- WebSocket push. Client polling at 10-second intervals is sufficient for this group size.
- Moving off Vercel or adding a second platform.
