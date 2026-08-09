# Ingest-Time Privacy Redaction — Design

**Date:** 2026-08-08
**Status:** Approved

## Problem

A player who opts out of RTB has their data redacted at **read time**. Every
pick they made is stored in full — `pick_events` holds 412 rows and
`deck_cards` 298 rows across the ten opted-out seats — and each query module
masks it on the way out.

That has produced three mutually incompatible masking strategies:

| | Hides | Keeps | Where |
|---|---|---|---|
| **A** | `seat` → `"[REDACTED]"` | card name | `getPicks` (`picks.ts:86-94`), `getStandings` (`picks.ts:389-396`), `getDraftPool` (`pool.ts:208-220`) |
| **B** | card name, oracle id, colors, mana cost | real seat | `getRecentPicks` (`picks.ts:445-452`), `getPicksWithCardDetails` (`picks.ts:491-515`) |
| **C** | everything | nothing | `getDeck` (`decklists.ts:32-39`) |

Three consequences follow.

**The pool is wrong.** The pod sheet is fed by strategy B, and the client
derives taken-ness by matching card *names* from the board payload
(`cardStore.ts:234-236`). The name is `"[REDACTED]"`, which matches no real
card, so an opted-out seat's picks are never marked taken and read as still
available.

**There is a live leak.** `getCards` applies no opt-out filtering at all — its
`takenCards` array carries real card names *and* real seat numbers
(`getCards.ts:578-585`), served by `/api/cards` under
`public, s-maxage=31536000` (`api/cards/route.ts:38`). This is also the
fallback source the card table uses before the first `/live` poll lands, so the
identifying data is what renders on a fresh page load.

**Nothing is verifiable.** The guarantee currently rests on ten read paths all
remembering to mask. There is no way to check it holds, and an eleventh path
added later inherits no protection.

## Goals

- Establish an auditable invariant: **no `pick_events` or `deck_cards` row
  exists for a seat listed in `privacy_opt_outs`.**
- Delete all read-time redaction — all three strategies, across ten modules.
- Keep the pod sheet looking exactly as it does today.
- Preserve `match_events`, so no other seat's standings move.
- Make the pipeline self-healing: a sync that ingests an opted-out seat's picks
  (because the opt-out was not yet known) must clean up on a later run.

## Non-goals

- **Redacting `match_events`.** A W/L row identifies no cards, and the other
  nine seats' OMW%/OGW% are computed from it (`computeTiebreakers`,
  `picks.ts:306`). Dropping it would silently change their standings.
- **Preserving availability accuracy.** `getAvailableCards`, `rankedAvailable`,
  and `search?available_only=1` count `pick_events` directly and are currently
  correct; they will become wrong. Accepted — these are reached only through
  the local RTB MCP server, by the maintainer.
- **Live in-app drafts.** Opted-out players do not draft in RTB, so the ingest
  filter covers the Google Sheets path only. (The `/live` *route* is still in
  scope — it serves sheet drafts as well.)
- **Changing `.opt-outs.json` or the name-matching mechanism.**

## Design

### 1. The invariant and where it is enforced

Redaction becomes a property of the stored data, not of each query. A single
choke point at the **parse → ingest** handoff enforces it, reading opted-out
seats from the `privacy_opt_outs` table.

It must read the **table**, not `.opt-outs.json`. That file is gitignored
(`.gitignore:25`) and loaded from `PROJECT_ROOT` (`src/core/optOuts.ts:13`), so
it never reaches Vercel — the cron sync cannot resolve names at all. The JSON
file stays the CLI's input for keeping the table current; the table is the
runtime source of truth for both sync paths.

### 2. Reconcile, don't skip

On every sync run, for each opted-out seat in the draft:

1. Delete any existing `pick_events` and `deck_cards` rows for that seat.
2. Drop that seat's picks from the parsed set before `incrementalIngest` sees
   them.

Reconciling rather than merely skipping is what makes the invariant hold
independently of run order. If cron syncs a new draft before the CLI has
recorded its opt-outs, the picks land — and nothing in the insert-only path
(`detectNewPicks`) would ever remove them. The delete pass closes that hole,
and it means the one-time migration is simply the first run of the new
pipeline.

Two ordering constraints, both load-bearing:

- **`insertOptOuts` must run before the filter.** Otherwise a newly added
  opt-out name does not take effect until the following sync. This matters most
  after `pnpm draft:reset`, which is the only thing that clears
  `privacy_opt_outs` (`db-helpers.ts:18`); `insertOptOuts` itself is
  `INSERT OR IGNORE` and never deletes (`db-helpers.ts:30-50`).
- **`isComplete`, `numDrafters`, and `drafterNames` stay computed from the full
  sheet.** `parsedPicks.isComplete` drives `drafting → playing`
  (`syncActiveDraft.ts:139-152`). Filter before it is computed and the draft
  never looks full, never advances phase, never completes, and stays in the
  cron window indefinitely.

Filtering the *parsed picks* rather than the SQL insert keeps `detectNewPicks`
consistent, so there is no re-insert loop. Divergence detection is unaffected:
`detectRemovedPicks` (`incremental.ts:361`) flags only DB positions missing
*from the sheet*, so absent rows never trip `diverged`.

**Both paths must hash the same pick set.** `drafts.picks_hash` is written by
the CLI and the cron alike, so if one hashes the filtered picks and the other
the unfiltered ones, the two permanently disagree: neither ever short-circuits,
and every CLI run takes `picksAction: "replace"` and re-inserts the whole draft
unchanged. Hash the **filtered** set in both. An edit to a redacted cell then
no longer busts the hash, which is correct — those picks are not stored, so
there is nothing for it to update.

`pick_n` values will have gaps. Interior gaps are inert: everything keys on
`pick_n` absolutely, `getLatestPickNumber` takes `MAX`, and the board matrix
maps `pick_n` → cell structurally.

A **trailing** gap is not inert, and this is a known limitation. When the
redacted seat made the most recent pick, `MAX(pick_n)` is one or more short of
reality until another seat picks. For that window the pod sheet leaves that
seat's newest cell blank rather than `[REDACTED]`, `getNextPick` names the
redacted seat as on the clock, and desire is computed one pick early. It
self-corrects on the next non-redacted pick, and on a sheet draft resolves
within one sync cycle. Fixing it properly would mean persisting the true
latest pick position at ingest — a schema change, deliberately out of scope.

### 3. Read layer: remove all of it

Opt-out handling is deleted from `getPicks`, `getStandings`, `getRecentPicks`,
`getPicksWithCardDetails`, `getDraftPool`, and `getDeck`, and from the
aggregate exclusions in `pickStats`, `worth`, `rankedAvailable`, `playStats`,
`winStats`, and `winningDecks` — all of which become no-ops once the rows are
gone. The shared-fetch optimization at `live/route.ts:78`, which exists only to
avoid double-querying opt-outs, goes with them.

Types simplify: `"[REDACTED]"` leaves `PicksResult.picks[].seat`,
`StandingsEntry.seat`, `PoolCard.drafted_by_seat`, and `DeckResult.seat`;
`redacted_seats` leaves the three REST response shapes. `fetchOptOuts` (the
multi-draft variant) is removed; `getOptedOutSeats` survives for ingest and for
the display flag below.

**No stats numbers move except one.** `pickStats.ts:208` already skips
opted-out picks, which leaves that draft's `pickPositions` empty, and
`pickScore` treats an empty array as the unpicked case — `poolSize` at half
weight (`src/core/pickScore.ts:66-80`). Deleting the rows reproduces that
exactly. So `worth`, `desire`, P#, LODO, and the ranked endpoint are unchanged.
The only figure that moves is `getCards`' main-table P#, which currently
applies no filtering at all, and it moves *into agreement* with the others —
closing the inconsistency by construction rather than by ruling on it. (Its
`loadPickEvents` also assigns copy numbers pre-filter, so multi-copy weights
shift there too; same bucket.)

`cards` and `cube_snapshot_cards` are untouched. The pool listing is the cube,
not the picks.

### 4. Display: one seat-level flag

The pod sheet must look exactly as it does now — the seat header stays, and
every pick cell reads `[REDACTED]`.

With no pick rows in the DB this is rendered *structurally*.
`buildPickMatrix(numSeats, picksPerPlayer, doublePickAfterRound)` generates the
full grid from draft metadata, and all ten affected drafts carry non-null
values for each — `num_seats` 8-12, `picks_per_player` 40-45,
`double_pick_after_round` 20-25 — so every cell belonging to the seat exists
regardless of whether a pick row does. Pod size and draft length vary across
these drafts; nothing here may assume 10 seats or 45 picks.

`/api/drafts/[id]/live` gains `redactedSeats: number[]`. Despite its name that
route serves sheet drafts too — it carries an `isSheetDraft` flag — so this is
the right place for the flag even though live in-app drafts are out of scope. `DraftBoardCell`
renders `[REDACTED]` when the cell's seat is in that list **and** its `pick_n`
is `≤ latestPickN` — the second condition keeps an in-progress draft honest, so
picks that have not happened yet stay blank rather than pre-filling.

This is the one piece of the old machinery that survives, and its character has
changed: a seat-level display list read once by the board, not per-row masking
threaded through the query layer.

Two intended side effects:

- The recent-picks ticker no longer emits `Seat N — [REDACTED]` entries; it
  skips them. This stops leaking *when* the seat picked.
- The card table's two taken-card sources finally agree. Both now report the
  seat's cards as not taken — consistent, and inaccurate in the way this design
  accepts.

### 5. Decklist matcher

`matchDecksToSeats` (`scripts/decklists.ts:144-181`) scores each decklist
against every seat and assigns it to the best scorer. `SEAT_MATCH_SCORE_THRESHOLD`
(0.5) currently only emits a `console.warn` — the assignment at line 179 happens
unconditionally and overwrites any prior assignment for that seat.

**Change:** skip a decklist whose best score is below the threshold instead of
assigning it anyway.

The opted-out seat needs no special handling. With its `pick_events` rows gone,
`getSeatPicks`' query returns no rows for it and it never becomes a key in the
`seatPicks` map — absent by construction. Its orphaned decklist then has
nothing to match: basics are already stripped (`BASIC_LANDS`), so overlap with
every remaining seat is near zero and it falls out on the threshold. A correct
match scores near 1.0, since `decklist.pool` is the full sealeddeck pool
measured against that seat's complete pick set, so 0.5 is a generous floor.

This also fixes the pre-existing corruption bug the code's own comment
anticipates ("e.g. unsorted pool"), which is not opt-out-specific, and removes
a latent `bestSeat === -1` case: when every score is 0 the current code does
`assignments.set(-1, decklist)` and carries seat -1 into the writer.

### 6. What survives

`privacy_opt_outs` stays. It is the ingest filter's input, the source of the
`redactedSeats` display flag, and the only thing distinguishing an opted-out
seat from a seat that drafted nothing.

## Migration

One targeted delete, covering all ten seats:

```sql
DELETE FROM pick_events
  WHERE (draft_id, seat) IN (SELECT draft_id, seat FROM privacy_opt_outs);
DELETE FROM deck_cards
  WHERE (draft_id, seat) IN (SELECT draft_id, seat FROM privacy_opt_outs);
```

412 pick rows and 298 deck-card rows as of 2026-08-08. The pick count drifts —
`hardened-academic` is at phase `drafting` and still syncing.

Everything else in those drafts is untouched: cube snapshots, matches, and the
other nine seats. All ten drafts retain a `sheet_id`, so this is reversible via
`pnpm draft:reset` + `pnpm sync` for as long as the sheets exist.

The new ingest reconciles, making this idempotent with it, but it should be run
explicitly so the migration is auditable rather than a side effect of the next
cron tick.

Verify:

```sql
SELECT COUNT(*) FROM pick_events pe
  JOIN privacy_opt_outs p ON p.draft_id = pe.draft_id AND p.seat = pe.seat;
-- expect 0; same shape for deck_cards
```

## Testing

Existing assertions on `"[REDACTED]"` in query results are **deleted, not
rewritten** — there is nothing left to assert. Affected:
`queries.test.ts:763-788`, `1309-1325`, `1849-1949`, and
`queries.decklist.test.ts:48-56`.

New coverage:

- Ingest drops an opted-out seat's picks and deck cards.
- A second sync run does not re-insert them (the reconcile pass is idempotent).
- Pre-existing rows for a seat added to the opt-out list are deleted on the next
  sync — the self-healing path.
- Phase still advances `drafting → playing` with a redacted seat in a full
  sheet.
- The decklist matcher skips a sub-threshold list rather than assigning it, and
  never overwrites a correctly-assigned seat.
- `DraftBoardCell` renders `[REDACTED]` for a redacted seat at
  `pick_n ≤ latestPickN` and blank above it.

## Risks

**The guarantee rests on name matching.** Opt-outs are resolved by
case-insensitive comparison of `.opt-outs.json` entries against drafter name
cells. `normalizeDrafterName` — which strips the `◈` decoration the sheet wraps
around whoever is on the clock — landed only today (`2da5e28`) to fix that
matching silently failing. Under read-time redaction a missed match exposed
data until the next sync; under ingest-time redaction it means picks are
ingested. The reconcile pass in §2 is what makes such a failure recoverable
rather than permanent, which is the main argument for it over a plain skip.

**Threshold enforcement is a global behavior change.** Any legitimate decklist
currently accepted below 0.5 would start being dropped. Run `pnpm decklists`
once and read the warnings before enabling the `continue`; if the only
sub-threshold warnings are opted-out players' lists, it is clean.

## Rollout

1. Run the migration deletes; confirm the verification query returns 0.
2. `pnpm precommit` **on the host** — `knip` has darwin-only bindings, and the
   husky pre-push hook runs it.
3. `pnpm worth:validate` and re-pin the LODO ρ in the commit message plus the
   dated comment above `GATE_MARGIN`. It is expected to move slightly, since
   the main table's P# changes.
4. `vercel --prod` — the main page is prerendered, so none of this is visible
   until a redeploy, and every P# changes.
