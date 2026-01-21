# Banned Cards Design

Per-draft card bans for rotisserie drafts. Some drafts ban specific cards from being picked. Banned cards remain in the cube physically but are excluded from draft participation, stats, and the active draft UI.

## Context

- Bans are declared before a draft starts and do not change during the draft.
- Banned cards never appear in picks.csv — they simply aren't drafted.
- Banned cards remain in pool.csv (the pool reflects the full canonical cube).
- Multiple simultaneous drafts may have different ban lists.

## Data Model

### Source of Truth: metadata.json

Optional `bans` array of card names:

```json
{
  "name": "Terminate",
  "date": "2026-03-15",
  "sheetId": "...",
  "bans": ["Reanimate", "Channel"]
}
```

Omitting the field or using an empty array means no bans. Card names follow the same normalization rules as elsewhere (strip numeric suffixes).

### Database: drafts table

New nullable column:

```sql
ALTER TABLE drafts ADD COLUMN banned_cards TEXT DEFAULT NULL;
```

Stores a JSON-serialized array of card names (e.g., `'["Reanimate","Channel"]'`). NULL means no bans. This mirrors the pattern where files are the source of truth and the database is the runtime store. The ALTER TABLE goes in `schema.sql` following the existing ALTER TABLE statements.

## Ingestion

Four changes to the ingestion pipeline:

1. **Read bans from metadata.json** — add `bans?: string[]` to the `DraftMetadata` interface. Parse the optional array and apply card name normalization (strip numeric suffixes) for consistent matching.

2. **Validate ban names against pool** — during ingestion, check each banned card name against the cards in pool.csv. Log a warning for any banned card name that doesn't match a pool card (likely a typo). Continue ingestion regardless — don't fail on unmatched bans.

3. **Store bans in the database** — pass pre-serialized JSON (`string | null`) to `createDraft`. Write to the `banned_cards` column on the draft's row.

4. **Include metadata.json in the import hash** — add metadata.json content to `computeImportHash` alongside the CSV files. This means any metadata change (name, date, bans) triggers re-ingestion, which is benign and correct. Note: the first `pnpm ingest` after this change will re-import all drafts since all hashes will change.

Note: ingestion does NOT need to skip banned cards from pick events or unpicked entries. Pick events come from picks.csv (where banned cards never appear), and unpicked entries are generated at query time in `getCards.ts`, not during ingestion.

## Stats Calculation (getCards.ts)

Unpicked penalty entries are generated at query time in `getCards.ts`, not at ingestion time. The existing logic iterates `cube_snapshot_cards` and creates unpicked entries for cards with `unpickedQty > 0`. Since banned cards remain in `pool.csv` and therefore in `cube_snapshot_cards`, they would incorrectly receive the unpicked penalty without changes here.

Changes to `getCards.ts`:

1. **Load banned_cards per draft** — add `d.banned_cards` to the drafts SELECT query. Parse the JSON array for each draft into a `Set<string>`.

2. **Exclude banned cards from unpicked entry generation** — when generating unpicked `CardPick` entries for a given draft, skip cards whose name appears in that draft's banned_cards set. This gives banned cards the same treatment as cards not present in the draft's pool. The pool size used for the unpicked penalty position (`pickPosition = poolSize`) is not adjusted — with typical ban lists of 2-5 cards out of 540, the difference is negligible (< 1%) and not worth the complexity of per-draft pool size overrides.

3. **Return bannedCardNames for active draft** — add optional `bannedCardNames?: string[]` to the `CardStatsResponse` type (matching the `takenCardNames` convention of `undefined` when no active draft). When `activeDraft` is provided, read the parsed banned_cards for that draft and include it in the response.

## API

The `/api/cards` endpoint already accepts an `activeDraft` query param and returns `takenCardNames`. The `bannedCardNames` array is now returned from `getCards()` directly (see Stats Calculation above).

These are kept separate (not merged with takenCardNames) so the client can distinguish between taken and banned cards.

## Client-Side Filtering

Banned cards are always hidden when an active draft is selected — never dimmed. Unlike taken cards, there is no reason to ever display a banned card during an active draft.

- `bannedCardNames` is converted to a `Set<string>` in `PageClient.tsx` and used to filter cards out of the display list before passing to `CardTable` — banned cards never reach the table component.
- Banned card filtering is applied first (always-on), then taken card filtering conditionally (controlled by `hideTaken` toggle).
- When no active draft is selected, `bannedCardNames` is undefined — the full canonical cube is shown.
- The `availableCount` calculation (used by `ActiveDraftIndicator`) must also exclude banned cards so the count accurately reflects cards that can actually be drafted.

## Sync

No changes needed. Bans live in metadata.json (local file, not synced from Google Sheets). If bans need to change mid-draft, someone edits metadata.json and re-runs `pnpm ingest` to update the `banned_cards` column. The import hash change triggers full re-ingestion of the affected draft.

## Scope Summary

| Layer | Change |
|-------|--------|
| metadata.json | Optional `bans` array |
| Database | `ALTER TABLE drafts ADD COLUMN banned_cards TEXT` |
| Ingestion | Read bans, validate against pool, store in DB, include metadata.json in hash |
| getCards.ts | Exclude banned cards from unpicked entries, return `bannedCardNames` |
| API | Pass through `bannedCardNames` from getCards response |
| Client | Always filter out banned cards during active draft |
| Sync | No changes |
