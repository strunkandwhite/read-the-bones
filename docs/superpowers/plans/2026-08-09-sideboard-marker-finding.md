# `Sideboard:` marker investigation — NO-GO

Task 7 of the decklist-recovery branch. Investigates whether the two decklists
dropped by the `maindeckQty < 20` guard (`maelstrom-pulse` seat 7,
`liliana-of-the-veil` seat 2) can be recovered by splitting sealeddeck's `deck`
zone on a literal `Sideboard:` marker card.

**Decision: NO-GO.** No code change made. Both seats fall back to screenshots.

## Ids inspected

Seat assignment was confirmed by running the actual matcher
(`npx tsx scripts/decklists.ts <draft> --dry-run`), not by assuming file-order
== seat number — the seat numbers in `data/decklists.txt` order do not match
draft seat numbers.

- `maelstrom-pulse` seat 7 → sealeddeck id `mj3phaBivi`
  (`https://sealeddeck.tech/mj3phaBivi`), recall 93.2%, precision 95.3%.
- `liliana-of-the-veil` seat 2 → sealeddeck id `jwuA2DYroE`
  (`https://sealeddeck.tech/jwuA2DYroE`), recall 100.0%, precision 97.4%.

## Raw zone sizes

Fetched directly from `https://sealeddeck.tech/api/pools/<id>`:

| id | deck | sideboard | hidden |
|---|---|---|---|
| `mj3phaBivi` (maelstrom-pulse seat 7) | 16 | 33 | 0 |
| `jwuA2DYroE` (liliana-of-the-veil seat 2) | 4 | 37 | 0 |

## Marker positions

Both pools contain exactly one card matching `/^sideboard:?$/i`: the literal
name `"sideboard:"` (already lowercase in the raw JSON — every card name in
this pool's response is stored lowercase, e.g. `"island"`, `"mountain"`, so
the lowercase rendering in the `Card not found: "sideboard:"` warning is not
evidence of any transformation on our side, just how sealeddeck stores names).

In **both** pools the marker is at **index 0 of the `deck` array** — the very
first entry, with nothing preceding it:

- `mj3phaBivi` deck zone (16 entries): `["sideboard:", "island", "mountain",
  "swamp", "into the flood maw", "fire magic", "aether spellbomb",
  "miscalculation", "power word kill", "phyrexian revoker", "cryptic coat",
  "lutri, the spellchaser", "phyrexian metamorph", "temporal manipulation",
  "murderous cut", "grave titan"]`. After the marker: 3 basics (filtered by
  `BASIC_LANDS`) + 12 nonbasic spells — this is exactly where the reported
  "12 maindeck cards" comes from.
- `jwuA2DYroE` deck zone (4 entries): `["sideboard:", "nethergoyf",
  "tear asunder", "balustrade wurm"]`. After the marker: 3 nonbasic spells —
  exactly the reported "3 maindeck cards."

Meanwhile the real `sideboard` zone in both pools is far larger than any
plausible 15-card sideboard, and full of cards that read as maindeck staples,
not sideboard cards:

- `mj3phaBivi` sideboard (33 entries) includes Jace, Vryn's Prodigy; Urza,
  Lord High Artificer; Fable of the Mirror-Breaker; Etali, Primal Conqueror;
  Screaming Nemesis; Superior Spider-Man; Expressive Iteration — plus 9 basics
  (island x4, mountain x3, swamp x2) and several nonbasic fixing lands (Arid
  Mesa, Blood Crypt, Scalding Tarn, Steam Vents x2, Watery Grave, etc).
- `jwuA2DYroE` sideboard (37 entries) includes Bloodchief's Thirst, Fatal
  Push, Reanimate, Unearth, Demonic Tutor, Tireless Tracker, Glissa Sunslayer,
  Grist the Hunger Tide, Uro Titan of Nature's Wrath — plus 4 basics
  (forest x2, swamp x2) and multiple fetch/fixing lands.

## Decision and reasoning

**NO-GO.** This fails the brief's GO criterion on both prongs:

1. **No maindeck precedes the marker.** The GO condition requires "maindeck
   before it, sideboard after it" inside the `deck` array. Here the marker
   sits at `deck[0]` with nothing before it at all.
2. **What follows the marker in `deck` is not the whole maindeck.** Only 12
   (or 3) nonbasic spells trail the marker — nowhere near a full ~23-spell
   maindeck. The rest of what was clearly intended as maindeck material (real
   spells, plus fetch/fixing lands and the bulk of the basics) is sitting
   inside sealeddeck's own `sideboard` zone, indistinguishable from any cards
   the submitter genuinely intended as sideboard. There is no second marker,
   no ordering signal, and no other structure in the `sideboard` array that
   would let us partition "misfiled maindeck cards" from "real sideboard
   cards" — the oversized sideboard zone (33 and 37 entries, versus a normal
   ~15) is exactly the "scattered across zones with no recoverable order"
   case the brief calls out as NO-GO.

This matches the hint in the task brief: a *small* stored maindeck (12, 3) is
consistent with most of the real maindeck having landed in `sideboard`, not
with a large `deck` zone that just needs to be split at a marker partway
through. That is what the data shows.

sealeddeck's own paste parser destroyed the deck/sideboard split upstream —
most likely because the submitter's pasted text decklist put its own
`Sideboard:` header as the very first line (before any maindeck content), so
sealeddeck's parser started a fresh "zone" at line 1, misclassified the bulk
of the list into the wrong bucket, and left only the fragment after that
first line's card-like token in `deck`. Nothing recoverable exists on our
side: we cannot reconstruct which `sideboard`-zone entries were actually
maindeck cards without re-parsing the submitter's original paste, which we
do not have.

## Outcome

- No change to `scripts/decklists.ts` or `scripts/decklists.test.ts`.
- `maelstrom-pulse` seat 7 and `liliana-of-the-veil` seat 2 remain below the
  `maindeckQty < 20` guard and continue to fall back to their screenshots,
  which already exist for both seats.
