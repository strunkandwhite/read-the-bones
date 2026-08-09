# Decklist Recovery — Design

**Date:** 2026-08-09
**Status:** approved, ready for implementation planning
**Investigation:** `docs/decklist-recovery-handoff.md`

---

## Goals

1. **Every stored decklist is correct.** Anything that is not correct is either repaired
   or removed and *flagged for manual remediation* — never left silently wrong.
2. **Future `pnpm decklists` runs cannot destroy manual remediation.**
3. **Ingestion accounts for the malformed submissions we have actually seen**, rather
   than mis-assigning them.

Goal 1 has a subtlety that shapes the design: deleting a corrupt row makes that seat
indistinguishable from a seat that never submitted a decklist. Deletion alone therefore
*destroys* the flag. The remediation queue is a first-class deliverable, not a byproduct.

---

## Background

`pnpm decklists` fetches sealeddeck.tech submissions listed in `data/decklists.txt` and
assigns each to a seat by card overlap with that seat's `pick_events`, then writes
`deck_cards`. Two domain facts make the data unusually verifiable:

- **Rotisserie means every card belongs to exactly one player.** Cross-seat overlap is
  near zero, so two seats "matching" the same list is a defect, not a coincidence.
- **`pick_events` is ground truth**, synced from the source sheet.

### The defect

`extractPool` (`scripts/decklists.ts:111-125`) builds the matching set from
`deck + sideboard + hidden`. Some submitters pasted the **entire remaining cube** into
`hidden`. Such a pool contains every card in the draft, so it overlaps every seat's picks
completely, and the scoring at `scripts/decklists.ts:156` is pure recall:

```ts
const score = picks.size > 0 ? overlap / picks.size : 0;   // 45/45 = 100% for every seat
```

A full-cube pool therefore wins against whichever seat it is compared to, and
`assignments.set(bestSeat, decklist)` evicts the deck that was correctly there. **Each
occurrence costs two seats:** one receives a stranger's deck, the true owner appears never
to have submitted. The last full run logged 27 such overwrites.

Measured impact: of 193 stored decklists, 3 are wrong — and wrong completely, at 0%
overlap with their seat's picks, not partially confused.

| Corrupted record | True owner | Match |
|---|---|---|
| `baleful-strix:1` | `baleful-strix:5` | 100% |
| `tarmogoyf:2` | `tarmogoyf:10` | 100% |
| `terminate:3` | `terminate:10` | 100% |

### The key observation this design turns on

The garbage is confined entirely to the `hidden` zone, which **is never stored**. Only
`deck + sideboard` is written to `deck_cards`. For the full-cube submissions, that stored
portion is clean and matches its true owner:

```
r1wk7SHA9B   deck=40 side=12 hidden=0     stored -> tarmogoyf seat 2  at 100%
LZYpr4rjmH   deck=40 side=12 hidden=498   stored -> tarmogoyf seat 10 at  93%
5NVp1hc5J5   deck=40 side=12 hidden=498   stored -> tarmogoyf seat 10 at  93%
```

So matching on what we store, rather than on a pool we discard, does not merely prevent
corruption — it *repairs* it. `tarmogoyf:2`, `tarmogoyf:10` and `terminate:10` are all
recovered by re-running the fixed matcher, with no hand recovery at all. This inverts the
handoff's framing, in which image parsing was the main event.

---

## Design decisions

### D1 — Match on stored cards, gate on recall *and* precision

`extractPool` drops `hidden` and is renamed `extractStoredCards`; `DecklistEntry.pool`
becomes `storedCards`. The rename is load-bearing: "pool" meaning something different from
what is stored *is* the defect, and leaving the name in place leaves the trap armed.

Scoring gains a second gate:

```ts
const overlap   = [...storedCards].filter((c) => picks.has(c)).length;
const recall    = picks.size > 0 ? overlap / picks.size : 0;          // >= 0.5
const precision = storedCards.size > 0 ? overlap / storedCards.size : 0;  // >= 0.9
```

A seat is **eligible** when precision >= 0.9 **and** recall >= 0.5. Exactly one eligible
seat assigns the list; zero eligible seats skips it.

Precision is the rotisserie invariant made executable: every card in a list must belong to
the seat it is assigned to. It is backed by measurement — 190 of 193 stored decks score
>= 95%, and the three failures score 0%. Recall stays at 0.5 because not every pick is
placed; sealeddeck's `hidden` zone legitimately holds unplaced cards, so
`stored < picks` is normal (`dark-confidant:9` has 3 unplaced picks).

More than one eligible seat cannot occur under rotisserie rules — a card belongs to exactly
one player. That case logs loudly and skips rather than picking the higher-scoring seat,
because a tie here means an assumption has broken and guessing would bury the evidence.

**Alternative rejected.** The handoff proposed `denom = max(picks.size, pool.size)`,
keeping `hidden`. It prevents corruption but *skips* full-cube submissions rather than
assigning them, leaving `tarmogoyf:10` and `terminate:10` to hand recovery and silently
producing no deck for any future full-cube paste.

### D2 — Provenance lives in `deck_hashes`

```sql
ALTER TABLE deck_hashes ADD COLUMN sealeddeck_id TEXT;
```

`deck_hashes` is already the per-seat provenance table keyed `(draft_id, seat)`; it simply
never recorded where the deck came from. Appended to `schema.sql` — `migrate.ts:97-104`
already skips duplicate-column errors, so it is idempotent — with the matching column added
to the test schema at `testDb.ts:135`.

The fetcher stamps the sealeddeck id. The importer stamps `recovered:<filename>`.

**Consequence for the hash short-circuit.** `scripts/decklists.ts:397` skips any seat whose
hash is unchanged, which would leave existing rows with a permanently null
`sealeddeck_id`. The skip condition becomes *hash matches **and** `sealeddeck_id` is
already set*; otherwise the seat is rewritten.

### D3 — `decklists.txt` is an inbox, not an archive

Once a submission is stored, its URL is removed from `data/decklists.txt`. The file's job
is "submissions not yet ingested", and whatever remains after a clean run is by definition
the unexplained residue.

This is safe only because of D2. `data/` is gitignored, so `decklists.txt` has never been
committed and its 230 URLs across 22 drafts exist on one disk. Pruning it before
provenance moved into the database would destroy the only record of which submission
produced which deck — permanently, with no git history to recover from. With D2 in place
the prune is both lossless and mechanical:

```sql
SELECT sealeddeck_id FROM deck_hashes WHERE sealeddeck_id IS NOT NULL;
-- every URL in that set is removed from decklists.txt
```

### D4 — Recovered decks are protected from being overwritten

D3 removes the *competing* URL, which is discipline. Goal 2 is stated as a requirement, so
it also gets enforcement, for free from the column D2 adds: the matcher refuses to write a
seat whose `deck_hashes.sealeddeck_id` starts with `recovered:`, logging that it skipped
and why, unless `--force` is passed.

**Residual hazard, mitigated by documentation rather than code.** `resetDraft`
(`db-helpers.ts:15-16`) deletes `deck_cards` and `deck_hashes` wholesale for a draft, and
`deleteDomainData(..., "decklists")` (`batch.ts:90-104`) does the same. A `pnpm draft:reset`
therefore discards recovered decks along with everything else. This is survivable — and
only survivable — because the parsed JSONs are committed to git at
`data/decklist-recovery/parsed/`, so recovery is re-running `pnpm decklists:import`. This
is the same class of trap CLAUDE.md already documents for `privacy_opt_outs`; it gets an
entry beside it.

### D5 — Wrong rows are deleted, and the seat joins the remediation queue

A seat still failing the precision floor after the clean re-run, with no recovered deck
available, has its `deck_cards` and `deck_hashes` rows deleted. Wrong data is worse than
missing data: today those seats are attributed a deck they never drafted, and play rate,
win rate and `deck_colors` filters all read `deck_cards`.

Deletion alone would satisfy "correct" while defeating "flagged", so the seat is
simultaneously recorded in the remediation queue (D6) with its reason.

### D6 — The remediation queue is a committed artifact

`pnpm decklists:integrity` reports two things:

1. **Suspect stored decks** — every seat scoring below the precision floor against its own
   picks.
2. **Absent decks** — every seat that drafted, did not opt out, and has no `deck_cards`,
   each with a reason: opted out / never collected / corrupt-and-deleted / awaiting image /
   awaiting URL.

Its output is committed as `data/decklist-status.md`. `data/` is gitignored, and a queue
that vanishes with the working directory is not a queue.

This is the check that would have caught the original defect within a day. It is promoted
from `data/decklist-recovery/scripts/integrity.mjs` (gitignored, throwaway) to a permanent
command. The other four investigation scripts stay throwaway.

### D7 — The `Sideboard:` parser fix is contingent

Two submissions have a literal `Sideboard:` header parsed as a card name, wrecking the
deck/sideboard split: `maelstrom-pulse:7` has 12 maindeck cards, `liliana-of-the-veil:2`
has 3. Both are currently dropped by the `maindeckQty < 20` guard
(`scripts/decklists.ts:427`).

It is not yet established whether sealeddeck returns the marker inside the `deck` zone —
in which case we can split on it and recover both decks without touching their
screenshots — or whether sealeddeck's own paste parser already destroyed the split
upstream, in which case no change on our side helps.

**Implementation opens with a fetch-and-inspect step and an explicit go/no-go.** If no-go,
both seats fall back to their screenshots, which we have. Phase 6 keeps them on its list
until this resolves.

---

## Components

### `scripts/decklists.ts` (modified)

| Unit | Responsibility |
|---|---|
| `extractStoredCards(response)` | Normalized, basics-stripped set of `deck + sideboard`. Exported for test. |
| `matchDecksToSeats(decklists, seatPicks)` | Recall + precision scoring, eligibility, assignment. Pure; unchanged signature. |
| writer loop | Provenance stamping, `recovered:` guard, hash short-circuit including provenance. |

Thresholds move to `scripts/lib/` so the integrity checker scores by the same definition
the matcher assigns by. A drift between those two numbers would make the checker certify
data the matcher would reject.

New flag: **`pnpm decklists --dry-run`** — fetch and match, print every assignment with
both scores and every skip with its reason, write nothing. Phase 3 rewrites production
with no staging environment and no undo; it needs to be readable before it is applied.
The dry run also surfaces the precision distribution, so if DFC or split-card name
resolution dents precision on some draft it appears as data rather than as silently
missing decks.

### `scripts/import-recovered-decks.ts` (new) — `pnpm decklists:import [--dry-run]`

Reads `data/decklist-recovery/parsed/*.json`
(`{draftId, seat, maindeckNonBasics[], sideboard[], ...}`), writes `deck_cards` and
`deck_hashes` with `sealeddeck_id = 'recovered:<filename>'`, reusing `batchInsertDeckCards`.

**Card ids resolve from that seat's own `pick_events`, not a global name lookup.** This is
the load-bearing choice: a card the seat never drafted becomes unresolvable *by
construction*, so a bad parse fails loudly instead of writing something plausible. A file
containing any unresolvable card writes nothing at all — no partial decks — and the run
exits non-zero.

### `scripts/decklists-integrity.ts` (new) — `pnpm decklists:integrity`

Port of `integrity.mjs`, extended per D6. Exits non-zero if any seat is suspect. Writes
the status report.

### `src/core/db/schema.sql`, `src/core/db/__tests__/testDb.ts` (modified)

The `sealeddeck_id` column, in production and test schemas.

---

## Data flow

```
data/decklists.txt ──fetch──> storedCards ──match(recall, precision)──┐
                                                                      ├─> deck_cards
data/decklist-recovery/parsed/*.json ──import(resolve via picks)──────┘   + deck_hashes
                                                                              (sealeddeck_id)
                                                                                  │
                     prune decklists.txt <──── SELECT sealeddeck_id ──────────────┤
                                                                                  │
                     data/decklist-status.md <──── decklists:integrity ───────────┘
```

---

## Phases

Each phase ends in an independently verifiable state.

| # | Phase | Touches | Done when |
|---|---|---|---|
| 1 | Matcher fix, provenance column, dry-run flag, integrity command | code only | `pnpm precommit` passes; no data touched |
| 2 | `Sideboard:` parser — investigate, then fix or record no-go | code only | go/no-go recorded with evidence |
| 3 | `pnpm db:migrate`, then `pnpm decklists --dry-run`, review, apply | **prod Turso** | integrity accounts for every seat |
| 4 | Delete residual wrong rows; record them in the queue | **prod Turso** | 0 suspect decklists |
| 5 | Importer; dry-run, review, import the 9 parsed decks | code + **prod Turso** | 9 seats populated, provenance stamped |
| 6 | Parse remaining screenshots, verify, import | files + **prod Turso** | `verify-decks.mjs` all-pass |
| 7 | Prune `decklists.txt`; write status report; update docs | local + docs | residue empty or every entry explained |

**Phase 3 begins with `pnpm db:migrate`.** The `sealeddeck_id` column must exist in
production before the clean re-run, or the run stamps nothing and phase 7's prune has
nothing to query.

**Phase 7's documentation work is specific, not incidental:**

- `docs/decklist-recovery-handoff.md` is retired or rewritten. It currently recommends the
  `max()` scoring fix this design rejects, and describes `tarmogoyf:10` / `terminate:10` as
  needing hand recovery when D1 recovers them automatically. A stale document that
  confidently recommends a rejected approach is worse than no document.
- `CLAUDE.md` gains the new commands, the "`decklists.txt` is an inbox" semantics, and the
  `draft:reset` hazard from D4 — placed beside the existing `privacy_opt_outs` reset
  hazard, since they are the same trap.
- This spec is added to the Superpowers Specs index.

Phases 1 and 2 are pure code and parallelisable under SDD. Phase 3 onward is sequential
and writes production — one database, no staging, ~230 sealeddeck fetches per full run.

**Phase 6 inventory.** Six screenshots need parsing: `tarmogoyf-seat-6`,
`maelstrom-pulse-seat-2`, `maelstrom-pulse-seat-7`, `liliana-seat-2`, `ravnica-seat-9`,
`tarkir-seat-4` — dropping to four if D7 goes ahead. `tarmogoyf-seat-10` and
`terminate-seat-10` are cross-checks only, since D1 recovers both from their URLs; they
are parsed to confirm the recovery agrees, exactly as `baleful-strix:5` was confirmed
byte-identical by two independent methods.

Each parsing agent gets a **private scratch directory**. The handoff records concurrent
agents choosing identical scratch filenames, overwriting each other, and two of them
reporting it as suspected tampering.

---

## Error handling

| Situation | Behaviour |
|---|---|
| No eligible seat, best seat has no picks | Info, not warning — this is an opted-out player's list, expected. Seven occur every run. |
| No eligible seat, best seat has picks | Warning with best seat and both scores. Genuine anomaly. |
| Two eligible seats | Warning, skip. Impossible under rotisserie rules; guessing would be worse than abstaining. |
| Seat marked `recovered:` | Skip with reason, unless `--force`. |
| `maindeckQty < 20` | Skip as today, but the seat appears in the status report instead of scrolling past in logs. |
| Importer: card not in seat's picks | Hard fail for that file. Nothing written, non-zero exit. |
| Destructive step (phases 3, 4, 5) | Dry-run first, reviewed, then applied. |

Downgrading the opt-out skip matters more than it looks: seven WARNINGs per run for
correct behaviour trains everyone to ignore the log, which is how 27 overwrite lines went
unread.

---

## Testing

**Regression tests are the point of the exercise** (`scripts/decklists.test.ts`):

- A submission with a 517-card `hidden` zone whose `deck + sideboard` belong to seat 10
  **assigns to seat 10** — not merely "fails to corrupt seat 2". Asserting only the
  absence of corruption would pass under the rejected `max()` alternative and would not
  pin the behaviour we chose.
- `extractStoredCards` excludes `hidden`.
- A list mixing two seats' cards is skipped by the precision gate.
- The four existing tests stay green unchanged; each was checked against the new scoring.

**`scripts/import-recovered-decks.test.ts`** (new): a card absent from the seat's picks
fails and writes nothing; `--dry-run` writes nothing.

**`Sideboard:` split tests** if D7 goes ahead.

`pnpm precommit` (typecheck → lint → knip → tests → e2e) gates every phase. New commands
need `package.json` entries or knip flags them.

### Manual verification

- Phase 3: dry-run report reviewed before applying.
- Phases 4, 5: `pnpm decklists:integrity` reports 0 suspect.
- Phase 6: `node data/decklist-recovery/scripts/verify-decks.mjs` all-pass.
- Phase 7: `decklists.txt` residue is empty or every remaining entry is explained.
- **`vercel --prod` at the end.** Deck data is baked into the static build at build time,
  so none of this is visible on the deployed site until a redeploy — and a data-only
  change involves no commit, so nothing triggers the git deploy.

---

## Out of scope

**The 49 uncollected seats** across `lightning-bolt`, `lorwyn`, `tarkir-fate-reforged`,
`thoughtseize` and `birds-of-paradise` (birds seat 5 opted out). Zero decklists exist for
any seat in those drafts, and none of their URLs are in `decklists.txt`. This is a
data-collection problem, not a code problem — no plan recovers data that does not exist
somewhere first. Phase 7's status report lists them so the gap is recorded rather than
forgotten.

Consequence worth stating: those seats are silently absent from play rate, win rate and
`deck_colors` statistics while their picks and match results still count.

---

## Deliberately unchanged

- **The seven skipped opted-out decklists.** Their seats have no picks by design, following
  ingest-time redaction (`docs/superpowers/specs/2026-08-08-ingest-time-redaction-design.md`).
  Skipping them is correct behaviour, not a bug to fix.
- **"Later submission wins" for the same seat.** A genuine resubmission should overwrite.
  It was never the defect — it was the symptom.
- **Basic lands are never stored.** `extractZoneCards` skips them and no stored decklist
  contains one. A "40-card deck" lives in the database as its ~26–33 non-basics.

---

## Resolved during design

- **`blightning:4` — `Battle at the Big Bridge` → `Fatal Push`.** Confirmed. The
  screenshot's mana-value-1 column holds exactly three cards (`Dark Ritual`, the card in
  question, `Reanimate`); seat 4's picks contain exactly three `{B}` one-drops
  (`Dark Ritual`, `Fatal Push`, `Reanimate`), and the other `{B}` one-drops `Bone Shards`
  and `Duress` are visibly in the sideboard. No card named "Battle at the Big Bridge"
  exists anywhere in the database. This is a set difference, not the unconditional
  leftover pairing the handoff cautioned about.
- **`tarmogoyf:6`.** The supplied URL `TNPhegPPFk` matches seat 7 at 100% and seat 6 at 2%,
  and seat 7 already stores it correctly. A screenshot has since been supplied
  (`tarmogoyf-seat-6.png`), so seat 6 is a phase 6 parse target rather than an open hunt.
