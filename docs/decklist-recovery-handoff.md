# Decklist Recovery — Handoff (superseded)

**Superseded 2026-08-09.** This investigation identified the matcher defect and recovered
nine decklists from screenshots. Its findings were correct. Its proposed fix was not
adopted, and two of its conclusions turned out to be pessimistic.

- **What was built:** `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md`
- **How:** `docs/superpowers/plans/2026-08-09-decklist-recovery.md`
- **Current data state:** `data/decklist-status.md`

## What changed from this document

**The scoring fix.** This document proposed scoring against `max(picks.size, pool.size)`
while keeping sealeddeck's `hidden` zone in the matching pool. That prevents corruption
but *skips* full-cube submissions. Matching on `deck + sideboard` instead — the cards we
actually store — with a precision floor assigns them to their true owners, so re-running
the matcher **repaired** the damage rather than merely halting it.

**Two decks this document called unrecoverable were recovered from their own URLs.** It
records that the correct submission for `baleful-strix:1` and `terminate:3` "has not yet
been identified." The fixed matcher identified both on the first clean run —
`c1pEZmaZ7X` at 97.7% precision and `LdsngziRQ2` at 100%. No rows had to be deleted; all
three corrupted seats received their real decks.

**`tarmogoyf` seat 6 was recovered.** This document lists it as OPEN with no source. A
screenshot was supplied afterwards and parsed.

**The `Sideboard:` parser fix was investigated and rejected on evidence.** The damage
happens inside sealeddeck's own paste parser, before we see the data — see
`docs/superpowers/plans/2026-08-09-sideboard-marker-finding.md`. Both affected decks were
recovered from screenshots instead.

## What held up

Everything else. The mechanism, the impact analysis, the identification of all six
affected seats, the image-recovery technique and its catalogue of transcription failure
modes, and the warning about parallel agents sharing a scratch directory — all confirmed
in practice. The `blightning:4` `Fatal Push` substitution it flagged for a human eyeball
was verified by mana-value column placement, and a second instance of the same
alternate-printing-name failure mode turned up in `tarmogoyf:6`.

Retained in git history for the investigation record.
