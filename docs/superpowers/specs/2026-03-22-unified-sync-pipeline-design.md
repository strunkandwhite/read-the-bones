# Unified Sync Pipeline Design

## Problem

Data flows from Google Sheets to Turso through an unnecessary intermediate step: CSV files on disk. The `data/` directory structure duplicates what Turso already stores, the two-step sync-then-ingest workflow adds friction, and full reimport is slow because it performs ~1,500 individual database writes per draft instead of batching.

## Goals

1. **Eliminate CSV files on disk.** Google Sheets data flows directly to Turso. The `data/` directory goes away.
2. **Unify the sync pipeline.** One command, one code path. No incremental vs. full distinction — per-domain hashing decides what to skip and what to replace.
3. **Batch all database writes.** Replace individual `client.execute()` loops with `client.batch()` calls. Target ~5-6 batch calls per draft instead of ~1,500 individual awaits.

## Non-Goals

- Changing the query layer, API routes, or MCP server.
- Modifying the opt-out system (already works correctly at query time).
- Changing the Scryfall cache/resolution strategy.

---

## Draft Lifecycle

### Registering a Draft

```
pnpm draft:create --name "Tarkir" --date 2025-12-01 --sheet-id 1aYw... [--banned-cards "Reanimate,Channel"]
```

- Generates a `draft_id` by slugifying the name: lowercase, replace non-alphanumeric runs with `-`, strip leading/trailing `-`. (e.g. "Khans of Tarkir" → `khans-of-tarkir`). Reuses the existing `slugify()` logic from `scripts/add-draft.ts`.
- Inserts a row into the `drafts` table with `is_complete = false`.
- Fails if `draft_id` already exists.
- No files created.

### Syncing

```
pnpm sync [draft-name]
```

- Without a draft name, syncs all incomplete drafts.
- With a name, syncs that draft regardless of completion status.
- Fetches from Google Sheets using the `sheet_id` stored in the `drafts` table.
- Parses picks, pool, and matches in memory.
- Applies per-domain hashing to decide what to write (see "Unified Sync Pipeline" below).
- Supports `--dry-run` (show what would change without writing) and `--verbose` (detailed output).

### Importing Decklists

```
pnpm decklists [draft-name]
```

- Reads `decklists.txt` from the project root.
- Fetches decks from sealeddeck.tech.
- Loads pick data from Turso (not from files) to match decks to seats by card overlap.
- Writes to `deck_cards` via batch operations.
- Per-seat hashing continues as-is (stored in `deck_hashes`).

### Resetting a Draft

```
pnpm draft:reset <draft-name>
```

- Deletes all data for the draft: pick_events, match_events, deck_cards, deck_hashes, cube_snapshot association, and privacy_opt_outs. (Note: the current `deleteDraft()` does not delete privacy_opt_outs — this is intentionally expanded.)
- Resets per-domain hashes to null.
- Keeps the `drafts` row (preserving name, date, sheet_id, banned_cards).
- Next `pnpm sync` reimports everything from scratch.

Use this when source data has structural problems that per-domain replacement can't fix (e.g., the Sheet was reorganized, seats were renumbered).

---

## Unified Sync Pipeline

Every sync run follows the same logic for each domain. There is no separate "incremental" vs. "force" mode.

```
For each domain (pool, picks, matches):
  1. Compute hash of in-memory data from Sheets
  2. Compare against stored hash in drafts table
  3. If match → skip
  4. If mismatch → DELETE all domain data for this draft, batch INSERT new data, update stored hash
```

### Per-Domain Hashing

Each domain's hash captures the full content of that domain's data. Hashes are stored as columns on the `drafts` table.

| Domain | Hash Input | Storage Column |
|--------|-----------|----------------|
| Pool | Sorted card names, joined and SHA-256'd | `pool_hash` |
| Picks | All (pick_n, seat, card_name) tuples, sorted by pick_n, joined and SHA-256'd | `picks_hash` |
| Matches | All (seat1, seat2, seat1_wins, seat2_wins) tuples, sorted, joined and SHA-256'd | `matches_hash` |
| Decklists | Per-seat hash of deck JSON (already exists in `deck_hashes` table) | `deck_hashes` table |

The existing `import_hash` column on `drafts` is removed.

### Domain Replacement Strategy

When a hash mismatches, the domain's data is fully replaced:

- **Pool**: Delete `cube_snapshot_cards` for the snapshot, reinsert. Update `cube_snapshots` hash. (If the same cube is shared across drafts, the snapshot is reused by hash lookup — unchanged from today.)
- **Picks**: `DELETE FROM pick_events WHERE draft_id = ?`, then batch insert all picks.
- **Matches**: `DELETE FROM match_events WHERE draft_id = ?`, then batch insert all matches.
- **Decklists**: Per-seat replacement continues as-is (delete + reinsert for changed seats only).

### Draft Completion Detection

The sync pipeline detects draft completion by the `✪` marker in the picks data (same logic as today). When detected, `is_complete` is set to `true` on the `drafts` row.

### Opt-Outs During Sync

The sync pipeline loads `.opt-outs.json` and calls `insertOptOuts()` to populate `privacy_opt_outs`. This runs on every sync (idempotent via `INSERT OR IGNORE`), ensuring opt-outs are applied regardless of which domains changed.

---

## Batch Operations

All database writes use `client.batch()` to send multiple statements in a single round-trip.

| Operation | Current | New |
|-----------|---------|-----|
| Insert pick events | ~500 individual awaits | 1 batch call |
| Insert cube snapshot cards | ~200 individual awaits | 1 batch call |
| Insert match events | ~10 individual awaits | 1 batch call |
| Insert deck cards (per seat) | ~60 individual awaits | 1 batch call per seat |
| Ensure cards exist | ~200 individual awaits | See "Card Resolution" below |

### Card Resolution

Today, `ensureCard()` does a SELECT + conditional INSERT for each card individually. This is called per-draft with no cross-draft caching.

New approach:
- Maintain an in-memory `Map<cardName, cardId>` across the entire sync run.
- At the start of a sync run, bulk-load all existing cards from Turso into the map.
- When resolving a card: check the map first. If missing, insert the card and add to map.
- New card inserts are batched per-draft (collect all missing cards, insert in one batch, then populate map).

This eliminates redundant lookups when the same card appears across multiple drafts.

---

## Sheets Data Parsing

The existing `src/core/sheets.ts` fetches data from Google Sheets. Its internal `fetchSheetTab()` returns `string[][]` (raw row arrays), but the public API `fetchDraftFromSheet()` converts these to CSV strings via `rowsToCsv()`.

The new pipeline needs the raw row arrays, not CSV strings. Refactor `sheets.ts` to export a function that returns structured row data directly, bypassing CSV serialization. Instead of:

```
Sheets → CSV string → parse CSV → structured data → Turso
```

It becomes:

```
Sheets → raw rows → structured data → Turso
```

The parsing logic from `parseCsv.ts` (row layout, drafter name extraction, color column handling, `✪` detection) moves into a new module that operates on row arrays directly. `parseMatches.ts` is also replaced — its CSV-based match parsing logic is absorbed into the same module.

---

## Schema Changes

### Modified: `drafts` table

```sql
-- Remove
import_hash TEXT

-- Add
pool_hash TEXT,
picks_hash TEXT,
matches_hash TEXT
```

### Modified: `ingestion_meta` table

Remove the `last_hash` key (combined ingestion hash is no longer needed). Keep the table — it stores `sync_lock` and `last_synced_at` keys used by the live sync route (`/api/sync`) for locking and rate-limiting. These remain unchanged.

### Unchanged

All other tables (`pick_events`, `match_events`, `deck_cards`, `deck_hashes`, `cards`, `card_aliases`, `cube_snapshots`, `cube_snapshot_cards`, `privacy_opt_outs`, `shared_decks`) remain unchanged.

---

## What Gets Removed

| Item | Reason |
|------|--------|
| `data/` directory | No longer needed; Turso is the source of truth |
| `scripts/sync-sheets.ts` | Replaced by `pnpm sync` |
| `scripts/match-decklists.ts` | Replaced by `pnpm decklists` |
| `scripts/add-draft.ts` | Replaced by `pnpm draft:create` |
| `src/core/parseCsv.ts` | Replaced by direct row parsing |
| `src/core/parseMatches.ts` | Absorbed into direct row parsing |
| `src/core/db/ingest/discover.ts` | No directory discovery; drafts come from Turso |
| `src/core/db/ingest/full-import.ts` | Unified pipeline replaces both paths |
| `src/core/db/ingest/incremental.ts` | Unified pipeline replaces both paths |
| `src/core/db/ingest/index.ts` | Replaced by new sync entry point |
| `src/build/sheets.ts` | Re-export shim for removed scripts; dead code |
| `import_hash` column on `drafts` | Replaced by per-domain hashes |
| `last_hash` key in `ingestion_meta` | No longer needed (per-domain hashes replace it) |

## What Stays

| Item | Notes |
|------|-------|
| `decklists.txt` (project root) | Moved from `data/decklists.txt`; scratch file for sealeddeck URLs |
| `src/core/sheets.ts` | Refactored to export raw row arrays instead of CSV strings |
| `src/core/sync.ts` | Sync locking and live sync logic stays; pick resolution refactored into unified pipeline |
| `src/core/db/ingest/scryfall.ts` | Scryfall cache and resolution (unchanged) |
| `src/core/db/ingest/utils.ts` | Hashing utilities (adapted for per-domain hashing) |
| `src/core/db/ingest/db-helpers.ts` | Refactored to use batch operations |
| `ingestion_meta` table | Keeps `sync_lock` and `last_synced_at` keys; `last_hash` key removed |
| All query modules (`src/core/db/queries/`) | Unchanged |
| API routes | Unchanged |
| MCP server | Unchanged |

---

## Error Handling

### Sheets API Failure

The sync pipeline fetches all Sheets data into memory before touching the database. If the fetch fails (auth error, rate limit, network), the pipeline logs the error and skips that draft — existing data in Turso is untouched.

This ordering is critical for the domain replacement strategy: a DELETE only happens after the replacement data is already in memory.

### Partial Draft Failure

If one draft fails during a multi-draft sync, the pipeline continues with the remaining drafts and reports failures at the end. Each draft's domain replacements are independent.

### Batch Operation Failure

If a `client.batch()` call fails, the entire batch is rolled back (libsql batch semantics). The draft's stored hash is not updated, so the next sync retries the same replacement.

---

## npm Scripts Migration

| Old Script | New Script | Notes |
|-----------|-----------|-------|
| `pnpm sync-sheets` | `pnpm sync` | Fetches and writes to Turso in one step |
| `pnpm ingest` | `pnpm sync` | No separate ingest step |
| `pnpm ingest --force` | `pnpm draft:reset <name>` then `pnpm sync` | Reset clears hashes, sync reimports |
| `pnpm add-draft` | `pnpm draft:create` | Writes to Turso instead of creating files |
| `predev` hook | Removed or replaced with `pnpm sync` | Dev server no longer auto-syncs sheets; run `pnpm sync` manually before `pnpm dev` |

---

## Migration

### One-Time Migration Steps

1. Run a schema migration to add `pool_hash`, `picks_hash`, `matches_hash` columns to `drafts` and drop `import_hash`.
2. Delete the `last_hash` key from `ingestion_meta` (keep the table for sync locking).
3. For each existing draft in Turso, backfill the per-domain hashes by computing them from the data already in the database. This ensures the first sync after migration correctly detects unchanged data.
4. Move `data/decklists.txt` to the project root.

### Transition Period

The `data/` directory can be kept locally as a backup until the new pipeline is verified. Once confirmed working, delete it. Since CSVs were never committed to git (privacy), this only affects local environments.

---

## Live Sync (Active Drafts)

The existing serverless live sync (`/api/sync` route) fetches from Sheets and writes to Turso without CSV files. It uses `src/core/sync.ts`, which currently depends on `parseCsv.ts` — `incrementalIngest()` takes a `picksCsv: string` parameter and calls `parseDraftPicks()`.

Since `parseCsv.ts` is being removed, the live sync route must be updated to use the new row-based parsing. The refactored `sync.ts` should accept raw row arrays instead of CSV strings. The API sync route passes Sheets data through the same row-based parser as the CLI pipeline.

The CLI `pnpm sync` and the API sync route share the same parsing and writing logic. The API route only handles picks (append-only for real-time updates during active drafts), while the CLI handles all domains.
