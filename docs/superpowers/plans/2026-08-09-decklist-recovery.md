# Decklist Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every stored decklist correct, flag the ones that can't be, and stop the matcher from ever silently misfiling a deck again.

**Architecture:** The matcher currently scores submissions against a card pool that includes sealeddeck's `hidden` zone, which we never store. Some submitters pasted the entire cube into `hidden`, so those lists matched every seat at 100% and evicted correct decks. Matching on `deck + sideboard` — exactly what we store — plus a precision gate makes the rotisserie invariant ("every card has exactly one owner") executable, and repairs three misfiled decks as a side effect of re-running. Provenance moves into `deck_hashes` so `data/decklists.txt` can become an inbox rather than an archive without destroying the record of which submission produced which deck.

**Tech Stack:** TypeScript, `tsx` for scripts, `@libsql/client` (Turso), Vitest, Next.js 15.

**Spec:** `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md`
**Investigation:** `docs/decklist-recovery-handoff.md`

## Global Constraints

- **Recall threshold: `0.5`.** A list must cover at least this fraction of the seat's picks.
- **Precision threshold: `0.9`.** At least this fraction of the list's cards must be cards the seat actually picked.
- Both thresholds live in **one module** (`scripts/lib/deckMatching.ts`) and are imported by both the matcher and the integrity checker. They must never be redefined locally.
- **Basic lands are never stored.** `BASIC_LANDS` filtering applies everywhere card sets are built.
- **Card names normalize** via `normalizeCardName` then `.toLowerCase()` before any comparison.
- **There is one database.** Local and production are the same Turso instance. Every script that writes must support `--dry-run`, and every destructive step is dry-run-reviewed before it is applied.
- **`data/` is gitignored.** Anything that must survive belongs in `docs/`.
- `pnpm precommit` (typecheck → lint → knip → tests → e2e) must pass before any commit that touches code. A husky pre-push hook enforces it.
- Commit messages: focus on *why*, 1-2 sentences, and end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Always use `git -C /Users/arpanet/code/read-the-bones <cmd>`.** Never `cd && git`.
- Work happens on branch `decklist-recovery`.

---

## Task Ordering

Tasks 1-6 are code only and touch no data. Task 7 is an investigation with a go/no-go. Tasks 8-12 write production and are strictly sequential.

**Task 2B was added after Task 2's review**, which found two defects in the files Task 2 touched — neither caused by it. It runs before Task 3 because both edit `scripts/decklists.ts`.

| Task | Deliverable | Touches |
|---|---|---|
| 1 | Shared scoring module | code |
| 2 | Matcher fix + regression tests | code |
| 2B | Guard module-scope `main()`; make the regression test fail behaviorally | code |
| 3 | Provenance column + writer changes | code (schema) |
| 4 | `--dry-run` for `pnpm decklists` | code |
| 5 | Integrity command | code |
| 6 | Recovered-deck importer | code |
| 7 | `Sideboard:` parser — investigate, then fix or record no-go | code |
| 8 | Migrate + clean re-run | **prod Turso** |
| 9 | Delete residual wrong rows | **prod Turso** |
| 10 | Import the nine recovered decks | **prod Turso** |
| 11 | Parse remaining screenshots | files + **prod Turso** |
| 12 | Prune inbox, status report, docs, deploy | local + docs |

---

## File Structure

**Create:**
- `scripts/lib/deckMatching.ts` — scoring primitives and thresholds. Pure, no I/O. Imported by the matcher and the integrity checker so both agree on what "belongs to this seat" means.
- `scripts/lib/deckMatching.test.ts` — unit tests for the above.
- `scripts/decklists-integrity.ts` — CLI: scores every stored deck, lists every absent deck, optionally writes the status report.
- `scripts/import-recovered-decks.ts` — CLI: imports hand-parsed JSON decklists, resolving card ids from the seat's own picks.
- `scripts/import-recovered-decks.test.ts` — tests for the importer's resolution and failure behaviour.
- `docs/decklist-status.md` — the remediation queue (Task 12).

**Modify:**
- `scripts/decklists.ts` — `extractPool` → `extractStoredCards` (drops `hidden`), `matchDecksToSeats` scoring, writer provenance + `recovered:` guard, `--dry-run`, `--force`.
- `scripts/decklists.test.ts` — new regression tests.
- `src/core/db/schema.sql` — `sealeddeck_id` column.
- `src/core/db/__tests__/testDb.ts:135-141` — same column in the test schema.
- `package.json` — `decklists:integrity`, `decklists:import` scripts.
- `CLAUDE.md` — new commands, inbox semantics, `draft:reset` hazard.
- `docs/decklist-recovery-handoff.md` — retired (Task 12).

---

### Task 1: Shared scoring module

The matcher and the integrity checker must score identically. If they drift, the checker certifies data the matcher would reject. One module, imported by both.

**Files:**
- Create: `scripts/lib/deckMatching.ts`
- Test: `scripts/lib/deckMatching.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SEAT_MATCH_RECALL_THRESHOLD: number` (0.5)
  - `SEAT_MATCH_PRECISION_THRESHOLD: number` (0.9)
  - `interface SeatScore { overlap: number; recall: number; precision: number }`
  - `scoreAgainstSeat(storedCards: Set<string>, picks: Set<string>): SeatScore`
  - `isEligibleSeat(score: SeatScore): boolean`
  - `formatPct(fraction: number): string` — e.g. `0.9333` → `"93.3%"`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/deckMatching.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  scoreAgainstSeat,
  isEligibleSeat,
  formatPct,
  SEAT_MATCH_PRECISION_THRESHOLD,
  SEAT_MATCH_RECALL_THRESHOLD,
} from "./deckMatching";

describe("scoreAgainstSeat", () => {
  it("scores a perfect match at 1.0 on both axes", () => {
    const cards = new Set(["bolt", "swords"]);
    const picks = new Set(["bolt", "swords"]);
    expect(scoreAgainstSeat(cards, picks)).toEqual({ overlap: 2, recall: 1, precision: 1 });
  });

  it("reports high precision and low recall when picks went unplaced", () => {
    // The seat drafted 4 cards but only placed 2. Every placed card is theirs.
    const cards = new Set(["bolt", "swords"]);
    const picks = new Set(["bolt", "swords", "ragavan", "brainstorm"]);
    const score = scoreAgainstSeat(cards, picks);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(0.5);
  });

  it("reports low precision when the list contains cards the seat never picked", () => {
    const cards = new Set(["bolt", "counterspell", "ponder", "opt"]);
    const picks = new Set(["bolt", "swords"]);
    const score = scoreAgainstSeat(cards, picks);
    expect(score.overlap).toBe(1);
    expect(score.precision).toBe(0.25);
  });

  it("returns zeros rather than NaN for empty inputs", () => {
    expect(scoreAgainstSeat(new Set(), new Set())).toEqual({ overlap: 0, recall: 0, precision: 0 });
  });
});

describe("isEligibleSeat", () => {
  it("requires both precision and recall above their thresholds", () => {
    expect(isEligibleSeat({ overlap: 40, recall: 0.9, precision: 1 })).toBe(true);
    // precision below floor: the list holds cards this seat never drafted
    expect(isEligibleSeat({ overlap: 40, recall: 0.9, precision: 0.5 })).toBe(false);
    // recall below floor: the list covers too little of the seat's pool
    expect(isEligibleSeat({ overlap: 5, recall: 0.1, precision: 1 })).toBe(false);
  });

  it("treats a score exactly on each threshold as eligible", () => {
    expect(
      isEligibleSeat({
        overlap: 1,
        recall: SEAT_MATCH_RECALL_THRESHOLD,
        precision: SEAT_MATCH_PRECISION_THRESHOLD,
      }),
    ).toBe(true);
  });
});

describe("formatPct", () => {
  it("renders a fraction as a one-decimal percentage", () => {
    expect(formatPct(0.9333)).toBe("93.3%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct(0)).toBe("0.0%");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run scripts/lib/deckMatching.test.ts
```

Expected: FAIL — `Failed to resolve import "./deckMatching"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/lib/deckMatching.ts`:

```ts
/**
 * Scoring shared by the decklist matcher and the integrity checker.
 *
 * Both answer the same question — does this list belong to this seat? — and
 * must answer it the same way. If the two drift apart, the checker certifies
 * data the matcher would have rejected.
 */

/**
 * A list must cover at least this fraction of the seat's picks.
 * Well below 1.0 because not every pick is placed: sealeddeck's `hidden` zone
 * legitimately holds unplaced pool cards, so `stored < picks` is normal.
 */
export const SEAT_MATCH_RECALL_THRESHOLD = 0.5;

/**
 * At least this fraction of the list's cards must be cards the seat picked.
 *
 * This is the rotisserie invariant made executable: every card belongs to
 * exactly one player, so a correctly assigned list scores ~1.0. Measured
 * across 193 stored decks, 190 scored >= 0.95 and every mis-assignment
 * scored 0.
 */
export const SEAT_MATCH_PRECISION_THRESHOLD = 0.9;

export interface SeatScore {
  /** Cards present in both the list and the seat's picks. */
  overlap: number;
  /** Fraction of the seat's picks the list covers. Low when picks went unplaced. */
  recall: number;
  /** Fraction of the list the seat actually picked. Low means it is the wrong seat. */
  precision: number;
}

/** Score one decklist's stored cards against one seat's picks. */
export function scoreAgainstSeat(storedCards: Set<string>, picks: Set<string>): SeatScore {
  let overlap = 0;
  for (const card of storedCards) {
    if (picks.has(card)) overlap++;
  }

  return {
    overlap,
    recall: picks.size > 0 ? overlap / picks.size : 0,
    precision: storedCards.size > 0 ? overlap / storedCards.size : 0,
  };
}

/** A seat can receive a decklist only if it clears both thresholds. */
export function isEligibleSeat(score: SeatScore): boolean {
  return (
    score.precision >= SEAT_MATCH_PRECISION_THRESHOLD &&
    score.recall >= SEAT_MATCH_RECALL_THRESHOLD
  );
}

/** Render a 0-1 fraction as a percentage for log output. */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run scripts/lib/deckMatching.test.ts
```

Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/lib/deckMatching.ts scripts/lib/deckMatching.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Give the matcher and integrity checker one definition of a seat match

They answer the same question and must answer it the same way; a drift
between them would let the checker certify data the matcher rejects.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Match on stored cards, gated on precision

The defect and its fix. `extractPool` includes `hidden`, which we never store; full-cube `hidden` zones therefore matched every seat at 100% and evicted correct decks.

**Files:**
- Modify: `scripts/decklists.ts:28` (threshold const), `:59-65` (`DecklistEntry`), `:111-125` (`extractPool`), `:144-183` (`matchDecksToSeats`), `:243-251` (call site)
- Test: `scripts/decklists.test.ts`

**Interfaces:**
- Consumes: `scoreAgainstSeat`, `isEligibleSeat`, `formatPct`, `SEAT_MATCH_RECALL_THRESHOLD`, `SEAT_MATCH_PRECISION_THRESHOLD` from Task 1.
- Produces:
  - `extractStoredCards(response: SealedDeckResponse): Set<string>` — exported for test.
  - `DecklistEntry.storedCards: Set<string>` (renamed from `pool`).
  - `matchDecksToSeats(decklists: DecklistEntry[], seatPicks: Map<number, Set<string>>): Map<number, DecklistEntry>` — signature unchanged.

**Why the rename matters:** "pool" meaning something different from what we store *is* the defect. Leaving the name in place leaves the trap armed for the next reader.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `scripts/decklists.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { matchDecksToSeats, extractStoredCards } from "./decklists";

const entry = (id: string, cards: string[]) => ({
  sealeddeckId: id,
  url: `https://sealeddeck.tech/${id}`,
  storedCards: new Set(cards),
  deck: [],
  sideboard: [],
});

describe("extractStoredCards", () => {
  it("excludes the hidden zone", () => {
    // Some submitters pasted the entire remaining cube into `hidden`. We never
    // store that zone, so it must not influence matching either.
    const stored = extractStoredCards({
      poolId: "x",
      deck: [{ name: "Lightning Bolt", count: 1 }],
      sideboard: [{ name: "Brainstorm", count: 1 }],
      hidden: [{ name: "Black Lotus", count: 1 }],
    });
    expect(stored).toEqual(new Set(["lightning bolt", "brainstorm"]));
  });

  it("excludes basic lands and normalizes names", () => {
    const stored = extractStoredCards({
      poolId: "x",
      deck: [
        { name: "Island", count: 8 },
        { name: "Scalding Tarn 2", count: 1 },
      ],
      sideboard: [],
    });
    expect(stored).toEqual(new Set(["scalding tarn"]));
  });
});

describe("matchDecksToSeats", () => {
  const seatPicks = new Map([
    [1, new Set(["bolt", "swords", "ragavan", "brainstorm"])],
    [2, new Set(["counterspell", "ponder", "preordain", "opt"])],
  ]);

  it("assigns a decklist to the seat it overlaps", () => {
    const result = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"])],
      seatPicks,
    );
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("skips a decklist that matches no seat above the threshold", () => {
    // an opted-out player's list: their seat has no picks, so it is absent
    // from seatPicks and this overlaps nobody
    const result = matchDecksToSeats([entry("zzz", ["llanowar elves", "giant growth"])], seatPicks);
    expect(result.size).toBe(0);
  });

  it("never overwrites a good assignment with a sub-threshold one", () => {
    const result = matchDecksToSeats(
      [entry("aaa", ["bolt", "swords", "ragavan", "brainstorm"]), entry("zzz", ["bolt"])],
      seatPicks,
    );
    expect(result.get(1)?.sealeddeckId).toBe("aaa");
  });

  it("never produces a seat -1 assignment", () => {
    const result = matchDecksToSeats([entry("zzz", ["nothing at all"])], seatPicks);
    expect(result.has(-1)).toBe(false);
  });

  it("assigns a full-cube submission to its true owner", () => {
    // Regression for the corruption bug. This submission carried the whole cube
    // in `hidden`, but its deck+sideboard belong to seat 2 and nobody else.
    // Asserting only "seat 1 is not corrupted" would pass under a fix that
    // merely skips the list; the point is that seat 2 gets its deck.
    const result = matchDecksToSeats(
      [entry("LZYpr4rjmH", ["counterspell", "ponder", "preordain", "opt"])],
      seatPicks,
    );
    expect(result.get(2)?.sealeddeckId).toBe("LZYpr4rjmH");
    expect(result.has(1)).toBe(false);
  });

  it("skips a list whose cards span two seats", () => {
    // Precision gate: a list half of whose cards were drafted by someone else
    // cannot belong to either seat. Recall against seat 1 is 0.5, which clears
    // the recall floor on its own — only precision rejects this.
    const result = matchDecksToSeats(
      [entry("mixed", ["bolt", "swords", "counterspell", "ponder"])],
      seatPicks,
    );
    expect(result.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run scripts/decklists.test.ts
```

Expected: FAIL — `extractStoredCards` is not exported, and the two new `matchDecksToSeats` cases fail (the full-cube case currently assigns to seat 1 at 100% recall; the mixed case currently assigns to seat 1).

- [ ] **Step 3: Update the threshold import and the entry type**

In `scripts/decklists.ts`, delete the local threshold at line 28:

```ts
// A decklist must share at least this fraction of the seat's picks to be considered
// a match. Below this threshold the assignment is likely wrong (e.g. unsorted pool).
const SEAT_MATCH_SCORE_THRESHOLD = 0.5;
```

and add to the import block (after the `slugify` import at line 21):

```ts
import {
  scoreAgainstSeat,
  isEligibleSeat,
  formatPct,
  SEAT_MATCH_RECALL_THRESHOLD,
  SEAT_MATCH_PRECISION_THRESHOLD,
  type SeatScore,
} from "./lib/deckMatching";
```

Change `DecklistEntry` (lines 59-65):

```ts
interface DecklistEntry {
  sealeddeckId: string;
  url: string;
  deck: string[];
  sideboard: string[];
  /**
   * Exactly the cards this submission will store: deck + sideboard, minus
   * basics, normalized. Deliberately excludes sealeddeck's `hidden` zone —
   * matching against cards we never store is what misfiled three decklists.
   */
  storedCards: Set<string>;
}
```

- [ ] **Step 4: Replace `extractPool` with `extractStoredCards`**

Replace lines 110-125 of `scripts/decklists.ts`:

```ts
/**
 * The cards a submission will actually store: deck + sideboard, non-basics only.
 *
 * `hidden` is excluded on purpose. Some submitters pasted the entire remaining
 * cube into that zone; because it was included in matching but never written,
 * those lists overlapped every seat completely and evicted correct decks.
 */
export function extractStoredCards(response: SealedDeckResponse): Set<string> {
  const stored = new Set<string>();
  for (const card of [...response.deck, ...response.sideboard]) {
    const normalized = normalizeForMatch(card.name);
    if (!BASIC_LANDS.has(normalized)) {
      stored.add(normalized);
    }
  }
  return stored;
}
```

- [ ] **Step 5: Rewrite `matchDecksToSeats`**

Replace lines 143-183 of `scripts/decklists.ts`:

```ts
/** Report why a decklist matched no seat, at a severity that fits the cause. */
function reportSkip(
  decklist: DecklistEntry,
  best: { seat: number; score: SeatScore } | null,
): void {
  if (!best || best.score.overlap === 0) {
    // No overlap with any seat at all. This is an opted-out player's list:
    // their picks were never ingested, so there is nothing to match against.
    // Seven of these occur every run. Warning on expected behaviour trains
    // everyone to ignore the log, which is how 27 overwrite lines went unread.
    logIndent(
      `Skipping ${decklist.sealeddeckId} — no overlap with any seat (expected for an opted-out player)`,
    );
    return;
  }

  console.warn(
    `  WARNING: Skipping ${decklist.sealeddeckId} — best candidate seat ${best.seat} ` +
      `scored recall ${formatPct(best.score.recall)} (need ${formatPct(SEAT_MATCH_RECALL_THRESHOLD)}), ` +
      `precision ${formatPct(best.score.precision)} (need ${formatPct(SEAT_MATCH_PRECISION_THRESHOLD)}). ` +
      `Low precision means the list holds cards that seat never drafted.`,
  );
}

/**
 * Match decklists to seats by overlap with each seat's picks.
 *
 * A seat is eligible only if it clears both thresholds. Exactly one eligible
 * seat assigns the list. More than one cannot happen under rotisserie rules —
 * a card belongs to one player — so that case skips rather than guessing:
 * a tie means an assumption has broken, and picking a winner buries the evidence.
 */
export function matchDecksToSeats(
  decklists: DecklistEntry[],
  seatPicks: Map<number, Set<string>>,
): Map<number, DecklistEntry> {
  const assignments = new Map<number, DecklistEntry>();

  for (const decklist of decklists) {
    const eligible: Array<{ seat: number; score: SeatScore }> = [];
    let best: { seat: number; score: SeatScore } | null = null;

    for (const [seat, picks] of seatPicks) {
      const score = scoreAgainstSeat(decklist.storedCards, picks);
      if (!best || score.overlap > best.score.overlap) {
        best = { seat, score };
      }
      if (isEligibleSeat(score)) {
        eligible.push({ seat, score });
      }
    }

    if (eligible.length === 0) {
      reportSkip(decklist, best);
      continue;
    }

    if (eligible.length > 1) {
      console.warn(
        `  WARNING: Skipping ${decklist.sealeddeckId} — ${eligible.length} seats are eligible ` +
          `(${eligible.map((e) => `seat ${e.seat} at ${formatPct(e.score.precision)} precision`).join(", ")}). ` +
          `Rotisserie gives every card one owner, so this means an assumption has broken.`,
      );
      continue;
    }

    const { seat, score } = eligible[0];

    // A genuine resubmission for the same seat should win. This overwrite was
    // never the defect — it was the symptom of matching on the wrong card set.
    const previous = assignments.get(seat);
    if (previous) {
      logIndent(
        `Seat ${seat}: ${previous.sealeddeckId} replaced by ${decklist.sealeddeckId} (later submission)`,
      );
    }

    logIndent(
      `Seat ${seat}: ${decklist.sealeddeckId} — recall ${formatPct(score.recall)}, precision ${formatPct(score.precision)}`,
    );
    assignments.set(seat, decklist);
  }

  return assignments;
}
```

- [ ] **Step 6: Update the call site**

In `fetchAllDecklists` (around line 243), replace `const pool = extractPool(response);` and the object literal:

```ts
      const storedCards = extractStoredCards(response);

      decklists.push({
        sealeddeckId: id,
        url: `https://sealeddeck.tech/${id}`,
        deck: extractZoneCards(response.deck),
        sideboard: extractZoneCards(response.sideboard),
        storedCards,
      });
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run scripts/decklists.test.ts && npx tsc --noEmit
```

Expected: PASS — 8 tests, and no type errors.

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/decklists.ts scripts/decklists.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Match decklists on what we store, not on a pool we discard

Including sealeddeck's hidden zone let full-cube pastes overlap every
seat completely and evict correct decks. Matching on deck+sideboard with
a precision floor also repairs them: those submissions' stored cards
were clean and point at their true owner.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2B: Stop the module from running itself, and make the regression test show the bug

Added after Task 2's review. Two findings, both in the files Task 2 touched, neither caused by it.

**Files:**
- Modify: `scripts/decklists.ts` (the `main()` invocation at the end of the file)
- Modify: `scripts/decklists.test.ts` (the full-cube regression test)

**Interfaces:**
- Consumes: Task 2's `extractStoredCards`, `matchDecksToSeats`, `DecklistEntry.storedCards`.
- Produces: no new exports.

**Finding 1 — `main()` runs on import.** `scripts/decklists.ts` ends with a bare `main().catch(...)`, so importing the module executes it. `scripts/decklists.test.ts` imports the module, and `loadEnv()` reads `.env.local`, so live Turso credentials are present during a test run. Test stdout confirms the chain starts — it logs `Found 22 drafts in decklists.txt`, which is emitted after `loadEnv`, the file read, and the parse. The chain continues into sealeddeck fetches and ends in `DELETE FROM deck_cards`, `batchInsertDeckCards`, and `INSERT OR REPLACE INTO deck_hashes`. Only the vitest worker exiting first prevents a production write, and a full suite run gives it far more wall-clock than a single-file run. A plan whose purpose is that decklist data stops being silently overwritten cannot ship a test suite that can silently overwrite decklist data.

**Finding 2 — the regression test doesn't construct the bug.** The full-cube test asserts the right outcome (assignment to the true owner) but its fixture has no `hidden` zone, so it is the passing test above it plus one assertion. Its RED against the old code was `TypeError: decklist.pool is not iterable` — a fixture-shape mismatch, not a behavioral failure. Nothing in the suite feeds a full-cube response through `extractStoredCards` into `matchDecksToSeats`.

- [ ] **Step 1: Rewrite the regression test so it fails behaviorally**

In `scripts/decklists.test.ts`, replace the `assigns a full-cube submission to its true owner` test with:

```ts
  it("assigns a full-cube submission to its true owner", () => {
    // Regression for the corruption bug. This submitter pasted the entire
    // remaining cube into sealeddeck's `hidden` zone. Building the entry through
    // extractStoredCards is the point: under the old code `hidden` leaked into
    // the matching set, the list overlapped seat 1 completely as well, and seat 1
    // was assigned a deck belonging to seat 2.
    const storedCards = extractStoredCards({
      poolId: "x",
      deck: [
        { name: "Counterspell", count: 1 },
        { name: "Ponder", count: 1 },
        { name: "Preordain", count: 1 },
        { name: "Opt", count: 1 },
      ],
      sideboard: [],
      hidden: [
        // the whole cube — every card both seats drafted
        { name: "Bolt", count: 1 },
        { name: "Swords", count: 1 },
        { name: "Ragavan", count: 1 },
        { name: "Brainstorm", count: 1 },
        { name: "Counterspell", count: 1 },
        { name: "Ponder", count: 1 },
        { name: "Preordain", count: 1 },
        { name: "Opt", count: 1 },
      ],
    });

    const result = matchDecksToSeats(
      [{ ...entry("LZYpr4rjmH", []), storedCards }],
      seatPicks,
    );

    // The deck must land on its true owner, not merely fail to corrupt seat 1.
    // Asserting only the absence of corruption would also pass under a fix that
    // discards the submission entirely, which would leave seat 2 with no deck.
    expect(result.get(2)?.sealeddeckId).toBe("LZYpr4rjmH");
    expect(result.has(1)).toBe(false);
  });
```

The seat picks in this file are lowercase short names (`bolt`, `swords`, `ragavan`, `brainstorm`, `counterspell`, `ponder`, `preordain`, `opt`), and `extractStoredCards` lowercases via `normalizeForMatch`, so the capitalized fixture names normalize onto them.

- [ ] **Step 2: Verify the test fails for the right reason**

Temporarily re-add `hidden` to `extractStoredCards` (`...(response.hidden || [])` in the spread) and run:

```bash
npx vitest run scripts/decklists.test.ts -t "full-cube"
```

Expected: FAIL — and read the failure. It must be a *behavioral* failure showing the list matched seat 1 as well as seat 2 (with the new gates, two eligible seats, so nothing is assigned and `result.get(2)` is `undefined`). It must NOT be a TypeError. Then revert the temporary change.

This step is the whole point of the task — if the failure is a type error again, the fixture is still wrong.

- [ ] **Step 3: Verify it passes with `hidden` excluded**

```bash
npx vitest run scripts/decklists.test.ts
```

Expected: PASS — 8 tests.

- [ ] **Step 4: Guard the module-scope `main()`**

At the end of `scripts/decklists.ts`, replace:

```ts
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

with:

```ts
// Only run when invoked as a script. Importing this module — which the tests do,
// for the pure matching functions — must never start a fetch-and-write against
// production. `loadEnv` picks up real Turso credentials, so the guard is what
// stands between `pnpm test` and a write to deck_cards.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
```

`fileURLToPath` is already imported. Add `realpathSync` to the existing `fs` import alongside `readFileSync, existsSync`.

`realpathSync` matters because `tsx` may resolve the script through a symlink; comparing raw paths would silently disable the CLI.

- [ ] **Step 5: Verify the guard works in both directions**

The module must stay silent on import, and still run as a CLI:

```bash
npx vitest run scripts/decklists.test.ts 2>&1 | grep -c "drafts in decklists.txt"
```

Expected: `0` — no ingest logging during tests. Before this change it printed the line.

```bash
pnpm decklists --dry-run 2>&1 | head -5
```

Expected: it still starts up and reports `Found 22 drafts in decklists.txt`. (This requires Task 4's `--dry-run`; if Task 4 has not landed yet, run `pnpm decklists nonexistent-draft-label` instead, which is read-only — it will report `Draft not found in Turso` and write nothing.)

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit && pnpm lint && pnpm knip && npx vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/decklists.ts scripts/decklists.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Keep importing the decklist script from running it

The test file imports this module for its matching functions, and a bare
main() call meant importing it could fetch and write production decks —
the exact silent overwrite this branch exists to stop. The regression
test now builds its fixture through extractStoredCards, so it fails on
the old code's behavior rather than on a fixture shape mismatch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2C: Stop linting gitignored scratch files

Added during Task 2B. `pnpm lint` fails, which blocks `pnpm precommit` **and the husky pre-push hook** — so no work on this branch can be pushed until it is fixed.

**Files:**
- Modify: `eslint.config.mjs`

**Interfaces:** none.

**The problem.** `pnpm lint` runs `eslint . --max-warnings 0` and reports 16 `no-console` warnings from `data/decklist-recovery/scripts/*.mjs`:

```
✖ 16 problems (0 errors, 16 warnings)
ESLint found too many warnings (maximum: 0).
```

Those files are gitignored investigation scratch (`.gitignore:22` ignores `data/`), and they must stay — Task 11 runs `data/decklist-recovery/scripts/verify-decks.mjs`. Two config gaps combine to produce this: `globalIgnores` (`eslint.config.mjs:11-21`) never lists `data/**`, and the `no-console: off` override (`:35-40`) covers only `src/core/**/*.ts`, `src/build/**/*.ts` and `scripts/**/*.ts` — not `.mjs` files under `data/`.

The fix is to stop linting gitignored content, which is correct on principle rather than a workaround: `data/` holds draft CSVs, decklist URLs, screenshots and scratch scripts, none of which are part of the codebase.

- [ ] **Step 1: Confirm the failure and its source**

```bash
pnpm lint 2>&1 | tail -5
```

Expected: `✖ 16 problems (0 errors, 16 warnings)` and a non-zero exit, every file path under `data/decklist-recovery/scripts/`.

- [ ] **Step 2: Ignore the data directory**

In `eslint.config.mjs`, add to the `globalIgnores` array (after the `.claude/worktrees/**` entry):

```js
    // Gitignored working data: draft CSVs, decklist URLs, screenshots, and
    // investigation scratch scripts. Not part of the codebase, and linting it
    // fails the build over console statements in throwaway tooling.
    "data/**",
```

- [ ] **Step 3: Verify lint passes and still covers real code**

```bash
pnpm lint && echo "LINT_OK"
```

Expected: `LINT_OK`.

Then confirm the ignore did not silence real source. Introduce a deliberate error, check it is still caught, and revert it:

```bash
printf '\nconst unusedOnPurpose = 1;\n' >> scripts/decklists.ts
pnpm lint 2>&1 | grep -c "unusedOnPurpose"
git -C /Users/arpanet/code/read-the-bones checkout scripts/decklists.ts
```

Expected: a non-zero count on the middle command — `scripts/` is still linted — and a clean tree afterward. Verify with `git -C /Users/arpanet/code/read-the-bones status --short` that `scripts/decklists.ts` is not modified before you commit.

- [ ] **Step 4: Verify the full gate**

```bash
npx tsc --noEmit && pnpm lint && pnpm knip && npx vitest run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add eslint.config.mjs
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Stop linting the gitignored data directory

Investigation scratch scripts under data/ tripped no-console and, with
--max-warnings 0, failed lint for the whole repo — blocking precommit
and the pre-push hook over files that will never be committed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Provenance column and the recovered-deck guard

`deck_hashes` is already the per-seat provenance table keyed `(draft_id, seat)`; it just never recorded *where* the deck came from. Recording it is what lets `data/decklists.txt` become an inbox (Task 12) without destroying the only record of which submission produced which deck.

**Files:**
- Modify: `src/core/db/schema.sql` (append), `src/core/db/__tests__/testDb.ts:135-141`, `scripts/decklists.ts:381-451` (writer loop)

**Interfaces:**
- Consumes: Task 2's `DecklistEntry.storedCards`.
- Produces: `deck_hashes.sealeddeck_id TEXT` — the sealeddeck id for fetched decks, `recovered:<filename>` for decks imported by Task 6.

- [ ] **Step 1: Add the column to the production schema**

Append to `src/core/db/schema.sql`:

```sql
-- sealeddeck_id on deck_hashes: which submission produced this seat's deck.
-- 'recovered:<filename>' marks a deck imported from a hand-parsed screenshot;
-- the fetcher refuses to overwrite those without --force.
ALTER TABLE deck_hashes ADD COLUMN sealeddeck_id TEXT;
```

`migrate.ts:97-104` already skips duplicate-column errors, so this is idempotent.

- [ ] **Step 2: Add the column to the test schema**

In `src/core/db/__tests__/testDb.ts`, change the `deck_hashes` table (lines 135-141):

```ts
  await client.execute(`
    CREATE TABLE IF NOT EXISTS deck_hashes (
      draft_id TEXT NOT NULL,
      seat INTEGER NOT NULL,
      hash TEXT NOT NULL,
      sealeddeck_id TEXT,
      PRIMARY KEY (draft_id, seat)
    )
  `);
```

- [ ] **Step 3: Add `--force` parsing in `main`**

In `scripts/decklists.ts`, replace the argv line in `main()` (line 333):

```ts
  // Skip flags so `pnpm decklists --dry-run` still works without a draft label.
  const filterDraft = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const force = process.argv.includes("--force");
```

- [ ] **Step 4: Rewrite the hash check and the guard**

In the writer loop, replace the "Check stored hash" block (lines 392-400):

```ts
      // Existing state for this seat, including where its deck came from.
      const existingRow = await client.execute({
        sql: "SELECT hash, sealeddeck_id FROM deck_hashes WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
      const existing = existingRow.rows[0];
      const existingSource = existing ? (existing.sealeddeck_id as string | null) : null;

      // A hand-recovered deck outranks anything fetched. Recovery is expensive
      // and often the only copy that exists; silently reverting one would undo
      // work that cannot be redone from this file.
      if (existingSource?.startsWith("recovered:") && !force) {
        logIndent(
          `Seat ${seat}: skipped — hand-recovered deck (${existingSource}). Pass --force to overwrite.`,
        );
        continue;
      }

      // Skip only when the deck AND its recorded provenance are both current.
      // Without the second half, every unchanged seat would keep a null
      // sealeddeck_id forever and Task 12's prune would have nothing to query.
      if (existing && existing.hash === hash && existingSource === entry.sealeddeckId) {
        logIndent(`Seat ${seat}: unchanged`);
        continue;
      }
```

Then update the two later references to `storedHash`:

- The status line (line 447) becomes `const status = existing ? "updated" : "new";`
- The hash write (lines 442-445) becomes:

```ts
      await client.execute({
        sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash, sealeddeck_id) VALUES (?, ?, ?, ?)",
        args: [draftId, seat, hash, entry.sealeddeckId],
      });
```

- [ ] **Step 5: Verify types and tests**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/schema.sql src/core/db/__tests__/testDb.ts scripts/decklists.ts
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Record which submission produced each seat's deck

Provenance existed only in a gitignored text file, so pruning that file
would have destroyed it permanently. Storing it alongside the hash also
lets hand-recovered decks refuse to be overwritten by a later fetch.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `--dry-run` for `pnpm decklists`

Task 8 rewrites production with no staging environment and no undo. It has to be readable before it is applied.

**Files:**
- Modify: `scripts/decklists.ts` (`main`, writer loop)
- Modify: `CLAUDE.md` (Decklists command block)

**Interfaces:**
- Consumes: Task 3's `force` flag parsing.
- Produces: `pnpm decklists [draft-label] [--dry-run] [--force]`.

- [ ] **Step 1: Parse the flag and announce the mode**

In `main()`, after the `force` line from Task 3:

```ts
  const dryRun = process.argv.includes("--dry-run");
```

and immediately after `log(\`Found ${drafts.size} drafts in decklists.txt\`)`:

```ts
  if (dryRun) {
    log("DRY RUN — fetching and matching only, nothing will be written");
  }
```

- [ ] **Step 2: Move the destructive delete below the guard that rejects bad decks**

The writer loop currently runs `DELETE FROM deck_cards` *before* resolving cards and *before* the `maindeckQty < 20` guard. A resubmission with fewer than 20 maindeck cards therefore wipes that seat's previously-good deck and then declines to write a replacement — silent decklist destruction, which is the exact failure this branch exists to stop. The precision gate from Task 2 lets more submissions reach this path, so the exposure grew.

**This step also closes an Important finding from Task 3's review**, which reached the same defect from a different direction: once `--force` passes the recovered-deck guard, the delete runs before the incoming deck is validated, so a marginal submission leaves a hand-recovered seat with no cards, no hash, and no provenance — and that transcription may be the only copy in existence. `--force` is a global flag with no per-seat targeting, so the realistic trigger is an operator refreshing a whole draft, not one intending to clobber that seat. Reordering here fixes it for every seat rather than special-casing recovered ones. **The review of this task must confirm the finding is closed.**

Reorder the loop body so nothing is destroyed until a good deck is ready to replace it. **Delete** the existing block:

```ts
      // Delete old deck cards for this seat before reinserting
      await client.execute({
        sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
```

from its current position above `const qtyMap = ...`, and re-insert it lower down, immediately before `await batchInsertDeckCards(client, deckCards);`:

```ts
      // Replace this seat's deck only once a valid one is ready to take its place.
      // Deleting earlier meant a malformed resubmission destroyed a good deck and
      // then declined to write anything.
      await client.execute({
        sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
        args: [draftId, seat],
      });
```

- [ ] **Step 3: Short-circuit every write**

With the delete moved, one `continue` short-circuits the whole write section. Immediately after the closing brace of the `if (maindeckQty < 20) { ... }` guard and before the relocated `DELETE`, insert:

```ts
      if (dryRun) {
        const status = existing ? "would update" : "would create";
        logIndent(
          `Seat ${seat}: ${status} — ${deckCards.length} cards from ${entry.sealeddeckId}` +
            `${warnings > 0 ? ` [${warnings} unresolved names]` : ""}`,
        );
        continue;
      }
```

The only write now above that line is the `DELETE FROM deck_hashes` inside the `maindeckQty < 20` branch, which still needs its own guard:

```ts
        if (!dryRun) {
          await client.execute({
            sql: "DELETE FROM deck_hashes WHERE draft_id = ? AND seat = ?",
            args: [draftId, seat],
          });
        }
```

Clearing the hash while leaving `deck_cards` intact is deliberate: the seat keeps its good deck, and the cleared hash makes the next run re-evaluate the submission rather than short-circuit on a stale match. Re-running is idempotent — it resolves, hits the guard again, and skips again.

- [ ] **Step 4: Print the closing hint**

Replace `log("Done!")` at line 454:

```ts
  log(dryRun ? "Dry run complete — re-run without --dry-run to apply." : "Done!");
```

- [ ] **Step 5: Verify no write path is reachable under `--dry-run`**

```bash
grep -n "client.execute\|batchInsert" scripts/decklists.ts
```

Expected: every `INSERT`, `DELETE` or `batchInsertDeckCards` call inside the writer loop is either inside an `if (!dryRun)` block or after the `if (dryRun) { ... continue; }` short-circuit. `SELECT`s are fine. Read each hit and confirm — this is the check that makes Task 8 safe to run.

`resolveZoneCards` calls `resolveCardNameToId` (`src/core/db/sync/incremental.ts:185-215`), which runs four `SELECT`s and nothing else — verified during planning. It is safe to leave outside the guard, and leaving it there is what makes the dry run report unresolved card names.

- [ ] **Step 6: Verify types and tests**

```bash
npx tsc --noEmit && npx vitest run && pnpm lint
```

Expected: PASS.

- [ ] **Step 7: Document the flags in CLAUDE.md**

In the `# Decklists` block of `CLAUDE.md`, replace the two existing lines with:

```
pnpm decklists                 # Fetch decklists from sealeddeck.tech and write to Turso
pnpm decklists tarkir          # Fetch decklists for a specific draft
pnpm decklists --dry-run       # Report what would be written, change nothing
pnpm decklists --force         # Also overwrite hand-recovered decks (see decklists:import)
```

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/decklists.ts CLAUDE.md
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Let the decklist fetcher report what it would write

Local and production are one database, so a full run is unreviewable and
irreversible. Reading the assignments first is the only way to catch a
bad match before it lands.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Integrity command

The check that would have caught the original defect within a day of it landing. It currently lives in gitignored `data/`, which is why nobody ran it.

**Files:**
- Create: `scripts/decklists-integrity.ts`
- Modify: `package.json` (scripts), `CLAUDE.md`

**Interfaces:**
- Consumes: `SEAT_MATCH_PRECISION_THRESHOLD`, `formatPct` from Task 1.
- Produces: `pnpm decklists:integrity [--write-report]`. Exit code 1 if any stored deck is suspect.

**Reason classification.** The tool derives what the database knows and no more:
`opted-out` (row in `privacy_opt_outs`), `draft-never-collected` (no seat in that draft
has a deck), `missing` (other seats in the draft do). Narrative reasons — awaiting image,
awaiting URL, corrupt-and-deleted — are human annotations added to `docs/decklist-status.md`
in Task 12. Deriving them would mean inventing state the database does not have.

- [ ] **Step 1: Write the script**

Create `scripts/decklists-integrity.ts`:

```ts
/**
 * Audit every stored decklist against its seat's picks, and list every seat
 * that has no decklist at all.
 *
 * Rotisserie gives each card exactly one owner, so a correctly assigned deck
 * scores ~100% precision against its seat's picks. Anything lower is a
 * mis-assignment. This is the check that would have caught the hidden-zone
 * matching defect the day it landed.
 *
 * Usage:
 *   pnpm decklists:integrity
 *   pnpm decklists:integrity --write-report   # refresh docs/decklist-status.md
 */

import { createClient } from "@libsql/client";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log } from "../src/core/db/ingest/utils";
import { normalizeCardName } from "../src/core/parseSheetRows";
import { SEAT_MATCH_PRECISION_THRESHOLD, formatPct } from "./lib/deckMatching";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_FILE = join(__dirname, "..", "docs", "decklist-status.md");

const norm = (name: string) => normalizeCardName(name).toLowerCase();
const key = (draftId: string, seat: number) => `${draftId}:${seat}`;

interface Suspect {
  draftId: string;
  seat: number;
  precision: number;
  stored: number;
  notPicked: number;
}

type AbsenceReason = "opted-out" | "draft-never-collected" | "missing";

interface Absent {
  draftId: string;
  seat: number;
  reason: AbsenceReason;
}

async function main() {
  loadEnv();

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const writeReport = process.argv.includes("--write-report");

  // ---- load ----------------------------------------------------------------

  const picksBySeat = new Map<string, Set<string>>();
  const picksResult = await client.execute(
    `SELECT pe.draft_id, pe.seat, c.name
     FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id`,
  );
  for (const row of picksResult.rows) {
    const k = key(row.draft_id as string, row.seat as number);
    if (!picksBySeat.has(k)) picksBySeat.set(k, new Set());
    picksBySeat.get(k)!.add(norm(row.name as string));
  }

  const deckBySeat = new Map<string, Set<string>>();
  const decksResult = await client.execute(
    `SELECT dc.draft_id, dc.seat, c.name
     FROM deck_cards dc JOIN cards c ON c.card_id = dc.card_id`,
  );
  for (const row of decksResult.rows) {
    const k = key(row.draft_id as string, row.seat as number);
    if (!deckBySeat.has(k)) deckBySeat.set(k, new Set());
    deckBySeat.get(k)!.add(norm(row.name as string));
  }

  const optedOut = new Set<string>();
  const optOutResult = await client.execute(`SELECT draft_id, seat FROM privacy_opt_outs`);
  for (const row of optOutResult.rows) {
    optedOut.add(key(row.draft_id as string, row.seat as number));
  }

  // Seats that demonstrably drafted: a seat with no picks never played.
  const seatsThatDrafted = [...picksBySeat.keys()];
  const draftsWithAnyDeck = new Set([...deckBySeat.keys()].map((k) => k.split(":")[0]));

  // ---- suspect stored decks ------------------------------------------------

  const suspects: Suspect[] = [];
  for (const [k, cards] of deckBySeat) {
    const [draftId, seatStr] = k.split(":");
    const seat = Number(seatStr);
    const picks = picksBySeat.get(k);

    if (!picks) {
      suspects.push({ draftId, seat, precision: 0, stored: cards.size, notPicked: cards.size });
      continue;
    }

    const overlap = [...cards].filter((c) => picks.has(c)).length;
    const precision = cards.size > 0 ? overlap / cards.size : 0;
    if (precision < SEAT_MATCH_PRECISION_THRESHOLD) {
      suspects.push({
        draftId,
        seat,
        precision,
        stored: cards.size,
        notPicked: cards.size - overlap,
      });
    }
  }
  suspects.sort((a, b) => a.precision - b.precision || a.draftId.localeCompare(b.draftId));

  // ---- absent decks --------------------------------------------------------

  const absent: Absent[] = [];
  for (const k of seatsThatDrafted) {
    if (deckBySeat.has(k)) continue;
    const [draftId, seatStr] = k.split(":");
    const seat = Number(seatStr);

    const reason: AbsenceReason = optedOut.has(k)
      ? "opted-out"
      : draftsWithAnyDeck.has(draftId)
        ? "missing"
        : "draft-never-collected";

    absent.push({ draftId, seat, reason });
  }
  absent.sort((a, b) => a.draftId.localeCompare(b.draftId) || a.seat - b.seat);

  // ---- report --------------------------------------------------------------

  const needsAttention = absent.filter((a) => a.reason === "missing");

  log(`stored decklists: ${deckBySeat.size}`);
  log(`suspect (precision < ${formatPct(SEAT_MATCH_PRECISION_THRESHOLD)}): ${suspects.length}`);
  for (const s of suspects) {
    console.log(
      `  ${`${s.draftId}:${s.seat}`.padEnd(34)} ${formatPct(s.precision).padStart(6)}  ` +
        `${s.notPicked} of ${s.stored} cards not picked by this seat`,
    );
  }

  log(`seats that drafted but have no decklist: ${absent.length}`);
  for (const reason of ["missing", "draft-never-collected", "opted-out"] as const) {
    const group = absent.filter((a) => a.reason === reason);
    if (group.length === 0) continue;
    console.log(`  ${reason} (${group.length}): ${group.map((a) => `${a.draftId}:${a.seat}`).join(", ")}`);
  }

  if (writeReport) {
    writeFileSync(REPORT_FILE, renderReport(suspects, absent, deckBySeat.size));
    log(`wrote ${REPORT_FILE}`);
  }

  client.close();

  if (suspects.length > 0) {
    console.error(
      `\n${suspects.length} suspect decklist(s). These seats are attributed cards they never drafted.`,
    );
    process.exit(1);
  }
  if (needsAttention.length > 0) {
    log(`${needsAttention.length} seat(s) await manual remediation — see docs/decklist-status.md`);
  }
}

function renderReport(suspects: Suspect[], absent: Absent[], storedCount: number): string {
  const lines: string[] = [];
  lines.push("# Decklist Status");
  lines.push("");
  lines.push("Generated by `pnpm decklists:integrity --write-report`.");
  lines.push("");
  lines.push(
    "The derived columns come from the database. Narrative notes are added by hand — " +
      "the database cannot know whether a missing deck is awaiting a screenshot or a URL.",
  );
  lines.push("");
  lines.push(`**Stored decklists:** ${storedCount}`);
  lines.push(`**Suspect:** ${suspects.length}`);
  lines.push("");

  lines.push("## Suspect stored decklists");
  lines.push("");
  if (suspects.length === 0) {
    lines.push("None. Every stored decklist is made of cards its seat actually drafted.");
  } else {
    lines.push("| Draft | Seat | Precision | Detail |");
    lines.push("|---|---|---|---|");
    for (const s of suspects) {
      lines.push(
        `| ${s.draftId} | ${s.seat} | ${formatPct(s.precision)} | ${s.notPicked} of ${s.stored} cards not picked by this seat |`,
      );
    }
  }
  lines.push("");

  lines.push("## Seats with no decklist");
  lines.push("");
  lines.push("| Draft | Seat | Reason | Note |");
  lines.push("|---|---|---|---|");
  for (const a of absent) {
    lines.push(`| ${a.draftId} | ${a.seat} | ${a.reason} | |`);
  }
  lines.push("");
  lines.push("**Reasons:** `opted-out` — by design, will never have a deck. ");
  lines.push("`draft-never-collected` — no seat in that draft has a decklist. ");
  lines.push("`missing` — other seats in this draft have decks; this one needs remediation.");
  lines.push("");

  return lines.join("\n");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
```

- [ ] **Step 2: Register the command**

In `package.json`, add after the `"decklists"` entry:

```json
    "decklists:integrity": "tsx scripts/decklists-integrity.ts",
```

- [ ] **Step 3: Verify it runs against the live database**

```bash
pnpm decklists:integrity
```

Expected, before any repair: `stored decklists: 193`, `suspect: 3` listing `baleful-strix:1`, `tarmogoyf:2`, `terminate:3` at 0.0%, exit code 1. Confirm the exit code with `echo $?`.

This is read-only. If the numbers differ from the handoff, stop and investigate before proceeding — something changed since the investigation.

- [ ] **Step 4: Verify quality gates**

```bash
npx tsc --noEmit && pnpm lint && pnpm knip
```

Expected: PASS. `scripts/*.ts` is a knip entry point, so the new script needs no config change.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/decklists-integrity.ts package.json
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Make decklist mis-assignment self-reporting

This check found the corruption, but it lived in a gitignored scratch
directory, which is why three misfiled decks sat undetected. As a real
command it can run whenever the data changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Recovered-deck importer

**Files:**
- Create: `scripts/import-recovered-decks.ts`, `scripts/import-recovered-decks.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `batchInsertDeckCards`, `DeckCardInsert` from `src/core/db/sync/batch`; `normalizeCardName` from `src/core/parseSheetRows`.
- Produces:
  - `pnpm decklists:import [--dry-run]`
  - `resolveDeckFromPicks(client, parsed): Promise<DeckCardInsert[]>` — exported for test. Throws on any card absent from the seat's picks.
  - `interface ParsedDeck { draftId: string; seat: number; maindeckNonBasics: string[]; sideboard: string[] }`

**The load-bearing decision:** card ids resolve from *that seat's own `pick_events`*, never a global name lookup. A card the seat never drafted becomes unresolvable by construction, so a bad vision transcription fails loudly instead of writing something plausible. This also makes it impossible to write a deck for an opted-out seat, whose picks were never ingested.

- [ ] **Step 1: Write the failing test**

Create `scripts/import-recovered-decks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMemDb, insertCard, insertDraft, insertPickEvent } from "../src/core/db/__tests__/testDb";
import { resolveDeckFromPicks } from "./import-recovered-decks";

async function seedSeat() {
  const client = await createMemDb();
  await insertDraft(client, "baleful-strix");
  await insertCard(client, 1, "Lightning Bolt");
  await insertCard(client, 2, "Brainstorm");
  await insertCard(client, 3, "Counterspell");
  await insertPickEvent(client, "baleful-strix", 1, 3, 1);
  await insertPickEvent(client, "baleful-strix", 2, 3, 2);
  await insertPickEvent(client, "baleful-strix", 3, 3, 3);
  return client;
}

describe("resolveDeckFromPicks", () => {
  it("resolves each card to the id the seat actually drafted", async () => {
    const client = await seedSeat();
    const rows = await resolveDeckFromPicks(client, {
      draftId: "baleful-strix",
      seat: 3,
      maindeckNonBasics: ["Lightning Bolt", "Brainstorm"],
      sideboard: ["Counterspell"],
    });

    expect(rows).toEqual([
      { draftId: "baleful-strix", seat: 3, cardId: 1, zone: "deck", qty: 1 },
      { draftId: "baleful-strix", seat: 3, cardId: 2, zone: "deck", qty: 1 },
      { draftId: "baleful-strix", seat: 3, cardId: 3, zone: "sideboard", qty: 1 },
    ]);
    client.close();
  });

  it("aggregates duplicate copies into qty", async () => {
    const client = await seedSeat();
    const rows = await resolveDeckFromPicks(client, {
      draftId: "baleful-strix",
      seat: 3,
      maindeckNonBasics: ["Lightning Bolt", "Lightning Bolt"],
      sideboard: [],
    });

    expect(rows).toEqual([
      { draftId: "baleful-strix", seat: 3, cardId: 1, zone: "deck", qty: 2 },
    ]);
    client.close();
  });

  it("rejects a card the seat never drafted", async () => {
    // A vision transcription error must fail loudly, not write a plausible deck.
    const client = await seedSeat();
    await expect(
      resolveDeckFromPicks(client, {
        draftId: "baleful-strix",
        seat: 3,
        maindeckNonBasics: ["Lightning Bolt", "Black Lotus"],
        sideboard: [],
      }),
    ).rejects.toThrow(/Black Lotus/);
    client.close();
  });

  it("rejects every card for a seat with no picks", async () => {
    // An opted-out seat's picks are never ingested, so it is impossible to
    // write a deck for one. That is the privacy guarantee, enforced by construction.
    const client = await seedSeat();
    await expect(
      resolveDeckFromPicks(client, {
        draftId: "baleful-strix",
        seat: 9,
        maindeckNonBasics: ["Lightning Bolt"],
        sideboard: [],
      }),
    ).rejects.toThrow(/no picks/i);
    client.close();
  });

  it("normalizes numeric suffixes the way pick data does", async () => {
    const client = await createMemDb();
    await insertDraft(client, "tarkir");
    await insertCard(client, 10, "Scalding Tarn");
    await insertPickEvent(client, "tarkir", 1, 4, 10);

    const rows = await resolveDeckFromPicks(client, {
      draftId: "tarkir",
      seat: 4,
      maindeckNonBasics: ["Scalding Tarn 2"],
      sideboard: [],
    });
    expect(rows[0].cardId).toBe(10);
    client.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run scripts/import-recovered-decks.test.ts
```

Expected: FAIL — `Failed to resolve import "./import-recovered-decks"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/import-recovered-decks.ts`:

```ts
/**
 * Import hand-recovered decklists from docs/decklist-recovery-parsed/*.json.
 *
 * These decks were transcribed from screenshots of the deck-building UI for
 * seats whose sealeddeck submission is missing or unrecoverable. Card ids are
 * resolved from that seat's own pick_events rather than a global name lookup,
 * so a card the seat never drafted is unresolvable by construction — a bad
 * transcription fails loudly instead of writing something plausible.
 *
 * Usage:
 *   pnpm decklists:import --dry-run
 *   pnpm decklists:import
 */

import { createClient, type Client } from "@libsql/client";
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { loadEnv, log, logIndent } from "../src/core/db/ingest/utils";
import { batchInsertDeckCards, type DeckCardInsert } from "../src/core/db/sync/batch";
import { normalizeCardName } from "../src/core/parseSheetRows";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSED_DIR = join(__dirname, "..", "docs", "decklist-recovery-parsed");

export interface ParsedDeck {
  draftId: string;
  seat: number;
  maindeckNonBasics: string[];
  sideboard: string[];
}

const norm = (name: string) => normalizeCardName(name).toLowerCase();

/**
 * Resolve a parsed deck into deck_cards rows using only cards this seat drafted.
 *
 * @throws if the seat has no picks, or if any named card is not among them.
 */
export async function resolveDeckFromPicks(
  client: Client,
  parsed: ParsedDeck,
): Promise<DeckCardInsert[]> {
  const result = await client.execute({
    sql: `SELECT DISTINCT c.card_id, c.name
          FROM pick_events pe JOIN cards c ON c.card_id = pe.card_id
          WHERE pe.draft_id = ? AND pe.seat = ?`,
    args: [parsed.draftId, parsed.seat],
  });

  if (result.rows.length === 0) {
    throw new Error(
      `${parsed.draftId} seat ${parsed.seat} has no picks — cannot import a deck for a seat that never drafted (or opted out)`,
    );
  }

  const idByName = new Map<string, number>();
  for (const row of result.rows) {
    idByName.set(norm(row.name as string), row.card_id as number);
  }

  const qtyByKey = new Map<string, DeckCardInsert>();
  const unresolved: string[] = [];

  const zones: Array<{ names: string[]; zone: "deck" | "sideboard" }> = [
    { names: parsed.maindeckNonBasics, zone: "deck" },
    { names: parsed.sideboard, zone: "sideboard" },
  ];

  for (const { names, zone } of zones) {
    for (const name of names) {
      const cardId = idByName.get(norm(name));
      if (cardId === undefined) {
        unresolved.push(name);
        continue;
      }
      const key = `${cardId}:${zone}`;
      const existing = qtyByKey.get(key);
      if (existing) {
        existing.qty++;
      } else {
        qtyByKey.set(key, { draftId: parsed.draftId, seat: parsed.seat, cardId, zone, qty: 1 });
      }
    }
  }

  if (unresolved.length > 0) {
    throw new Error(
      `${parsed.draftId} seat ${parsed.seat}: ${unresolved.length} card(s) not among this seat's picks: ${unresolved.join(", ")}`,
    );
  }

  return [...qtyByKey.values()];
}

function readParsedDecks(): Array<{ file: string; deck: ParsedDeck }> {
  return readdirSync(PARSED_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      deck: JSON.parse(readFileSync(join(PARSED_DIR, file), "utf-8")) as ParsedDeck,
    }));
}

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");

  const client = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  const parsed = readParsedDecks();
  log(`Found ${parsed.length} parsed decklist(s) in docs/decklist-recovery-parsed`);
  if (dryRun) log("DRY RUN — resolving only, nothing will be written");

  // Resolve everything before writing anything. A transcription error in one
  // file should not leave the database half-updated.
  const resolved: Array<{ file: string; deck: ParsedDeck; rows: DeckCardInsert[] }> = [];
  const failures: string[] = [];

  for (const { file, deck } of parsed) {
    try {
      const rows = await resolveDeckFromPicks(client, deck);
      resolved.push({ file, deck, rows });
      const maindeck = rows.filter((r) => r.zone === "deck").reduce((n, r) => n + r.qty, 0);
      const sideboard = rows.filter((r) => r.zone === "sideboard").reduce((n, r) => n + r.qty, 0);
      logIndent(`${file}: ${deck.draftId} seat ${deck.seat} — ${maindeck} maindeck, ${sideboard} sideboard`);
    } catch (error) {
      failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} file(s) failed to resolve. Nothing was written.\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    client.close();
    process.exit(1);
  }

  if (dryRun) {
    log(`Dry run complete — ${resolved.length} deck(s) would be imported. Re-run without --dry-run to apply.`);
    client.close();
    return;
  }

  for (const { file, deck, rows } of resolved) {
    const source = `recovered:${basename(file)}`;
    const hash = createHash("sha256")
      .update(JSON.stringify({ maindeck: deck.maindeckNonBasics, sideboard: deck.sideboard }))
      .digest("hex")
      .slice(0, 16);

    await client.execute({
      sql: "DELETE FROM deck_cards WHERE draft_id = ? AND seat = ?",
      args: [deck.draftId, deck.seat],
    });
    await batchInsertDeckCards(client, rows);
    await client.execute({
      sql: "INSERT OR REPLACE INTO deck_hashes (draft_id, seat, hash, sealeddeck_id) VALUES (?, ?, ?, ?)",
      args: [deck.draftId, deck.seat, hash, source],
    });

    logIndent(`${deck.draftId} seat ${deck.seat}: ${rows.length} rows written (${source})`);
  }

  log(`Imported ${resolved.length} recovered decklist(s)`);
  client.close();
}

// Only run the CLI when invoked directly, so the test can import the module.
if (process.argv[1] && process.argv[1].endsWith("import-recovered-decks.ts")) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run scripts/import-recovered-decks.test.ts
```

Expected: PASS — 5 tests.

- [ ] **Step 5: Register the command**

In `package.json`, after `"decklists:integrity"`:

```json
    "decklists:import": "tsx scripts/import-recovered-decks.ts",
```

- [ ] **Step 6: Verify quality gates**

```bash
npx tsc --noEmit && pnpm lint && pnpm knip && npx vitest run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add scripts/import-recovered-decks.ts scripts/import-recovered-decks.test.ts package.json
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Import hand-recovered decklists, resolving cards from the seat's own picks

Resolving against a global name lookup would let a vision transcription
error write a plausible deck. Restricting to that seat's picks makes a
misread card impossible to insert rather than merely unlikely.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The `Sideboard:` submissions — investigate, then fix or record no-go

Two submissions have a literal `Sideboard:` header parsed as a card name, wrecking the deck/sideboard split: `maelstrom-pulse:7` stored 12 maindeck cards, `liliana-of-the-veil:2` stored 3. Both are dropped by the `maindeckQty < 20` guard.

**This task starts with an investigation and may legitimately end in "no code change".** Do not write a parser fix before Step 2 tells you where the damage happened.

**Files:**
- Modify (conditional): `scripts/decklists.ts`, `scripts/decklists.test.ts`
- Create: `docs/superpowers/plans/2026-08-09-sideboard-marker-finding.md` (the go/no-go record)

**Interfaces:**
- Consumes: Task 2's `extractStoredCards`.
- Produces: either a `Sideboard:`-aware zone split, or a written finding that no fix is possible on our side.

- [ ] **Step 1: Find the two submissions' sealeddeck ids**

```bash
sed -n '/^maelstrom-pulse$/,/^$/p;/^liliana-of-the-veil$/,/^$/p' data/decklists.txt
```

Record every URL under both draft headings.

- [ ] **Step 2: Inspect the raw zones**

For each id from Step 1:

```bash
node -e '
const id = process.argv[1];
fetch(`https://sealeddeck.tech/api/pools/${id}`).then(r => r.json()).then(p => {
  const marker = (zone) => (p[zone] || []).filter(c => /sideboard/i.test(c.name)).map(c => c.name);
  console.log(id,
    "deck=" + p.deck.length,
    "side=" + p.sideboard.length,
    "hidden=" + (p.hidden || []).length,
    "| markers: deck=" + JSON.stringify(marker("deck")),
    "sideboard=" + JSON.stringify(marker("sideboard")));
});
' <SEALEDDECK_ID>
```

- [ ] **Step 3: Decide, and record the decision**

**GO** if a card whose name matches `/^sideboard:?$/i` appears in the `deck` array with the maindeck before it and the sideboard after it. Our parser can split on it.

**NO-GO** if the marker is absent, or the cards are already scattered across zones with no recoverable order. sealeddeck's own paste parser destroyed the split upstream and nothing on our side can undo it.

Either way, write `docs/superpowers/plans/2026-08-09-sideboard-marker-finding.md` recording the ids inspected, the raw zone sizes, the marker positions, and the decision with its reasoning. A future reader must not have to re-run this investigation.

- [ ] **Step 4 (GO path only): Write the failing test**

Add to `scripts/decklists.test.ts`:

```ts
import { splitOnSideboardMarker } from "./decklists";

describe("splitOnSideboardMarker", () => {
  it("splits a deck zone at a literal Sideboard: entry", () => {
    // Some submitters pasted a text decklist including its "Sideboard:" header.
    // sealeddeck parsed that header as a card, so everything after it landed in
    // the maindeck zone.
    const result = splitOnSideboardMarker([
      { name: "Lightning Bolt", count: 4 },
      { name: "Sideboard:", count: 1 },
      { name: "Duress", count: 2 },
    ]);
    expect(result.deck).toEqual([{ name: "Lightning Bolt", count: 4 }]);
    expect(result.sideboard).toEqual([{ name: "Duress", count: 2 }]);
  });

  it("leaves a well-formed deck zone untouched", () => {
    const cards = [{ name: "Lightning Bolt", count: 4 }];
    const result = splitOnSideboardMarker(cards);
    expect(result.deck).toEqual(cards);
    expect(result.sideboard).toEqual([]);
  });
});
```

- [ ] **Step 5 (GO path only): Run the test to verify it fails**

```bash
npx vitest run scripts/decklists.test.ts
```

Expected: FAIL — `splitOnSideboardMarker` is not exported.

- [ ] **Step 6 (GO path only): Implement the split**

Add to `scripts/decklists.ts`, just above `extractStoredCards`:

```ts
/** Matches a decklist text header that sealeddeck parsed as if it were a card. */
const SIDEBOARD_MARKER = /^sideboard:?$/i;

/**
 * Split a deck zone at a literal `Sideboard:` entry.
 *
 * When a submitter pastes a text decklist that includes its own "Sideboard:"
 * header, sealeddeck treats the header as a card name and everything after it
 * stays in the deck zone. Splitting there recovers the intended zones.
 */
export function splitOnSideboardMarker(cards: SealedDeckCard[]): {
  deck: SealedDeckCard[];
  sideboard: SealedDeckCard[];
} {
  const markerIndex = cards.findIndex((c) => SIDEBOARD_MARKER.test(c.name.trim()));
  if (markerIndex === -1) return { deck: cards, sideboard: [] };
  return {
    deck: cards.slice(0, markerIndex),
    sideboard: cards.slice(markerIndex + 1),
  };
}
```

Then apply it in `fetchAllDecklists`, replacing the `decklists.push` block from Task 2 Step 6:

```ts
      const split = splitOnSideboardMarker(response.deck);
      const normalized: SealedDeckResponse = {
        ...response,
        deck: split.deck,
        sideboard: [...response.sideboard, ...split.sideboard],
      };
      const storedCards = extractStoredCards(normalized);

      decklists.push({
        sealeddeckId: id,
        url: `https://sealeddeck.tech/${id}`,
        deck: extractZoneCards(normalized.deck),
        sideboard: extractZoneCards(normalized.sideboard),
        storedCards,
      });
```

- [ ] **Step 7 (GO path only): Run the tests to verify they pass**

```bash
npx vitest run scripts/decklists.test.ts && npx tsc --noEmit
```

Expected: PASS — 10 tests.

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add -A
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Handle decklists whose pasted Sideboard: header became a card

sealeddeck parses the header as a card name and leaves the sideboard in
the deck zone, so the import dropped these decks as malformed rather
than splitting them where the submitter intended.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

On the NO-GO path, commit only the finding document with a message explaining that the damage is upstream and both seats fall back to screenshots.

---

### Task 8: Migrate and re-run the matcher against production

**First task that writes production.** One database, no staging, no undo. `pnpm decklists` also re-fetches ~230 lists from sealeddeck.tech, so it is not free for them either.

**Files:** none — this is an operational task.

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces: corrected `deck_cards` for `tarmogoyf:2`, `tarmogoyf:10`, `terminate:10`, and `sealeddeck_id` provenance on every fetched deck.

- [ ] **Step 1: Confirm the code is complete and green**

```bash
git -C /Users/arpanet/code/read-the-bones status --short
pnpm precommit
```

Expected: clean tree, all gates pass. Do not proceed otherwise.

- [ ] **Step 2: Apply the schema migration**

```bash
pnpm db:migrate
```

Expected: `OK` or `SKIP (already exists)` for every statement, ending in `Migration complete`. The `sealeddeck_id` column must exist before the run, or nothing gets stamped and Task 12's prune has nothing to query.

Verify:

```bash
turso db shell read-the-bones "SELECT sql FROM sqlite_master WHERE name='deck_hashes'"
```

Expected: the DDL now mentions `sealeddeck_id`.

- [ ] **Step 3: Record the before state**

```bash
pnpm decklists:integrity 2>&1 | tee /tmp/integrity-before.txt
```

Expected: 3 suspect (`baleful-strix:1`, `tarmogoyf:2`, `terminate:3`).

- [ ] **Step 4: Dry-run the full fetch and read the output**

```bash
pnpm decklists --dry-run 2>&1 | tee /tmp/decklists-dryrun.txt
```

Read the whole file. Check specifically:

- `tarmogoyf`: `r1wk7SHA9B` lands on seat 2; `LZYpr4rjmH` and `5NVp1hc5J5` land on seat 10 (the later of the two wins).
- `terminate`: some submission lands on seat 10.
- Roughly seven `no overlap with any seat (expected for an opted-out player)` lines across all drafts, and no more.
- No `N seats are eligible` ambiguity warnings.
- Any `WARNING: Skipping` line with a non-zero best precision — investigate before applying. A cluster of them in one draft suggests DFC or split-card names failing to resolve, which would mean the 0.9 floor needs revisiting rather than the data being wrong.

- [ ] **Step 5: Apply**

Only after Step 4 reads correctly:

```bash
pnpm decklists 2>&1 | tee /tmp/decklists-apply.txt
```

- [ ] **Step 6: Verify the repair**

```bash
pnpm decklists:integrity 2>&1 | tee /tmp/integrity-after.txt
diff /tmp/integrity-before.txt /tmp/integrity-after.txt
```

Expected: `tarmogoyf:2` no longer suspect; `tarmogoyf:10` and `terminate:10` no longer absent. `baleful-strix:1` and `terminate:3` may still be suspect — Task 9 handles them.

- [ ] **Step 7: Verify provenance is populated**

```bash
turso db shell read-the-bones "SELECT COUNT(*) AS total, COUNT(sealeddeck_id) AS with_source FROM deck_hashes"
```

**This criterion was wrong as originally written and has been corrected.** It said `with_source` must equal `total`, and that a null meant the hash short-circuit was broken. That cannot hold: rows for seats whose submission is reassigned elsewhere — the three corrupted seats among them — are never rewritten, so they keep a null `sealeddeck_id` legitimately. Following the old instruction would send an operator to "fix" a guard that is working, and re-run 230 fetches plus a full rewrite for nothing.

What to check instead: every seat that *received an assignment in this run* has a non-null `sealeddeck_id`. Nulls are expected exactly for seats with no matching submission — enumerate them and confirm each is explainable:

```bash
turso db shell read-the-bones "SELECT draft_id, seat FROM deck_hashes WHERE sealeddeck_id IS NULL ORDER BY draft_id, seat"
```

Expected nulls after this task: `baleful-strix:1`, `tarmogoyf:2`, `terminate:3` (their submissions now belong to their true owners), plus any seat whose URL is absent from `decklists.txt` or whose submission failed the gates. Anything else on that list is worth investigating before Task 9 deletes rows.

---

### Task 9: Delete the residual wrong rows

A seat still failing the precision floor holds another player's cards. Today those seats are attributed a deck they never drafted, and play rate, win rate and `deck_colors` all read `deck_cards`. Absent is honest; wrong is not.

**Files:** none — operational, plus notes for Task 12.

**Interfaces:**
- Consumes: Task 8's integrity output.
- Produces: zero suspect decklists.

- [ ] **Step 1: List exactly what will be deleted**

```bash
pnpm decklists:integrity
```

For each suspect `<draft>:<seat>`, capture what is there now so Task 12 can annotate it:

```bash
turso db shell read-the-bones "SELECT dc.zone, c.name FROM deck_cards dc JOIN cards c ON c.card_id=dc.card_id WHERE dc.draft_id='<draft>' AND dc.seat=<seat> ORDER BY dc.zone, c.name"
turso db shell read-the-bones "SELECT * FROM deck_hashes WHERE draft_id='<draft>' AND seat=<seat>"
```

Save both to `/tmp/deleted-<draft>-<seat>.txt`.

- [ ] **Step 2: Confirm no correct deck is available for that seat**

Before deleting, check the dry-run log from Task 8 Step 4 for that draft. If any submission scored close to the seat but fell below a threshold, investigate that first — a near-miss may be the real deck failing on a name-resolution quirk rather than a genuine non-match.

```bash
grep -A 40 "^<draft-label>" /tmp/decklists-dryrun.txt
```

- [ ] **Step 3: Delete**

For each confirmed suspect:

```bash
turso db shell read-the-bones "DELETE FROM deck_cards WHERE draft_id='<draft>' AND seat=<seat>; DELETE FROM deck_hashes WHERE draft_id='<draft>' AND seat=<seat>;"
```

- [ ] **Step 4: Verify**

```bash
pnpm decklists:integrity; echo "exit=$?"
```

Expected: `suspect ... : 0` and `exit=0`. The deleted seats now appear under `missing` in the absent list — which is the flag Task 12 turns into the remediation queue.

---

### Task 10: Import the nine recovered decklists

**Files:** none — operational.

**Interfaces:**
- Consumes: Task 6's `pnpm decklists:import`.
- Produces: nine seats populated with `recovered:` provenance.

- [ ] **Step 1: Dry-run**

```bash
pnpm decklists:import --dry-run
```

Expected: 9 files resolve, each printing its maindeck and sideboard counts. Any failure lists the offending card names and exits 1 — a card not among that seat's picks means the transcription is wrong, so fix the JSON rather than loosening the importer.

Sanity-check the counts against the handoff: maindecks should be ~26-33 non-basics (basics are never stored), and `baleful-strix:5` should match what `pnpm decklists` already assigned there, since the two were independently confirmed byte-identical.

- [ ] **Step 2: Apply**

```bash
pnpm decklists:import
```

- [ ] **Step 3: Verify**

```bash
pnpm decklists:integrity; echo "exit=$?"
turso db shell read-the-bones "SELECT draft_id, seat, sealeddeck_id FROM deck_hashes WHERE sealeddeck_id LIKE 'recovered:%' ORDER BY draft_id, seat"
```

Expected: still 0 suspect, and 9 rows marked `recovered:`.

- [ ] **Step 4: Verify the overwrite guard actually holds**

This is the mechanism protecting every manual remediation from here on. Prove it works rather than assuming it:

```bash
pnpm decklists baleful-strix --dry-run
```

Expected: the `baleful-strix` seats marked `recovered:` report `skipped — hand-recovered deck (recovered:...)`. If any reports `would update`, the guard in Task 3 Step 4 is wrong. Stop and fix it — the next full run would silently revert the import.

---

### Task 11: Parse the remaining screenshots

Six screenshots need parsing; two more serve as cross-checks. This is the parallelisable part — dispatch one subagent per screenshot.

**Files:**
- Create: `docs/decklist-recovery-parsed/<draft>-seat-<n>.json` per screenshot

**Interfaces:**
- Consumes: Task 6's importer schema — each file must have `draftId`, `seat`, `maindeckNonBasics[]`, `sideboard[]`.
- Produces: parsed decks for import.

**Targets** (in `data/decklists-tmp-delete-when-done/`):

| Screenshot | Draft | Seat | Note |
|---|---|---|---|
| `tarmogoyf-seat-6.png` | tarmogoyf | 6 | supplied after the handoff was written |
| `maelstrom-pulse-seat-2.png` | maelstrom-pulse | 2 | |
| `ravnica-seat-9.png` | ravnica | 9 | |
| `tarkir-seat-4.png` | tarkir | 4 | |
| `maelstrom-pulse-seat-7.png` | maelstrom-pulse | 7 | **skip if Task 7 was GO** — recovered from its URL |
| `liliana-seat-2.jpg` | liliana-of-the-veil | 2 | **skip if Task 7 was GO** — recovered from its URL |
| `tarmogoyf-seat-10.png` | tarmogoyf | 10 | **cross-check only** — Task 8 recovered this from its URL |
| `terminate-seat-10.png` | terminate | 10 | **cross-check only** — Task 8 recovered this from its URL |

- [ ] **Step 1: Confirm which targets still need parsing**

```bash
pnpm decklists:integrity
```

Any seat in the table above that is no longer `missing` was recovered upstream. Parse it only as a cross-check.

- [ ] **Step 2: Dispatch one subagent per screenshot**

**Give each agent its own scratch directory** — `/tmp/parse-<draft>-seat-<n>/`. Concurrent agents previously chose identical scratch filenames (`picks.txt`, `image_nonbasics.txt`), overwrote each other, and two reported it as suspected tampering because the harness's file-modification notice reads as adversarial when the real author is a sibling agent.

Each agent's brief:

1. Read the screenshot. Two layouts occur. **Deck-only:** one grid, everything shown is the maindeck. **Split-view:** two grids separated by a toolbar reading `Deck: 40 | Lands: 16 | Creatures: 17 | ...` — above the bar is the **sideboard**, below is the **maindeck**. Column headers are *card counts*, not mana values, and they sum to the zone total.
2. Query that seat's picks:
   ```bash
   turso db shell read-the-bones "SELECT c.name FROM pick_events pe JOIN cards c ON c.card_id=pe.card_id WHERE pe.draft_id='<draft>' AND pe.seat=<seat> ORDER BY c.name"
   ```
3. **Diff mechanically, in both directions.** Every non-basic card in the image must appear in the picks. A mismatch is a transcription error — find the pick it corresponds to and correct it. Known failure modes: dropped letters (`Mismoors` for `Mistmoors`); DFC back faces (the UI shows the land face, the database keys on the front — `Witch-Blessed Meadow` is `Witch Enchanter`); split-card halves (`Death` is `Life // Death`); and alternate printing names with no database entry.
4. For deck-only layouts, derive `sideboard = picks − maindeck`.
5. Reconcile: maindeck non-basics + sideboard = total picks, minus any legitimately unplaced cards. Sealeddeck's `hidden` zone holds unplaced pool cards, so `maindeck + sideboard < picks` is valid. A card *not in the picks at all* is not.
6. **Do not trust a reconciliation that rests on a single leftover pair.** When exactly one image card and exactly one pick remain unmatched, the diff pairs them whether or not the pairing is right. Corroborate independently — mana-value column placement is usually decisive, since columns are sorted by mana value and the set of that seat's picks at that mana value is knowable.
7. Ignore cropping. Every cropping issue observed so far affected only basic land counts, and basics are never stored.
8. Write `docs/decklist-recovery-parsed/<draft>-seat-<n>.json`:
   ```json
   {
     "draftId": "<draft>",
     "seat": 0,
     "layout": "deck-only | split-view",
     "basics": { "Island": 0 },
     "maindeckNonBasics": [],
     "sideboard": [],
     "totalPicks": 0,
     "reconciles": true,
     "corrections": [{ "read": "", "actual": "", "reason": "" }],
     "uncertain": [{ "item": "", "reason": "" }]
   }
   ```

- [ ] **Step 3: Verify every parsed file independently**

```bash
node data/decklist-recovery/scripts/verify-decks.mjs
```

Expected: `ALL PASS`. This re-derives picks from the database and trusts nothing the parsing reported.

- [ ] **Step 4: Cross-check the two decks recovered from URLs**

For `tarmogoyf:10` and `terminate:10`, compare the parsed JSON against what Task 8 already stored:

```bash
turso db shell read-the-bones "SELECT dc.zone, c.name FROM deck_cards dc JOIN cards c ON c.card_id=dc.card_id WHERE dc.draft_id='tarmogoyf' AND dc.seat=10 ORDER BY dc.zone, c.name"
```

Expected: the same card set as the screenshot's. A match is strong evidence for both methods, exactly as `baleful-strix:5` was confirmed byte-identical by two independent routes. A mismatch means one of them is wrong — investigate before importing, and do not let the import overwrite the URL-sourced deck until you know which is right.

- [ ] **Step 5: Import**

```bash
pnpm decklists:import --dry-run
pnpm decklists:import
pnpm decklists:integrity; echo "exit=$?"
```

Expected: 0 suspect. The seats parsed in this task move out of `missing`.

- [ ] **Step 6: Commit the parsed decks**

```bash
git -C /Users/arpanet/code/read-the-bones add docs/decklist-recovery-parsed/
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Add decklists recovered from the remaining screenshots

data/ is gitignored, so these transcriptions exist nowhere else — and a
draft:reset wipes deck_cards, making the committed copy the only way to
restore them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Prune the inbox, publish the queue, document, deploy

**Files:**
- Modify: `data/decklists.txt` (prune), `CLAUDE.md`, `docs/decklist-recovery-handoff.md` (retire)
- Create: `docs/decklist-status.md`

**Interfaces:**
- Consumes: `deck_hashes.sealeddeck_id` from Task 8; `pnpm decklists:integrity --write-report` from Task 5.
- Produces: `decklists.txt` containing only unprocessed submissions; a committed remediation queue.

- [ ] **Step 1: Back up the inbox before touching it**

`data/` is gitignored, so this file has never been committed and there is no history to recover from.

```bash
cp data/decklists.txt /tmp/decklists-before-prune.txt
wc -l /tmp/decklists-before-prune.txt
```

- [ ] **Step 2: Prune every URL now represented in the database**

```bash
turso db shell read-the-bones "SELECT sealeddeck_id FROM deck_hashes WHERE sealeddeck_id IS NOT NULL AND sealeddeck_id NOT LIKE 'recovered:%'" \
  | tail -n +2 | tr -d ' ' | grep -v '^$' | sort -u > /tmp/ingested-ids.txt

wc -l /tmp/ingested-ids.txt

python3 - <<'PY'
ingested = {l.strip() for l in open('/tmp/ingested-ids.txt') if l.strip()}
kept, dropped = [], 0
for line in open('/tmp/decklists-before-prune.txt'):
    s = line.strip()
    if s.startswith('https://') and s.rstrip('/').rsplit('/', 1)[-1] in ingested:
        dropped += 1
        continue
    kept.append(line)
open('data/decklists.txt', 'w').writelines(kept)
print(f"dropped {dropped} ingested URLs")
PY
```

Note the trailing-whitespace handling: several lines in the original file end with a space.

- [ ] **Step 3: Account for every remaining URL**

```bash
grep -c "sealeddeck" data/decklists.txt
grep "sealeddeck" data/decklists.txt
```

Every survivor must be explainable. Expected categories: opted-out players' lists (never assignable by design), superseded duplicates for a seat that received a later submission, and — if Task 7 was NO-GO — the two malformed `Sideboard:` submissions. For each one, confirm which category it falls into using `/tmp/decklists-dryrun.txt`.

**Do not read "absent from `deck_hashes`" as "never fetched."** `sealeddeck_id` records only the *winning* submission for each seat. A submission that was superseded by a later one for the same seat, or rejected as no-overlap or ambiguous, never reaches the writer loop and so never appears in the table at all. The prune therefore *retains* those URLs — which is the safe direction, since retaining costs a re-fetch while dropping loses the record — but it means the residue is "not stored" rather than "not tried." Classify each survivor from the dry-run log, not from its absence in the query.

Remove the opted-out and superseded entries too; they will never be ingested and leaving them means every future run re-fetches and re-skips them. Keep only URLs that still represent unimported work, and add a comment line above any you keep saying why.

- [ ] **Step 4: Generate and annotate the remediation queue**

```bash
pnpm decklists:integrity --write-report
```

Then edit `docs/decklist-status.md` by hand to fill the `Note` column for every `missing` seat. The database knows a deck is absent; only a person knows why. Use the capture files from Task 9 Step 1 for the deleted seats. Expected annotations:

- `baleful-strix:1` — held another seat's deck, deleted in this effort; true submission URL never identified.
- `terminate:3` — same.
- `tarmogoyf:6` — supplied URL `TNPhegPPFk` actually belongs to seat 7; awaiting a correct URL from the submitter if the screenshot did not resolve it.
- Anything still missing after Task 11.

Also add a short section noting the 49 seats across `lightning-bolt`, `lorwyn`, `tarkir-fate-reforged`, `thoughtseize` and `birds-of-paradise` where no decklist was ever collected for any seat, and that their picks and match results still count toward statistics while their decks do not.

- [ ] **Step 5: Update CLAUDE.md**

In the `# Decklists` block, add:

```
pnpm decklists:integrity        # Audit stored decks against picks; list seats with no deck
pnpm decklists:import           # Import hand-recovered decks from docs/decklist-recovery-parsed
```

Replace the `**Decklists:**` paragraph with one that states the inbox semantics:

> **Decklists:** `data/decklists.txt` is an **inbox, not an archive** — it holds sealeddeck.tech URLs that have not been ingested yet. `pnpm decklists` fetches each one, matches it to a seat by card overlap with pick data, and writes deck cards to Turso; once a URL is stored, remove it from the file. Provenance lives in `deck_hashes.sealeddeck_id`, so `SELECT sealeddeck_id FROM deck_hashes` answers "which submission produced this deck". Matching uses `deck + sideboard` only — never sealeddeck's `hidden` zone, which some submitters fill with the entire cube. A seat whose `sealeddeck_id` starts with `recovered:` was hand-transcribed from a screenshot and will not be overwritten without `--force`. Run `pnpm decklists:integrity` after any change; `docs/decklist-status.md` is the remediation queue.

Then, immediately after the existing **Opt-out operational hazard** paragraph, add:

> **Recovered-decklist hazard:** `pnpm draft:reset` deletes `deck_cards` and `deck_hashes` for the draft (`db-helpers.ts`, `resetDraft`), taking hand-recovered decklists with them — and their sealeddeck URLs have been pruned from `data/decklists.txt`, so a re-run of `pnpm decklists` will not restore them. Recovery is `pnpm decklists:import`, which works only because the parsed JSONs are committed at `docs/decklist-recovery-parsed/`. Never delete that directory.

Finally, add to the Superpowers Specs and Plans indexes:

```
- `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md` - Decklist recovery: matcher precision gate, provenance, recovered-deck import
- `docs/superpowers/plans/2026-08-09-decklist-recovery.md` - Decklist recovery implementation
```

- [ ] **Step 6: Retire the handoff document**

`docs/decklist-recovery-handoff.md` recommends the `max()` scoring fix this work rejected, and describes `tarmogoyf:10` and `terminate:10` as needing hand recovery when they were recovered from their URLs. A stale document that confidently recommends a rejected approach is worse than no document.

Replace its body with a short pointer:

```markdown
# Decklist Recovery — Handoff (superseded)

**Superseded 2026-08-09.** This investigation identified the matcher defect and
recovered nine decklists from screenshots. Its findings were correct; its proposed
fix was not adopted.

- **What was built:** `docs/superpowers/specs/2026-08-09-decklist-recovery-design.md`
- **Current data state:** `docs/decklist-status.md`

The one recommendation that changed: this document proposed scoring against
`max(picks.size, pool.size)` while keeping sealeddeck's `hidden` zone in the pool.
That prevents corruption but *skips* full-cube submissions. Matching on
`deck + sideboard` instead — the cards we actually store — assigns them to their
true owners, which recovered `tarmogoyf:10` and `terminate:10` without the hand
recovery this document anticipated.

Retained in git history for the investigation record.
```

- [ ] **Step 7: Final verification**

```bash
pnpm decklists:integrity; echo "exit=$?"
pnpm decklists --dry-run 2>&1 | tail -30
pnpm precommit
```

Expected: 0 suspect and `exit=0`; the dry run reports nothing left to do for any pruned draft; all quality gates pass.

- [ ] **Step 8: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add -A
git -C /Users/arpanet/code/read-the-bones commit -m "$(cat <<'EOF'
Turn the decklist inbox into a queue with a published status

Provenance now lives in the database, so decklists.txt no longer has to
carry ingested URLs. What remains after pruning is by definition the
unfinished work, and the seats still lacking decks are listed with
reasons instead of being indistinguishable from seats that never played.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Deploy**

Deck data is baked into the static build at build time, and a data-only change involves no commit, so nothing triggers a git deploy. None of this is visible on the site until:

```bash
vercel --prod
```

- [ ] **Step 10: Clean up the screenshots**

Once every screenshot has been parsed and imported, `data/decklists-tmp-delete-when-done/` has served its purpose. Confirm `docs/decklist-recovery-parsed/` holds a JSON for each one first — the JSONs are committed, the images are not.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| D1 — stored-card matching, precision gate | 1, 2, 2B |
| Importing the script must not run it | 2B |
| Destructive delete must not precede the guard that rejects bad decks | 4 |
| D2 — provenance in `deck_hashes`, hash short-circuit | 3 |
| D3 — `decklists.txt` as inbox | 12 |
| D4 — recovered-deck guard, `draft:reset` hazard | 3 (guard), 10 Step 4 (proof), 12 Step 5 (docs) |
| D5 — delete wrong rows, join the queue | 9, 12 Step 4 |
| D6 — remediation queue as committed artifact | 5, 12 Step 4 |
| D7 — `Sideboard:` contingent fix | 7 |
| `--dry-run` for the fetcher | 4 |
| Opt-out log downgrade | 2 (`reportSkip`) |
| `maindeckQty < 20` visible in the report | 5 (those seats appear as `missing`) |
| Importer resolves via seat's own picks | 6 |
| Regression tests | 2 Step 1 |
| Private scratch dirs for parsing agents | 11 Step 2 |
| `vercel --prod` | 12 Step 9 |
| 49 uncollected seats recorded, not fixed | 12 Step 4 |

**Type consistency:** `storedCards` is used in `DecklistEntry` (Task 2), the test helper (Task 2 Step 1), and the call site (Task 2 Step 6) — never `pool`. `SeatScore` fields `overlap`/`recall`/`precision` are consistent across Tasks 1, 2 and 5. `DeckCardInsert` fields match `src/core/db/sync/batch.ts:48-56`. `scoreAgainstSeat`/`isEligibleSeat`/`formatPct` are named identically in Tasks 1, 2 and 5.

**Known ordering constraint:** Task 3 Step 3 changes `process.argv[2]` to a flag-skipping lookup. Task 4 depends on that change; do not reorder them.
