# Incremental-First CLI Ingestion

Make `pnpm ingest` fast by default. Instead of deleting all data and reimporting from scratch whenever a source file changes, detect what's new and insert only that.

## Problem

The CLI ingestion pipeline uses hash-based deduplication: if any source file changes (picks.csv, pool.csv, matches.csv, or decklists.csv), it deletes all rows for that draft and reimports everything. This is safe but slow — a single new pick triggers deletion and reinsertion of hundreds of picks, matches, and decklists. For in-progress drafts where picks arrive frequently, this wastes time and makes the pipeline too slow for the serverless sync path's 60-second ceiling.

## Design

### Overview

When a draft already exists in the database and its import hash has changed, the CLI uses an incremental path instead of delete-and-reimport:

1. **Picks** — append only. Compare `MAX(pick_n)` in DB against the CSV, insert picks above that threshold.
2. **Matches** — idempotent insert. Parse all matches from CSV, `INSERT OR IGNORE` each. The `(draft_id, seat1, seat2)` primary key prevents duplicates.
3. **Decklists** — per-seat diffing. Hash each seat's deck JSON, compare against a stored hash, delete and reinsert only changed seats.
4. **Pool/cube snapshot** — skip. The card pool doesn't change mid-draft. Only processed on first import or `--force`.

A `--force` flag triggers the existing delete-and-reimport behavior for when corrections to old data are needed.

### When Each Path Runs

| Scenario | Path |
|---|---|
| Draft not in DB | Full import (pool, cube, picks, matches, decklists, Scryfall) |
| Draft in DB, hash unchanged | Skip (no work) |
| Draft in DB, hash changed | Incremental (picks, matches, decklists only) |
| Draft in DB, `--force` flag | Delete-and-reimport (existing behavior) |

### Incremental Picks

Same logic as the serverless `incrementalIngest()` in `sync.ts`:

1. Query `SELECT MAX(pick_n) FROM pick_events WHERE draft_id = ?`.
2. Parse picks from CSV. Filter to picks with `pickPosition > dbMax`.
3. Resolve card names to `card_id` via the `cards` table (using `resolveCardNameToId` from `sync.ts`).
4. `INSERT OR IGNORE` each new pick into `pick_events`.

If the CSV's max pick number is less than the DB's max (divergence), log a warning and skip. The user should run `--force` to resolve.

**Known limitation:** Corrections to existing picks (e.g., changing the card name at pick 15) are not detected by the incremental path, because `MAX(pick_n)` hasn't changed. The import hash updates, but no data changes in the DB. Use `--force` to apply corrections.

### Incremental Matches

Parse all matches from CSV and `INSERT OR IGNORE` each into `match_events`. The `(draft_id, seat1, seat2)` primary key prevents duplicate insertions — already-recorded matches are silently skipped.

If the CSV has fewer matches than the DB (a match was removed), log a warning. Score corrections to existing matchups (same pairing, different score) are not detected — the `INSERT OR IGNORE` keeps the old score. Use `--force` for corrections.

### Incremental Decklists

Decklists are submitted per seat and can be resubmitted. A simple append won't work — we need per-seat diffing.

**Schema change:** Add a `deck_hashes` table to `schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS deck_hashes (
  draft_id TEXT NOT NULL REFERENCES drafts(draft_id),
  seat INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (draft_id, seat)
);
```

**Card name resolution:** The incremental decklist path resolves card names to `card_id` by querying the `cards` table (same as `resolveCardNameToId` in `sync.ts`), since the in-memory `cardNameToId` map from pool processing is not available in the incremental path.

**Incremental flow:**

1. For each seat in `decklists.csv`, compute SHA-256 of the `decks/<seat>.json` file content.
2. Query `SELECT seat, hash FROM deck_hashes WHERE draft_id = ?`.
3. For each seat:
   - If the seat has no stored hash (new submission): insert deck_cards and store hash.
   - If the hash matches: skip.
   - If the hash differs (resubmission): delete that seat's `deck_cards` rows, reinsert, update hash.
4. Seats that exist in the DB but not in the CSV are left alone (a seat removing their decklist is unusual enough to warrant `--force`).

Note: The import hash (which triggers the incremental path) includes `decklists.csv` but not individual `decks/*.json` files. A change to a deck JSON without a corresponding `decklists.csv` change won't trigger reimport. In practice this doesn't happen — `decklists.csv` is always regenerated alongside deck files.

### The `--force` Flag

`pnpm ingest --force` (all drafts) or `pnpm ingest --force <draft-id>` (single draft) triggers the existing delete-and-reimport behavior. This handles:

- Corrections to historical picks (card name changed at an existing position)
- Match score corrections (same pairing, different result)
- Pool/cube changes
- Deleted or reordered rows
- Any other situation where the incremental path can't reconcile the diff

The current CLI parses `args[0]` as an optional draft ID filter. Argument parsing changes to: if any arg is `--force`, enable force mode; any other arg is a draft ID filter. Both can be combined: `pnpm ingest --force tarkir`.

`deleteDraft()` gains a `DELETE FROM deck_hashes WHERE draft_id = ?` step, ordered before `DELETE FROM drafts` to respect foreign key constraints. Full deletion order: `match_events` → `deck_cards` → `deck_hashes` → `pick_events` → `drafts`.

### Draft Completion Detection

The incremental path still runs `isDraftComplete()` on the picks CSV after inserting new picks. If the draft just completed, it sets `is_complete = 1` on the drafts row. This matches the serverless path behavior.

### Import Hash Update

After the incremental path runs, update the stored hash: `UPDATE drafts SET import_hash = ? WHERE draft_id = ?`. This ensures the next run sees the draft as unchanged (skip) unless new data arrives. The hash updates even if the incremental path found nothing new to insert (e.g., a whitespace-only CSV change). This is intentional — it prevents the same no-op from re-running.

### Opt-Outs

Opt-outs (`.opt-outs.json`) are rare and idempotent (`INSERT OR IGNORE`). The incremental path parses the picks CSV (which it already does for pick detection) to extract drafter names, then re-runs opt-out processing. Cheap and safe.

### Scryfall Backfill

Unchanged. The existing `backfillScryfallData()` runs after all drafts and only fills cards with `scryfall_json IS NULL`.

## Shared Code with Serverless Path

The incremental pick logic already exists in `src/core/sync.ts` (`detectNewPicks`, `detectDivergence`, `insertNewPicks`, `getDbMaxPickN`, `resolveCardNameToId`). The CLI calls these functions rather than reimplementing. The per-pick `resolveCardNameToId` query is less efficient than the in-memory map used during full import, but acceptable for the incremental case where only a handful of new picks are inserted.

The match and decklist incremental logic is CLI-only (the serverless path only handles picks).

## Out of Scope

- Changing the serverless sync path (it already uses incremental picks).
- Incremental pool/cube snapshot updates (pools don't change mid-draft).
- Automatic correction detection (comparing individual pick values). Use `--force` for this.
