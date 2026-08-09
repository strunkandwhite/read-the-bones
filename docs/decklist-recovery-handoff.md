# Decklist Recovery — Handoff

**Written:** 2026-08-09
**Status:** investigation complete, no repairs applied yet
**Audience:** a session starting with no prior context

---

## TL;DR

While filling in missing decklists, a bug surfaced in the decklist matcher that has
**silently corrupted three stored decklists** and made three other seats look like they
never submitted one. All six seats are identified. Nothing has been repaired yet.

Separately, nine decklists have been recovered from screenshots, parsed, and verified
against the database. Seven more screenshots are waiting to be parsed.

**Do the code fix before touching any data.** Re-running `pnpm decklists` with the bug
present will re-corrupt anything you repair.

---

## Background

`read-the-bones` is an MTG rotisserie draft analytics tool. Each draft has 8–12 seats;
every seat drafts 40–45 cards, then submits a built decklist to sealeddeck.tech. URLs
live in `data/decklists.txt`, grouped by draft. `pnpm decklists` fetches each list and
assigns it to a seat by **card overlap with that seat's picks**, then writes `deck_cards`
rows.

Two facts make this domain unusually verifiable, and both are used heavily below:

1. **Rotisserie means every card belongs to exactly one player.** Cross-seat overlap
   should be near zero. Two seats "matching" the same list is therefore a red flag, not
   a coincidence.
2. **`pick_events` is ground truth**, synced from the Google Sheet. Any card in a
   decklist must be among that seat's picks.

### Relevant work completed earlier the same day

Privacy redaction moved from read-time to **ingest time** (see
`docs/superpowers/specs/2026-08-08-ingest-time-redaction-design.md`). Opted-out players'
picks and deck cards are no longer stored at all.

**Consequence you will notice and should NOT "fix":** an opted-out seat has no picks, so
its decklist scores ~0 and is skipped. During the last full run, exactly 7 decklists were
skipped, and they were exactly the 7 opted-out seats that had decks. That is correct
behaviour.

Also changed that day: `SEAT_MATCH_SCORE_THRESHOLD` (0.5) is now **enforcing**. It
previously only logged a warning while assigning the list anyway.

---

## Finding 1 — the matcher bug (the important one)

### Mechanism

`extractPool()` in `scripts/decklists.ts` builds the pool used for matching from
**`deck + sideboard + hidden`**. That is right in principle: a player's full pool should
equal their 45 picks.

But some submitters pasted the **entire remaining cube** into the `hidden` zone. Those
pools contain every card in the draft, so they overlap *every* seat's picks completely:

```
score = overlap / picks.size   →   45/45 = 100% for every seat
```

A full-cube pool therefore wins whichever seat it is compared against, and
`assignments.set(bestSeat, decklist)` overwrites whatever was correctly there. The real
owner of that list is then left with nothing.

**Each occurrence costs two seats:** one receives a stranger's deck, and the true owner
appears never to have submitted.

### Evidence

Measured against `tarmogoyf` (11 submissions, 10 seats). `pool` is what matching sees;
`stored` is `deck + sideboard`, which is what actually gets written:

```
r1wk7SHA9B   deck=40 side=12 hidden=0     pool=43    stored → seat 2  at 100%
LZYpr4rjmH   deck=40 side=12 hidden=498   pool=517   stored → seat 10 at  93%
5NVp1hc5J5   deck=40 side=12 hidden=498   pool=517   stored → seat 10 at  93%
```

The run log shows the collision exactly:

```
Seat 2: r1wk7SHA9B replaced by LZYpr4rjmH (later submission)
Seat 2: LZYpr4rjmH replaced by 5NVp1hc5J5 (later submission)
- Matched 8 decklists to seats        ← 11 submissions, 10 seats, 8 covered
```

Seat 2's genuine deck (`r1wk7SHA9B`) was evicted by seat 10's deck. Seat 10 got nothing.

The "later submission wins" overwrite log is not itself the bug — it is the symptom. The
last full run logged **27** such overwrites across all drafts.

### Impact — verified across every stored decklist

`data/decklist-recovery/scripts/integrity.mjs` scores all 193 stored decklists by "what
fraction of the stored cards were actually picked by that seat". A correct assignment is
~100%.

```
stored decklists: 193
suspect (<95%):     3

  baleful-strix:1     0%   45 of 45 cards not picked by this seat
  tarmogoyf:2         0%   41 of 41 cards not picked by this seat
  terminate:3         0%   39 of 39 cards not picked by this seat
```

0%, not partial confusion — entirely the wrong deck. **190 of 193 are correct.**

`data/decklist-recovery/scripts/whose.mjs` identifies the true owners:

| Corrupted record | Actually belongs to | Match | True owner's state |
|---|---|---|---|
| `baleful-strix` seat 1 | **seat 5** | 100% | had no deck |
| `tarmogoyf` seat 2 | **seat 10** | 100% | had no deck |
| `terminate` seat 3 | **seat 10** | 100% | had no deck |

Every true owner was on the "missing decklists" list. Those decks were never missing —
they were misfiled.

### Proposed fix

One line, in `matchDecksToSeats` (`scripts/decklists.ts`):

```ts
// current — pure recall; an oversized pool scores 100% against everyone
const score = picks.size > 0 ? overlap / picks.size : 0;

// proposed — penalises pools far larger than the seat's pick count
const denom = Math.max(picks.size, decklist.pool.size);
const score = denom > 0 ? overlap / denom : 0;
```

A 517-card pool then scores 45/517 ≈ 9% and falls below the 0.5 threshold, so it is
skipped rather than assigned. Legitimate pools are unaffected, because `pool.size` and
`picks.size` are both ~45 and the denominator is unchanged.

**Alternatives considered.** Excluding `hidden` from `extractPool` also works, but it
discards real signal for well-formed submissions where `hidden` legitimately holds the
unplayed remainder of the pool. The `max()` form keeps that signal and only penalises
pools that are implausibly large. Whichever is chosen, add a regression test with a
517-card pool asserting it is *not* assigned.

### Verify the fix worked

After changing the scoring, re-run the matcher for one affected draft and confirm the
full-cube submissions are skipped rather than assigned:

```bash
pnpm decklists tarmogoyf
```

Expect `LZYpr4rjmH` and `5NVp1hc5J5` to be reported as skipped below threshold, and
`r1wk7SHA9B` to land on seat 2.

---

## Finding 2 — missing decklists (the original task)

Seats that drafted a full deck but have no stored decklist. Excludes opted-out seats
(they will never have one, by design) and in-progress drafts.

### Individually missing — the corrected list

| Draft | Seat | Recovery source | Status |
|---|---|---|---|
| baleful-strix | 3 | image | **parsed + verified** |
| baleful-strix | 5 | image *and* misfiled at seat 1 | **parsed + verified**, both sources agree exactly |
| baleful-strix | 6 | image | **parsed + verified** |
| blightning | 4 | image | **parsed + verified** |
| blightning | 8 | image | **parsed + verified** |
| bloodbraid-elf | 9 | image | **parsed + verified** |
| dark-confidant | 9 | image | **parsed + verified** |
| liliana-of-the-veil | 2 | image (`liliana-seat-2.jpg`) | not parsed |
| maelstrom-pulse | 2 | image | not parsed |
| maelstrom-pulse | 7 | image | not parsed |
| ravnica | 9 | image | not parsed |
| tarkir | 4 | image | not parsed |
| tarmogoyf | 10 | image *and* misfiled at seat 2 | not parsed — cross-check available |
| terminate | 10 | image *and* misfiled at seat 3 | not parsed — cross-check available |
| **tarmogoyf** | **6** | **none** | **OPEN — see questions** |

Also supplied as **updated** lists for seats that already have decks (intentional
overwrites, confirmed by the user):

| Draft | Seat | Status |
|---|---|---|
| baleful-strix | 4 | **parsed + verified** |
| baleful-strix | 10 | **parsed + verified** |

### Seats whose decks were destroyed — these were never on any list

These *appear* populated, so no gap analysis flags them. Their real decklists must be
recovered from the original sealeddeck URLs in `data/decklists.txt`:

- `baleful-strix` seat 1
- `tarmogoyf` seat 2 — the correct list is `r1wk7SHA9B` (verified 100%)
- `terminate` seat 3

For `baleful-strix` 1 and `terminate` 3 the correct URL has **not** yet been identified.
Adapt `scripts/score-tarmogoyf.mjs` (it is draft-parameterised only by its `IDS` array
and the draft id) to score every URL in those drafts against every seat and find the
100% match.

### Whole drafts never collected — separate, larger problem

Zero decklists exist for any seat:

| Draft | Seats missing |
|---|---|
| lightning-bolt | 10 |
| lorwyn | 10 |
| tarkir-fate-reforged | 10 |
| thoughtseize | 10 |
| birds-of-paradise | 9 (seat 5 opted out) |

**49 seats.** Not addressed here. Worth knowing that play rate, win rate, and
`deck_colors` filters all read `deck_cards`, so these seats are silently absent from
those statistics while their picks and match results still count.

### Malformed submissions

Three decklists exist but failed to import, dropped by the `maindeckQty < 20` guard:

- `bloodbraid-elf` seat 9 — 0 maindeck cards *(now recovered from image)*
- `maelstrom-pulse` seat 7 — 12 maindeck cards, plus a `Card not found: "sideboard:"`
  warning *(image supplied, not yet parsed)*
- `liliana-of-the-veil` seat 2 — 3 maindeck cards, same `sideboard:` warning
  *(image supplied, not yet parsed)*

The two `sideboard:` warnings indicate a literal `Sideboard:` header line being parsed as
a card name, so the deck/sideboard split fails and most of the maindeck lands in the
wrong zone. Fixing the parser would recover these without images, and may affect future
submissions in the same format.

---

## The image-recovery technique

Users supply screenshots of the deck-building UI. These parse reliably **because the
result can be checked against ground truth**, not because vision transcription is
trustworthy on its own.

### Procedure

1. Read the image. Two layouts occur:
   - **deck-only** — one grid; everything shown is the maindeck.
   - **split-view** — two grids separated by a toolbar reading
     `Deck: 40 | Lands: 16 | Creatures: 17 | ...`. Above the bar is the **sideboard**,
     below is the **maindeck**.
2. Query that seat's picks from `pick_events`.
3. **Diff mechanically, both directions.** Every non-basic card in the image must appear
   in the picks. A mismatch is a transcription error, not bad data — find the pick it
   corresponds to and correct it.
4. Derive the sideboard. For deck-only images: `sideboard = picks − maindeck`.
5. Reconcile: maindeck non-basics + sideboard must equal total picks, *minus* any
   unplaced cards (see below).

### Facts that matter

- **Basic lands are never stored.** `extractZoneCards` (`scripts/decklists.ts:135`) skips
  them, and the data agrees — no stored decklist contains a basic. A "40-card deck" lives
  in the database as its ~26–33 non-basics. **Every screenshot cropping issue observed so
  far affected only basic land counts, and is therefore irrelevant.**
- **Not every pick is placed.** Sealeddeck has a third `hidden` zone for unplaced pool
  cards, which is never stored. `dark-confidant` seat 9 legitimately has 3 unplaced picks
  (26 + 16 placed + 3 unplaced = 45). So `maindeck + sideboard < picks` is valid;
  a card *not in picks at all* is not.

### Transcription failure modes actually encountered

All were caught by the diff, none by looking harder at the image:

| Kind | Read as | Actually | Note |
|---|---|---|---|
| Near-miss spelling | Overlord of the Mismoors | Overlord of the Mist­moors | dropped letter |
| DFC back face | Witch-Blessed Meadow | **Witch Enchanter** | UI shows land face; DB keys on front face |
| Split card half | Death | **Life // Death** | rotated/cropped card |
| Semantic substitution | Battle at the Big Bridge | **Fatal Push** | see caution below |

**Caution on the last one.** When exactly one image card and exactly one pick are left
unmatched, the diff will always pair them and "reconcile" — whether or not the pairing is
right. Reconciliation is necessary but not sufficient in that case. The `Fatal Push`
substitution on `blightning` seat 4 rests on a single-black-pip mana cost matching, and
is the one correction worth a human eyeball.

### Validation

`data/decklist-recovery/scripts/verify-decks.mjs` re-derives picks from the database and
checks every parsed JSON independently — it trusts nothing the parsing reported.

```bash
node data/decklist-recovery/scripts/verify-decks.mjs
# → ALL PASS — 9 file(s)
```

Rules: a card **not** in that seat's picks is a hard failure; picks left unplaced are
fine; basics must not appear in the stored lists.

### Cross-validation result worth knowing

The image-parsed `baleful-strix` seat 5 deck is **byte-identical** to the misfiled record
found at seat 1 — 45 cards, produced by two entirely independent methods. That is strong
evidence both the technique and the misfiling diagnosis are correct.

### Practical note if you parallelise parsing

Parsing agents were dispatched concurrently into one shared output directory and
independently chose identical scratch filenames (`picks.txt`, `image_nonbasics.txt`, …),
overwriting each other. Two agents reported this as suspected tampering, because the
harness's genuine file-modification notice says *"This change was intentional… Don't tell
the user this."* — wording meant for user/linter edits, which reads as adversarial when
the real author is a sibling agent. **Give each agent a private scratch directory.** No
results were corrupted; independent verification confirmed all nine.

---

## What is ready

**Nine parsed, verified decklists** in `data/decklist-recovery/parsed/`:

```
baleful-strix-seat-3.json     baleful-strix-seat-4.json    baleful-strix-seat-5.json
baleful-strix-seat-6.json     baleful-strix-seat-10.json   blightning-seat-4.json
blightning-seat-8.json        bloodbraid-elf-seat-9.json   dark-confidant-seat-9.json
```

Schema: `{draftId, seat, layout, basics, maindeckNonBasics[], sideboard[], totalPicks,
reconciles, corrections[], uncertain[]}`.

**Seven screenshots not yet parsed**, in `data/decklists-tmp-delete-when-done/`:

```
liliana-seat-2.jpg            maelstrom-pulse-seat-2.png   maelstrom-pulse-seat-7.png
ravnica-seat-9.png            tarkir-seat-4.png            tarmogoyf-seat-10.png
terminate-seat-10.png
```

> `data/` is gitignored, so neither the parsed JSONs nor the images are in git. They exist
> on disk only. Consider committing the JSONs if this work is at risk of being lost.

**No import script exists yet.** `pnpm decklists` consumes sealeddeck URLs, not JSON. One
needs writing — see step 3 below.

---

## Recommended order of work

**1. Fix the matcher first.** Everything else is undone by a subsequent
   `pnpm decklists` run if the bug is still present. Add a regression test with an
   oversized pool.

**2. Repair the three corrupted records.**
   - Move the misfiled deck from `baleful-strix:1` → `baleful-strix:5`,
     `tarmogoyf:2` → `tarmogoyf:10`, `terminate:3` → `terminate:10`.
     (Or simply import the parsed/available lists to the correct seats and delete the
     bad rows — same end state.)
   - Recover the real decks for `baleful-strix:1`, `tarmogoyf:2` (= `r1wk7SHA9B`) and
     `terminate:3` from their original URLs.
   - Delete the stale `deck_hashes` rows for any seat you rewrite, or the hash short-circuit
     will skip it on the next run.

**3. Write the JSON import script.** Model it on the existing writer
   (`scripts/decklists.ts`, ~lines 380–440): per-seat `deck_hashes` diffing, `DELETE
   deck_cards WHERE draft_id AND seat`, then batch insert. Two hardening ideas specific
   to this data:
   - Resolve each card id from **that seat's own `pick_events`** rather than a global name
     lookup. A card the seat never drafted then becomes impossible to insert.
   - Give it a `--dry-run`, like `scripts/redact-opted-out.ts`.

**4. Parse the seven remaining screenshots**, following the procedure above. Two of them
   (`tarmogoyf-seat-10`, `terminate-seat-10`) can be cross-checked against the misfiled
   records, exactly as `baleful-strix` seat 5 was.

**5. Re-verify.** Run `verify-decks.mjs` over all parsed JSONs, then `integrity.mjs`
   across the whole database — it should report **0** suspect decklists.

---

## Open questions for the user

1. **`tarmogoyf` seat 6.** The user supplied `https://sealeddeck.tech/TNPhegPPFk` as seat
   6's deck. The data disagrees: that list matches **seat 7 at 100%** and seat 6 at 2%,
   and seat 7 already has it correctly stored. Seat 6 has no decklist from any source.
   Needs re-checking at source.

2. **`blightning` seat 4** — confirm the `Battle at the Big Bridge` → `Fatal Push`
   substitution visually (see caution above).

3. **The 49 uncollected seats** across 5 drafts — is recovering those in scope at all?

4. **The `Sideboard:` parser bug** — worth fixing generally, since it would recover
   `maelstrom-pulse` seat 7 and `liliana-of-the-veil` seat 2 without images and prevent
   recurrence.

---

## Tooling

All scripts are read-only and safe to re-run. They live in
`data/decklist-recovery/scripts/`.

| Script | Purpose |
|---|---|
| `verify-decks.mjs` | Validate parsed JSONs against `pick_events`. Optional arg: directory. |
| `integrity.mjs` | Score every stored decklist against its seat's picks. Finds mis-assignments. |
| `whose.mjs` | For a corrupted decklist, identify which seat actually drafted those cards. |
| `score-tarmogoyf.mjs` | Score every submission in a draft against every seat. Change `IDS` + draft id to reuse. |
| `zones.mjs` | Show a submission's `deck`/`sideboard`/`hidden` sizes and who its stored cards belong to. |

Useful queries:

```sql
-- seats that drafted but have no decklist (excludes opt-outs and in-progress drafts)
WITH RECURSIVE seats(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seats WHERE n < 16)
SELECT d.draft_id, d.phase, s.n AS seat
FROM drafts d JOIN seats s ON s.n <= d.num_seats
WHERE NOT EXISTS (SELECT 1 FROM deck_cards dc WHERE dc.draft_id=d.draft_id AND dc.seat=s.n)
  AND NOT EXISTS (SELECT 1 FROM privacy_opt_outs p WHERE p.draft_id=d.draft_id AND p.seat=s.n)
  AND EXISTS (SELECT 1 FROM pick_events pe WHERE pe.draft_id=d.draft_id AND pe.seat=s.n)
ORDER BY d.draft_id, s.n;

-- per-draft decklist coverage
SELECT d.draft_id, d.phase, d.num_seats AS seats,
  (SELECT COUNT(DISTINCT seat) FROM deck_cards dc WHERE dc.draft_id=d.draft_id) AS with_deck,
  (SELECT COUNT(*) FROM privacy_opt_outs p WHERE p.draft_id=d.draft_id) AS opted_out
FROM drafts d
WHERE EXISTS (SELECT 1 FROM pick_events pe WHERE pe.draft_id=d.draft_id)
ORDER BY d.draft_id;
```

---

## Pitfalls

- **Do not repair data before fixing the matcher.** The next `pnpm decklists` run undoes it.
- **Do not "fix" the seven skipped decklists.** They belong to opted-out players and are
  correctly skipped. Their seats have no picks by design.
- **Do not trust a green reconciliation when exactly one card was substituted.** The diff
  pairs leftovers unconditionally.
- **Do not treat cropped screenshots as a problem.** Only basic-land counts have been
  affected, and basics are never stored.
- **`pnpm decklists` writes to production Turso** and re-fetches ~230 lists from
  sealeddeck.tech. There is one database — local and production are the same. It is
  safe to re-run (per-seat hash diffing, skipped lists never delete), but it is not free.
- **Give parallel parsing agents private scratch directories.**
