# Deep Clean Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 35+ findings from the deep clean audit: deduplication, code quality, security hardening, performance optimization, and test coverage gaps.

**Architecture:** Group fixes by theme into independent tasks. Each task produces a self-contained commit. Tasks are ordered by dependency — shared utilities first, then consumers, then tests.

**Tech Stack:** TypeScript, Next.js, Vitest, Turso (libsql)

---

## Chunk 1: Shared Utilities and Deduplication

These tasks extract shared code that other tasks depend on.

### Task 1: Consolidate `wilsonInterval` into a single implementation

The codebase has two `wilsonInterval` functions with incompatible signatures. `wilsonInterval.ts` returns `[lower, upper]` (tuple), `utils.ts` returns `{lower, center, upper}` (object with rounding). Consolidate to a single implementation.

**Decision:** Keep `wilsonInterval.ts` as the canonical location. Add `center` to its return type. Add a `round3` utility. Remove the `utils.ts` version.

**Files:**
- Modify: `src/core/wilsonInterval.ts`
- Modify: `src/core/utils.ts` — remove `wilsonInterval`, add `round3`
- Modify: `src/core/db/queries/stats.ts` — update import from `utils` to `wilsonInterval`
- Modify: `src/core/wilsonInterval.test.ts` — add `center` tests
- Modify: `src/core/utils.test.ts` — remove wilsonInterval tests, add `round3` tests

- [ ] **Step 1: Add `round3` utility to `utils.ts`**

Add to `src/core/utils.ts`:
```typescript
/** Round a number to 3 decimal places. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
```

- [ ] **Step 2: Write tests for `round3`**

In `src/core/utils.test.ts`, add:
```typescript
describe("round3", () => {
  it("rounds to 3 decimal places", () => {
    expect(round3(0.12345)).toBe(0.123);
    expect(round3(0.9999)).toBe(1);
    expect(round3(0)).toBe(0);
  });
});
```

- [ ] **Step 3: Expand `wilsonInterval.ts` to return `{ lower, center, upper }`**

**Important:** The `utils.ts` version rounds to 3 decimal places and uses a slightly different margin formula. The `wilsonInterval.ts` version does not round. Keep the `utils.ts` formula (which consumers of `{lower, center, upper}` depend on) but move it to `wilsonInterval.ts`. Apply `round3` to the output to preserve existing behavior.

```typescript
import { round3 } from "./utils";

export function wilsonInterval(
  wins: number,
  total: number,
  z = 1.96
): { lower: number; center: number; upper: number } {
  if (total === 0) return { lower: 0, center: 0, upper: 0 };

  const p = wins / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));

  return {
    lower: round3(Math.max(0, center - margin)),
    center: round3(center),
    upper: round3(Math.min(1, center + margin)),
  };
}
```

**Verification:** After this change, run both `wilsonInterval.test.ts` and `utils.test.ts` to confirm numeric outputs match existing expectations. If any consumer was using the tuple `[lower, upper]` return shape, update the destructuring.

Note: Task 1's `round3` must be implemented first (Step 1-2) since `wilsonInterval.ts` will import it. Tasks 1 and 8 should be in the same commit to avoid intermediate states where rounding is lost.

- [ ] **Step 4: Update all consumers**

Consumers currently using `[lower, upper]` destructuring (`getDraftStats.ts`, `DraftStats.tsx`, `stats/route.ts`): update to use `{ lower, upper }` or `{ lower, center, upper }`.

Consumer currently using `utils.ts` version (`stats.ts`): switch import to `wilsonInterval.ts`.

- [ ] **Step 5: Remove `wilsonInterval` from `utils.ts`**

Delete the function and its tests from `utils.test.ts`.

- [ ] **Step 6: Update `wilsonInterval.test.ts`**

Add test for `center` field. Update existing tests from tuple to object destructuring.

- [ ] **Step 7: Run `pnpm precommit` and verify**

- [ ] **Step 8: Commit**

```
Consolidate wilsonInterval into a single implementation with center field
```

---

### Task 2: Extract deck color inference to shared utility

The 30% threshold algorithm is duplicated between `getDraftStats.ts` and `helpers.ts`.

**Files:**
- Create: `src/core/inferDeckColor.ts`
- Create: `src/core/inferDeckColor.test.ts`
- Modify: `src/core/getDraftStats.ts` — import shared function
- Modify: `src/core/db/queries/helpers.ts` — import shared function, fix stale comment

- [ ] **Step 1: Write tests for `inferDeckColor`**

```typescript
describe("inferDeckColor", () => {
  it("returns C for empty color counts", () => {
    expect(inferDeckColor(new Map())).toBe("C");
  });
  it("returns single color for mono-color deck", () => {
    expect(inferDeckColor(new Map([["R", 40], ["U", 2]]))).toBe("R");
  });
  it("returns two colors when second is >= 30% of first", () => {
    expect(inferDeckColor(new Map([["R", 30], ["U", 15]]))).toBe("RU");
  });
  it("sorts colors in WUBRG order", () => {
    expect(inferDeckColor(new Map([["G", 20], ["W", 20]]))).toBe("WG");
  });
});
```

- [ ] **Step 2: Extract `inferDeckColor` to `src/core/inferDeckColor.ts`**

Move the function from `getDraftStats.ts` to its own module. Export it.

- [ ] **Step 3: Update `getDraftStats.ts` and `helpers.ts` to import from shared module**

Fix the stale comment in `helpers.ts:63` that references `draftState.ts`.

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Extract deck color inference to shared module, fix stale comment
```

---

### Task 3: Extract DFC front-face utility

The `name.includes(" // ") ? name.split(" // ")[0] : null` pattern appears in 5+ files.

**Files:**
- Create: `src/core/cardNames.ts`
- Create: `src/core/cardNames.test.ts`
- Modify: `src/app/hooks/useCardFiltering.ts`
- Modify: `src/app/hooks/useCardSearch.ts`
- Modify: `src/core/getCards.ts`
- Modify: `src/core/db/queries/picks.ts`
- Modify: `src/core/db/ingest/scryfall.ts`

- [ ] **Step 1: Write tests for `getFrontFace`**

```typescript
describe("getFrontFace", () => {
  it("returns front face of DFC", () => {
    expect(getFrontFace("Bonecrusher Giant // Stomp")).toBe("Bonecrusher Giant");
  });
  it("returns null for single-faced card", () => {
    expect(getFrontFace("Lightning Bolt")).toBeNull();
  });
});
```

- [ ] **Step 2: Create `src/core/cardNames.ts`**

```typescript
/** Extract the front face name from a DFC card name, or null if not a DFC. */
export function getFrontFace(cardName: string): string | null {
  const idx = cardName.indexOf(" // ");
  return idx !== -1 ? cardName.slice(0, idx) : null;
}
```

Note: Also move `normalizeCardName` here if it doesn't already live in a shared location. Check `parseCsv.ts` first.

- [ ] **Step 3: Replace all 5+ inline instances with `getFrontFace` import**

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Extract DFC front-face splitting to shared utility
```

---

### Task 4: Extract color pair decomposition to shared utility

Duplicated between `src/app/api/stats/route.ts` and `src/app/components/DraftStats.tsx`.

**Files:**
- Create: `src/core/colorDecomposition.ts`
- Create: `src/core/colorDecomposition.test.ts`
- Modify: `src/app/api/stats/route.ts`
- Modify: `src/app/components/DraftStats.tsx`

- [ ] **Step 1: Write tests**

```typescript
describe("decomposeColorPairs", () => {
  it("decomposes pair win rates into individual color buckets", () => {
    const input = [
      { color: "WU", wins: 10, losses: 5 },
      { color: "R", wins: 3, losses: 7 },
    ];
    const result = decomposeColorPairs(input);
    expect(result.find(c => c.color === "W")?.wins).toBe(10);
    expect(result.find(c => c.color === "U")?.wins).toBe(10);
    expect(result.find(c => c.color === "R")?.wins).toBe(3);
    expect(result.find(c => c.color === "W")?.losses).toBe(5);
    expect(result.find(c => c.color === "U")?.losses).toBe(5);
  });
  it("handles colorless as C", () => {
    const input = [{ color: "C", wins: 2, losses: 1 }];
    const result = decomposeColorPairs(input);
    expect(result[0].color).toBe("C");
  });
  it("returns results in WUBRGC order", () => {
    const input = [
      { color: "G", wins: 1, losses: 1 },
      { color: "W", wins: 1, losses: 1 },
    ];
    const result = decomposeColorPairs(input);
    expect(result.map(c => c.color)).toEqual(["W", "G"]);
  });
});
```

- [ ] **Step 2: Create `src/core/colorDecomposition.ts`**

Extract the shared decomposition logic. Return a generic shape both consumers can use.

- [ ] **Step 3: Update both consumers to use the shared function**

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Extract color pair decomposition to shared utility
```

---

### Task 5: Extract `InfoTooltip` to shared component

Duplicated between `CardTable.tsx` and `DraftStats.tsx` with minor styling differences.

**Files:**
- Create: `src/app/components/InfoTooltip.tsx`
- Modify: `src/app/components/CardTable.tsx` — remove inline version, import shared
- Modify: `src/app/components/DraftStats.tsx` — remove inline version, import shared

- [ ] **Step 1: Create shared `InfoTooltip` component**

Unify the two versions. Use the `CardTable` version (with arrow pointer) as the base. Accept an optional `align` prop (`"left" | "right"`) for positioning since the two usages position the tooltip differently.

- [ ] **Step 2: Update both consumers**

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Extract InfoTooltip to shared component
```

---

### Task 6: Rename ingest `DraftMetadata` to avoid type collision

Two types named `DraftMetadata` exist with different shapes.

**Files:**
- Modify: `src/core/db/ingest/utils.ts` — rename to `IngestDraftMetadata`
- Modify: all consumers of the ingest version (check `full-import.ts`, `discover.ts`, `incremental.ts`, `index.ts`)

- [ ] **Step 1: Rename `DraftMetadata` to `IngestDraftMetadata` in `src/core/db/ingest/utils.ts`**

- [ ] **Step 2: Update all ingest module consumers**

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Rename ingest DraftMetadata to IngestDraftMetadata to avoid type collision
```

---

### Task 7: Add `MIN_SAMPLE_SIZE` constant and replace magic number `5`

**Files:**
- Modify: `src/core/db/queries/stats.ts` — add constant, replace 4 instances

- [ ] **Step 1: Add constant at top of file**

```typescript
/** Minimum number of match results needed for confident win rate statistics. */
const MIN_SAMPLE_SIZE = 5;
```

- [ ] **Step 2: Replace all `< 5` checks with `< MIN_SAMPLE_SIZE`**

Find all instances around lines 380, 400, 743, 749.

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Replace magic number 5 with MIN_SAMPLE_SIZE constant
```

---

### Task 8: Replace `Math.round(x * 1000) / 1000` with `round3`

After Task 1 adds `round3` to `utils.ts`, replace all inline rounding instances.

**Depends on:** Task 1

**Files:**
- Modify: `src/core/getCards.ts` — replace inline rounding
- Modify: `src/core/db/queries/decklists.ts` — replace inline rounding
- Modify: `src/core/db/queries/stats.ts` — replace inline rounding
- Any other files with `Math.round(x * 1000) / 1000`

- [ ] **Step 1: Search for all instances of `Math.round(.*1000)`**

- [ ] **Step 2: Replace each with `round3(x)`, adding import from `utils.ts`**

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Replace inline rounding with round3 utility
```

---

## Chunk 2: Security & Validation

### Task 9: Add deck state validation to `POST /api/deck`

**Files:**
- Create: `src/core/validateDeckState.ts`
- Create: `src/core/validateDeckState.test.ts`
- Modify: `src/app/api/deck/route.ts` — add validation before DB insert

- [ ] **Step 1: Write validation tests**

```typescript
describe("validateDeckState", () => {
  it("accepts a valid deck state", () => {
    expect(validateDeckState(validDeck).valid).toBe(true);
  });
  it("rejects missing zones", () => {
    expect(validateDeckState({ ...validDeck, zones: undefined }).valid).toBe(false);
  });
  it("rejects deck with > 100 total cards", () => {
    // prevents abuse by stuffing hundreds of card entries
  });
  it("rejects non-string card names in columns", () => { });
  it("rejects missing draftId", () => { });
  it("rejects non-number seat", () => { });
  it("rejects negative basicLand counts", () => { });
  it("rejects speculativeCards that aren't string arrays", () => { });
});
```

- [ ] **Step 2: Implement `validateDeckState`**

Validate:
- `draftId` is a non-empty string
- `seat` is a positive integer
- `zones` has `deck` and `sideboard` keys, both are objects
- Each zone's values are arrays of strings
- Total card count across all zones <= 100 (reasonable upper bound)
- `speculativeCards` is an array of strings (if present)
- `basicLands` values are non-negative integers (if present)

Return `{ valid: true }` or `{ valid: false, reason: string }`. The reason is for server logging only, NOT returned to the client.

- [ ] **Step 3: Add validation to `POST /api/deck` route**

```typescript
const validation = validateDeckState(deckState);
if (!validation.valid) {
  return NextResponse.json({ error: "Invalid deck state" }, { status: 400 });
}
```

Generic error message — does NOT reveal expected shape.

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Add deck state validation to prevent malformed shared deck submissions
```

---

### Task 10: Replace `Math.random()` with `crypto.randomUUID()` for deck IDs

**Files:**
- Modify: `src/core/deckBuilder.ts` — replace `generateDeckId`
- Modify: `src/core/deckBuilder.test.ts` — update any tests that mock or test ID generation

- [ ] **Step 1: Update `generateDeckId`**

```typescript
export function generateDeckId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}
```

- [ ] **Step 2: Run `pnpm precommit` and verify**

- [ ] **Step 3: Commit**

```
Use crypto.getRandomValues for deck ID generation
```

---

### Task 11: Add bounds checking to API parameters

**Files:**
- Modify: `src/app/api/drafts/[id]/available/route.ts` — validate `before_pick_n` is positive
- Modify: `src/app/api/drafts/[id]/available/ranked/route.ts` — cap `limit` at a reasonable max (e.g., 1000)

- [ ] **Step 1: Add validation to `available/route.ts`**

After parsing `before_pick_n`, add:
```typescript
if (beforePickN < 1) {
  return NextResponse.json({ error: "before_pick_n must be positive" }, { status: 400 });
}
```

- [ ] **Step 2: Cap `limit` in `ranked/route.ts`**

```typescript
const limit = Math.min(Number(searchParams.get("limit")) || 50, 1000);
```

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Add bounds checking to available cards API parameters
```

---

## Chunk 3: Performance

### Task 12: Resolve card once in `getCardStats`

**Files:**
- Modify: `src/core/db/queries/stats.ts` — resolve card at top, pass `card_id` to sub-functions
- May need to modify: `src/core/db/queries/cards.ts` if `resolveCard` needs to return `card_id`
- May need to modify: `src/core/db/queries/decklists.ts` — accept `card_id` parameter

- [ ] **Step 1: Check current `resolveCard` return type**

Read `src/core/db/queries/cards.ts` to see what `resolveCard` returns.

- [ ] **Step 2: Refactor `getCardStats` to resolve once**

At the top of `getCardStats`, call `resolveCard` once. Pass the `card_id` to `getCardPickStats`, `getCardWinStats`, and `getCardPlayStats` as an optional parameter so they can skip their own resolution.

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Resolve card once in getCardStats to eliminate redundant DB lookups
```

---

### Task 13: Batch `insertNewPicks` to avoid N+1 pattern

**Files:**
- Modify: `src/core/sync.ts` — batch card name resolution and pick insertion

- [ ] **Step 1: Batch-resolve card names**

**Note:** SQLite has a default limit of 999 parameters per query. In practice, sync batches are small (1-10 picks from polling, max ~450 for initial ingestion). A cube has ~540 unique cards, so the IN clause will have at most ~450 placeholders — safely under the limit. If this ever becomes a concern, chunk into batches of 500.

```typescript
// Collect unique card names
const uniqueNames = [...new Set(newPicks.map((p) => normalizeCardName(p.cardName)))];

// Resolve all at once
const placeholders = uniqueNames.map(() => "?").join(", ");
const result = await client.execute({
  sql: `SELECT card_id, name FROM cards WHERE LOWER(name) IN (${placeholders})`,
  args: uniqueNames.map((n) => n.toLowerCase()),
});
const nameToId = new Map<string, number>();
for (const row of result.rows) {
  nameToId.set((row.name as string).toLowerCase(), row.card_id as number);
}
```

- [ ] **Step 2: Batch-insert picks using `client.batch()`**

```typescript
const statements = newPicks
  .filter((pick) => nameToId.has(normalizeCardName(pick.cardName).toLowerCase()))
  .map((pick) => ({
    sql: "INSERT OR IGNORE INTO pick_events (draft_id, pick_n, seat, card_id) VALUES (?, ?, ?, ?)",
    args: [draftId, pick.pickPosition, pick.seat + 1, nameToId.get(normalizeCardName(pick.cardName).toLowerCase())!],
  }));
await client.batch(statements);
```

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Batch card resolution and pick insertion in sync to eliminate N+1 queries
```

---

## Chunk 4: Architecture Cleanup

### Task 14: Move `fetchDraftFromSheet` import path

The sync API route imports from `build/` but uses it at runtime. Move the import or relocate the function.

**Files:**
- Modify: `src/app/api/sync/route.ts` — update import path
- Possibly move: `src/build/sheets.ts` → extract the `fetchDraftFromSheet` function to `src/core/sheets.ts`

- [ ] **Step 1: Evaluate the right approach**

Check if `fetchDraftFromSheet` depends on other `build/` module code. If it's self-contained, extract just that function to `src/core/sheets.ts`. If it's tangled with build-time code, create a re-export.

- [ ] **Step 2: Move or re-export the function**

- [ ] **Step 3: Update the import in `sync/route.ts`**

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Move fetchDraftFromSheet to core module (runtime code, not build-time)
```

---

### Task 15: Add consistent Cache-Control headers to REST API routes

**Files:**
- Modify: All REST API routes under `src/app/api/drafts/` and `src/app/api/cards/stats/` and `src/app/api/stats/`

- [ ] **Step 1: Determine appropriate cache durations**

- REST routes serving draft data: `s-maxage=60` (1 minute, data changes slowly)
- Card stats: `s-maxage=300` (5 minutes)
- Keep existing immutable caching on `/api/cards` and `/api/draft-stats`

- [ ] **Step 2: Add headers to each route's GET handler response**

Use a helper or add inline:
```typescript
return NextResponse.json(data, {
  headers: { "Cache-Control": "public, s-maxage=60" },
});
```

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Add Cache-Control headers to REST API routes
```

---

## Chunk 5: Test Quality

### Task 16: Add unit tests for `calculatePickWeight` and `weightedGeometricMean`

**Files:**
- Modify: `src/core/utils.test.ts` — add comprehensive tests

- [ ] **Step 1: Write tests for `calculatePickWeight`**

```typescript
describe("calculatePickWeight", () => {
  it("returns 1 for first copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 1, wasPicked: true })).toBe(1);
  });
  it("returns 0.5 for first copy that was not picked", () => {
    expect(calculatePickWeight({ copyNumber: 1, wasPicked: false })).toBe(0.5);
  });
  it("returns 0.5 for second copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 2, wasPicked: true })).toBe(0.5);
  });
  it("returns 0.25 for second copy that was not picked", () => {
    expect(calculatePickWeight({ copyNumber: 2, wasPicked: false })).toBe(0.25);
  });
  it("returns 0.25 for third copy that was picked", () => {
    expect(calculatePickWeight({ copyNumber: 3, wasPicked: true })).toBe(0.25);
  });
});
```

- [ ] **Step 2: Write tests for `weightedGeometricMean`**

```typescript
describe("weightedGeometricMean", () => {
  it("returns 0 for empty input", () => {
    expect(weightedGeometricMean([])).toBe(0);
  });
  it("returns the value for a single item with weight 1", () => {
    expect(weightedGeometricMean([{ weight: 1, value: 10 }])).toBe(10);
  });
  it("filters out items with value <= 0", () => {
    expect(weightedGeometricMean([
      { weight: 1, value: 10 },
      { weight: 1, value: 0 },
    ])).toBe(10);
  });
  it("computes correct weighted geometric mean", () => {
    // Two items with equal weight: geomean = sqrt(a * b)
    const result = weightedGeometricMean([
      { weight: 1, value: 4 },
      { weight: 1, value: 16 },
    ]);
    expect(result).toBeCloseTo(8, 5);
  });
  it("applies weights correctly", () => {
    // Weight 2 on value 4, weight 1 on value 16:
    // exp((2*ln(4) + 1*ln(16)) / 3) = exp((2*1.386 + 2.773) / 3) = exp(1.848) ≈ 6.349
    const result = weightedGeometricMean([
      { weight: 2, value: 4 },
      { weight: 1, value: 16 },
    ]);
    expect(result).toBeCloseTo(6.3496, 3);
  });
});
```

- [ ] **Step 3: Run tests and verify**

- [ ] **Step 4: Commit**

```
Add unit tests for calculatePickWeight and weightedGeometricMean
```

---

### Task 17: Fix `getDraftStats` test that doesn't test what it claims

**Files:**
- Modify: `src/core/getDraftStats.test.ts`

- [ ] **Step 1: Read the current test to understand what it's trying to do**

- [ ] **Step 2: Either fix the test to actually test draft ID filtering, or rename it to match what it actually tests**

If the test can't work without a live Turso connection, mark it as `skipIf(!hasTurso)` with a clear description.

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Fix getDraftStats test to match its description
```

---

### Task 18: Improve API route tests to verify response shape

**Files:**
- Modify: `src/app/api/drafts/[id]/standings/route.test.ts`
- Modify: `src/app/api/drafts/[id]/picks/route.test.ts`
- Modify: `src/app/api/cards/stats/route.test.ts`
- Modify: Other shallow route tests

- [ ] **Step 1: For each route test, add assertions on response body structure**

Example for `cards/stats/route.test.ts`:
```typescript
const body = await response.json();
expect(body).toHaveProperty("card_name");
expect(body).toHaveProperty("pick");
expect(body).toHaveProperty("wins");
```

- [ ] **Step 2: Add at least one error handling test per route**

Test what happens when the mocked query function throws. Verify the route returns 500 with an error message.

- [ ] **Step 3: Run `pnpm precommit` and verify**

- [ ] **Step 4: Commit**

```
Add response shape and error handling assertions to API route tests
```

---

### Task 19: Add tests for `optOuts.ts`

**Files:**
- Create: `src/core/optOuts.test.ts`

- [ ] **Step 0: Read `src/core/optOuts.ts` to confirm function signatures**

Verify `isOptedOut` takes `(drafterName: string, optOutNames: Set<string>)` and `loadOptOutNames` returns `Set<string>`.

- [ ] **Step 1: Write tests**

```typescript
describe("isOptedOut", () => {
  it("returns true for opted-out name (case insensitive)", () => {
    const optOuts = new Set(["alice"]);
    expect(isOptedOut("Alice", optOuts)).toBe(true);
    expect(isOptedOut("ALICE", optOuts)).toBe(true);
  });
  it("returns false for non-opted-out name", () => {
    const optOuts = new Set(["alice"]);
    expect(isOptedOut("Bob", optOuts)).toBe(false);
  });
  it("returns false for empty opt-out set", () => {
    expect(isOptedOut("Alice", new Set())).toBe(false);
  });
});

describe("loadOptOutNames", () => {
  it("returns empty set when file does not exist", () => {
    // mock existsSync to return false
    expect(loadOptOutNames().size).toBe(0);
  });
});
```

- [ ] **Step 2: Run `pnpm precommit` and verify**

- [ ] **Step 3: Commit**

```
Add unit tests for opt-out privacy functions
```

---

### Task 20: Add tests for sync module functions

**Files:**
- Modify: `src/core/__tests__/sync.test.ts` — add tests for untested exports

- [ ] **Step 1: Add tests for `resolveCardNameToId`**

Mock the client, verify it queries with LOWER() and returns the card_id.

- [ ] **Step 2: Add tests for `insertNewPicks`**

After Task 13 refactors this to batch, test the batch version instead. Mock the client, verify the batch call contains the right statements.

- [ ] **Step 3: Add tests for `isRateLimited`**

Mock client.execute to return a recent timestamp → should be rate limited.
Mock client.execute to return an old timestamp → should not be rate limited.
Mock client.execute to return no rows → should not be rate limited.

- [ ] **Step 4: Run `pnpm precommit` and verify**

- [ ] **Step 5: Commit**

```
Add unit tests for sync module: resolveCardNameToId, insertNewPicks, isRateLimited
```

---

## Task Dependencies

```
Task 1 (wilsonInterval + round3) ──→ Task 8 (round3 replacement across codebase)
Task 13 (batch inserts) ──→ Task 20 (sync tests)
Tasks 2-7 are independent of each other
Tasks 9-11 are independent (security)
Tasks 12-13 are independent (performance)
Tasks 14-15 are independent (architecture)
Tasks 16-19 are independent (tests)
```

**Parallelization:** Tasks 1-7 can largely run in parallel (Task 8 waits for Task 1). Tasks 9-15 can run in parallel. Tasks 16-20 can run in parallel (Task 20 after Task 13).
