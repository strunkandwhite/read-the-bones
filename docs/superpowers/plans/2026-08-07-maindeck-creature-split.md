# Maindeck Creature / Non-Creature Split — Implementation Plan

**Goal:** Split the deck builder's maindeck into a creature row and a non-creature row over the same mana-value columns. Non-creatures default to the bottom row; anything the user moves stays put. Works for live drafts (DB), sheet drafts (localStorage), and shared snapshots.

**Architecture:** The row is encoded in the column key (`nc-` prefix) rather than in a new nesting level, so `DeckState`, `ColumnMap`, the drag-id grammar, and the DB schema are all unchanged. Structural key normalization stays in `migrateDeckState` (no card data); semantic row classification is a new one-shot `MIGRATE_ROWS` reducer action gated by `DeckState.version`. Spec: `docs/superpowers/specs/2026-08-07-maindeck-creature-split-design.md`.

**Tech Stack:** Next.js (App Router), Zustand (`subscribeWithSelector`), @dnd-kit, Vitest (jsdom for store/component tests), Playwright e2e.

## Global Constraints

- Repo root: `/Users/arpanet/code/read-the-bones`. **All git commands use `git -C /Users/arpanet/code/read-the-bones …` — never `cd … && git …`.**
- Commit co-author line (exact): `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Zero ESLint warnings (`pnpm lint`), typecheck clean (`pnpm typecheck`), knip clean (`pnpm knip`).
- **No DB schema change.** `decks.deck_state` stays a JSON blob.
- Column keys (exact): base `mv-0-1`, `mv-2`, `mv-3`, `mv-4`, `mv-5`, `mv-6+`, `lands`; non-creature = the same seven prefixed `nc-`. The prefix separator is a **hyphen** — a colon would break `parseDragId`.
- The sideboard is **not** split. It keeps the seven base keys only.
- `DECK_STATE_VERSION = 1`.
- Store test files need the `// @vitest-environment jsdom` pragma on line 1 (see `src/app/stores/liveStore.test.ts`).
- Comments follow repo style: only for non-obvious decisions, and readable by someone with no knowledge of this change.

---

### Task 1: Core — column key vocabulary, classifiers, and structural migration

**Files:**
- Modify: `src/core/types.ts` (`DeckState`)
- Modify: `src/core/deckBuilder.ts` (top half: keys, classifiers, `createEmptyColumnMap`, `createEmptyDeckState`, `migrateDeckState`)
- Test: `src/core/deckBuilder.test.ts`

**Interfaces produced** (consumed by Tasks 2–5):

```ts
export const BASE_COLUMN_KEYS: readonly ColumnKey[]          // the existing seven — rename of COLUMN_KEYS
export const NONCREATURE_COLUMN_KEYS: readonly NoncreatureColumnKey[]
export const DECK_COLUMN_KEYS: readonly DeckColumnKey[]      // [...BASE, ...NONCREATURE]
export const DECK_STATE_VERSION = 1

export type ColumnKey            // base seven
export type NoncreatureColumnKey // `nc-${ColumnKey}`
export type DeckColumnKey        // ColumnKey | NoncreatureColumnKey

export function columnKeysForZone(zone: "deck" | "sideboard"): readonly DeckColumnKey[]
export function isCreatureCard(scry: ScryCard): boolean
export function getDeckColumnKey(scry: ScryCard): DeckColumnKey  // row-aware placement
export function toNoncreatureColumnKey(key: ColumnKey): NoncreatureColumnKey
export function toBaseColumnKey(key: string): ColumnKey | null   // strips `nc-`; null if unrecognized
export function createEmptyColumnMap(zone: "deck" | "sideboard"): ColumnMap  // now zone-aware
```

`getColumnKey` keeps its current signature and behaviour (base key only).
`COLUMN_KEYS` is **renamed** to `BASE_COLUMN_KEYS` — update its two importers (`validateDeckState.ts`, `DeckZone.tsx`) in Tasks 3 and 5; leave them broken at the end of this task only if the intermediate state still typechecks, otherwise do the mechanical rename in those files here.

`DeckState` gains `version?: number`.

- [x] **Step 1: Write the failing tests**

In `src/core/deckBuilder.test.ts`, add:

```ts
describe("getDeckColumnKey", () => {
  it("puts creatures in the base row", () => { /* typeLine "Creature — Human Wizard", mv 2 → "mv-2" */ });
  it("puts non-creatures in the nc row", () => { /* "Instant", mv 1 → "nc-mv-0-1" */ });
  it("puts lands in nc-lands", () => { /* "Land" → "nc-lands" */ });
  it("puts creature-lands in the creature row's lands column", () => { /* "Land Creature — Dryad" → "lands" */ });
  it("treats artifact creatures as creatures", () => { /* "Artifact Creature — Golem", mv 4 → "mv-4" */ });
});

describe("createEmptyColumnMap", () => {
  it("gives the deck zone all 14 keys", () => {});
  it("gives the sideboard the 7 base keys only", () => {});
});

describe("createEmptyDeckState", () => {
  it("stamps the current DECK_STATE_VERSION", () => {});
  it("builds a 14-key deck zone and a 7-key sideboard", () => {});
});

describe("migrateDeckState — row-aware keys", () => {
  it("adds the missing nc-* columns to a pre-split deck zone without moving cards", () => {});
  it("leaves version untouched", () => { /* undefined in → undefined out */ });
  it("preserves an already-canonical split state by reference", () => {});
  it("renames legacy cmc-* keys in the deck zone", () => {});
  it("merges an nc-* key found in the sideboard into its base column", () => {});
  it("relocates an unrecognized key to mv-0-1", () => {});
});
```

Also update the existing `migrateDeckState` / `createEmptyDeckState` assertions that hard-code seven deck-zone keys.

- [x] **Step 2: Run tests to verify they fail**

`pnpm test src/core/deckBuilder.test.ts` — expect failures for every new case.

- [x] **Step 3: Implement**

In `src/core/deckBuilder.ts`:

- Rename `COLUMN_KEYS` → `BASE_COLUMN_KEYS`; derive `NONCREATURE_COLUMN_KEYS` from it (`\`nc-${k}\``) and `DECK_COLUMN_KEYS` from both.
- Add `NONCREATURE_PREFIX = "nc-"` (module-private is fine), `toNoncreatureColumnKey`, `toBaseColumnKey`, `columnKeysForZone`.
- Add `isCreatureCard` and `getDeckColumnKey` next to `getColumnKey`. Document in a short comment *why* the row is a separate decision from the column (a creature-land is a creature that lives in the lands column).
- `createEmptyColumnMap(zone)` builds from `columnKeysForZone(zone)`.
- `createEmptyDeckState` uses the zone-aware map and sets `version: DECK_STATE_VERSION`.
- `migrateDeckState`: make `isCanonical` and `normalizeZone` take the zone's key list. In `normalizeZone` for the **sideboard**, an `nc-*` key resolves via `toBaseColumnKey` before the unknown-key fallback. Preserve `version` (the existing `...cleaned` spread already does; add a test, not code).

- [x] **Step 4: Verify**

`pnpm test src/core/deckBuilder.test.ts && pnpm typecheck`

---

### Task 2: Core — reducer row handling (`MIGRATE_ROWS`, REBUILD, CLEAR_DECK, SET_BASICS)

*Depends on Task 1. Runs in parallel with Task 3.*

**Files:**
- Modify: `src/core/deckBuilder.ts` (`DeckAction`, `deckReducer`)
- Test: `src/core/deckBuilder.test.ts`

**Interfaces produced:**

```ts
| { type: "MIGRATE_ROWS"; scryfallData: Map<string, ScryCard> }
```

Consumed by Task 4 (`makeSyncDeckWithPicks`).

- [x] **Step 1: Write the failing tests**

```ts
describe("deckReducer — MIGRATE_ROWS", () => {
  it("moves known non-creatures from base columns to the matching nc- column", () => {});
  it("preserves relative order within a column", () => {});
  it("leaves creatures in the base row", () => {});
  it("moves basic lands to nc-lands even though they have no Scryfall entry", () => {});
  it("leaves cards with no Scryfall data in place", () => {});
  it("does not touch the sideboard", () => {});
  it("sets version to DECK_STATE_VERSION", () => {});
  it("returns the same reference when version is already current", () => {});
  it("returns the same reference when the Scryfall map is empty", () => {});
});

describe("deckReducer — REBUILD row-aware placement", () => {
  it("adds a new non-creature to its nc- column", () => {});
  it("adds a new creature to its base column", () => {});
  it("leaves a non-creature the user moved to the creature row where it is", () => {});
});

describe("deckReducer — CLEAR_DECK", () => {
  it("moves nc- column cards to the sideboard's base column", () => {});
});

describe("deckReducer — SET_BASICS", () => {
  it("adds basics to nc-lands", () => {});
  it("clears pre-existing basics from both lands and nc-lands", () => {});
});
```

- [x] **Step 2: Run tests to verify they fail**

`pnpm test src/core/deckBuilder.test.ts`

- [x] **Step 3: Implement**

- `MIGRATE_ROWS`: guard on `state.version === DECK_STATE_VERSION` → return `state`; guard on `action.scryfallData.size === 0` → return `state`. Otherwise clone, and for each key in `BASE_COLUMN_KEYS` partition `zones.deck[key]` into stay-put (creatures, and cards with no Scryfall entry that are not basics) and move (`BASIC_LAND_NAMES` members, plus entries whose Scryfall data is non-creature), appending moved cards to `toNoncreatureColumnKey(key)`. Set `version`. Comment the empty-map guard — its reason (a deck loaded before card data would classify everything as a spell and then mark itself done) is not obvious from the code.
- `REBUILD` pass 2: replace `getColumnKey` with `getDeckColumnKey` (the fallback for missing Scryfall data stays `"mv-0-1"`). Pass 1 is untouched — that is what makes placement sticky.
- `CLEAR_DECK`: the sideboard target column is `toBaseColumnKey(col) ?? col`.
- `SET_BASICS`: strip basics from **both** `lands` and `nc-lands`; append the new basics to `nc-lands`.
- `MOVE_CARD` and `REORDER_CARD` need no changes.

- [x] **Step 4: Verify**

`pnpm test src/core/deckBuilder.test.ts && pnpm typecheck`

---

### Task 3: API — zone-aware deck state validation

*Depends on Task 1. Runs in parallel with Task 2.*

**Files:**
- Modify: `src/core/validateDeckState.ts`
- Test: `src/core/validateDeckState.test.ts`

Guards both `PUT /api/drafts/[id]/deck-state` and `POST /api/deck`. Neither route file changes.

- [x] **Step 1: Write the failing tests**

```ts
it("accepts nc-* columns in the deck zone", () => {});
it("rejects nc-* columns in the sideboard zone", () => {});   // would be unrenderable there
it("accepts a valid version field", () => {});
it("rejects a non-integer version", () => {});
it("rejects a negative version", () => {});
it("accepts a state with no version field", () => {});         // pre-split clients
it("still enforces the 100-card cap across both rows", () => {});
```

- [x] **Step 2: Run tests to verify they fail**

`pnpm test src/core/validateDeckState.test.ts`

- [x] **Step 3: Implement**

Replace the single `COLUMN_KEYS` membership check with a per-zone list from `columnKeysForZone(zoneName)`. Add the `version` check alongside the existing `basicLands` check. Keep the reason strings in the same style (server-log only).

- [x] **Step 4: Verify**

`pnpm test src/core/validateDeckState.test.ts && pnpm typecheck`

---

### Task 4: Store — dispatch the row migration

*Depends on Task 2. Runs in parallel with Task 5.*

**Files:**
- Modify: `src/app/stores/live/deckSave.ts` (`makeSyncDeckWithPicks`)
- Modify: `src/app/stores/liveStore.ts` (subscriptions block at the bottom)
- Modify: `src/app/stores/wiring.ts` (subscription list comment)
- Test: `src/app/stores/liveStore.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
describe("deck row migration", () => {
  it("dispatches MIGRATE_ROWS before REBUILD when the deck builder syncs", () => {});
  it("migrates rows but does not REBUILD while viewing a shared deck", () => {});
  it("does not mark the deck dirty when the state is already at the current version", () => {});
  it("persists the migration once for a pre-split deck", () => {});   // PUT fires
  it("re-runs the sync when scryfallDataMap arrives", () => {});
});
```

- [x] **Step 2: Run tests to verify they fail**

`pnpm test src/app/stores/liveStore.test.ts`

- [x] **Step 3: Implement**

In `makeSyncDeckWithPicks`, restructure the early return:

```ts
if (!deckBuilderActive || !deckReady) return;
dispatchDeck({ type: "MIGRATE_ROWS", scryfallData: scryfallDataMap });
if (viewingSharedDeck) return;   // snapshots are immutable — rows only, no rebuild
// … existing canonicalCards + REBUILD
```

`makeDispatchDeck` needs **no** change: a no-op `MIGRATE_ROWS` returns the same reference and short-circuits before `justHydrated`/dirty handling, and the existing `viewingSharedDeck` guard already blocks persistence in shared view.

In `liveStore.ts`, add a subscription mirroring the existing ones:

```ts
// Rebuild once card data lands — a deck opened before Scryfall data arrives
// cannot be classified into creature/non-creature rows yet.
useCardStore.subscribe(
  (state) => state.scryfallDataMap,
  () => debouncedSyncDeckWithPicks(),
);
```

Add it to the numbered subscription list in `wiring.ts`'s header comment.

- [x] **Step 4: Verify**

`pnpm test src/app/stores && pnpm typecheck`

---

### Task 5: UI — two-row maindeck rendering

*Depends on Task 1. Runs in parallel with Task 4.*

**Files:**
- Modify: `src/app/components/deck-builder/DeckZone.tsx`
- Test: `src/app/components/deck-builder/DeckZone.test.tsx` (new; `// @vitest-environment jsdom`)

`DeckColumn.tsx`, `DeckCard.tsx`, and `DeckBuilderPanel.tsx` need no changes — drag ids, droppable ids, and `parseDragId` all survive the hyphenated prefix unchanged. Confirm this rather than assuming it.

- [x] **Step 1: Write the failing tests**

```ts
describe("DeckZone", () => {
  it("renders Creatures and Non-Creatures rows for the deck zone", () => {});
  it("renders one unlabeled grid for the sideboard", () => {});
  it("renders a card in an nc- column under the Non-Creatures row", () => {});
  it("counts every row's cards in the zone total", () => {});
  it("marks a floated card in an nc- column as floated", () => {});  // index scan covers all keys
});
```

- [x] **Step 2: Run tests to verify they fail**

`pnpm test src/app/components/deck-builder/DeckZone.test.tsx`

- [x] **Step 3: Implement**

- Replace the `COLUMN_KEYS` import with `columnKeysForZone` (plus `BASE_COLUMN_KEYS` / `NONCREATURE_COLUMN_KEYS`), and use `columnKeysForZone(zone)` in both instance-index scans and in `totalCards`.
- Derive the rows to render:

```ts
const rows = zone === "deck"
  ? [
      { label: "Creatures", keys: BASE_COLUMN_KEYS },
      { label: "Non-Creatures", keys: NONCREATURE_COLUMN_KEYS },
    ]
  : [{ label: null, keys: BASE_COLUMN_KEYS }];
```

- Render each row as the existing `grid-cols-7` block. For the deck zone, precede each grid with a row label + count in the muted small-caps style already used for column headers (`text-[11px]`, `text-zinc-500`), and separate the two grids with a hairline (`border-t border-zinc-800/60`), matching the existing zone divider in `DeckBuilderPanel`.
- Column labels come from `COLUMN_LABELS[toBaseColumnKey(key) ?? key]`, so the non-creature row reuses the same `0-1 / 2 / … / Lands` headers.
- The zone header (total, picked/floated/queued, `c·s·l`) is unchanged.

- [x] **Step 4: Verify**

`pnpm test src/app/components/deck-builder && pnpm lint`

---

### Task 6: Full verification

*Depends on Tasks 1–5.*

- [x] **Step 1:** `pnpm typecheck && pnpm lint && pnpm knip`
- [x] **Step 2:** `pnpm test`
- [x] **Step 3:** `pnpm test:e2e` — the deck-builder and shared-deck specs mock pre-split deck states (`e2e/flows/deck-builder.spec.ts` ~lines 87, 330; `e2e/fixtures/`). They must keep passing **through the migration path**, not by being rewritten to the new shape: that is the regression test for existing users' decks. If a spec asserts on layout that genuinely moved, update the assertion and say so.
- [x] **Step 4:** Update `CLAUDE.md` — add the spec and plan to the Superpowers lists, and extend the "Deck builder" bullet under Key Features with the maindeck split.
