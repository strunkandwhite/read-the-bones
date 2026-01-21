# Player Anonymization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove player identity from the application to address privacy concerns - players identified by seat number only, no cross-draft identity.

**Architecture:** Remove top player feature entirely, replace player_id with seat in database schema, add opt-out table for LLM queries. Affects web app, CLI, database, and LLM layers.

**Tech Stack:** TypeScript, Next.js, Turso (SQLite), Vitest

---

## Phase 1: Remove Top Player Feature from Web App

### Task 1: Remove Top Player Props from Settings Component

**Files:**
- Modify: `src/app/components/Settings.tsx`

**Step 1: Remove player-related props from SettingsProps interface**

```typescript
// In src/app/components/Settings.tsx, change lines 6-24 to:
export interface SettingsProps {
  // Draft selection
  drafts: Array<{ id: string; name: string; date: string }>;
  selectedDrafts: Set<string>;
  onDraftsChange: (selected: Set<string>) => void;
  isDraftDataLoading?: boolean;
  // Win equity visibility
  showWinEquity: boolean;
  onToggleWinEquity: (enabled: boolean) => void;
  // Raw win rate visibility
  showRawWinRate: boolean;
  onToggleRawWinRate: (enabled: boolean) => void;
}
```

**Step 2: Remove player-related destructuring and handlers**

Remove from function parameters (lines 26-39):
- `players`
- `topPlayers`
- `onPlayersChange`
- `useTopPlayerWeighting`
- `onToggleWeighting`

Remove these functions (lines 72-81):
- `togglePlayer`
- `selectAllPlayers`
- `selectNoPlayers`

**Step 3: Remove Top Players UI section**

Remove lines 157-218 (the entire "Top Players" section including checkboxes and weighting toggle).

**Step 4: Run tests to verify no regressions**

Run: `pnpm test`
Expected: Tests pass (Settings component has no unit tests currently)

**Step 5: Commit**

```bash
git add src/app/components/Settings.tsx
git commit -m "refactor(Settings): remove top player selection UI"
```

---

### Task 2: Remove Top Player State from PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx`

**Step 1: Remove storage keys and imports**

Remove lines 16-17:
```typescript
const STORAGE_KEY_TOP_PLAYERS = "rtb-top-players";
const STORAGE_KEY_USE_WEIGHTING = "rtb-use-top-weighting";
```

**Step 2: Remove initialPlayers from PageClientProps**

Change interface (lines 21-29) - remove `initialPlayers`:
```typescript
export interface PageClientProps {
  initialCards: EnrichedCardStats[];
  draftCount: number;
  currentCubeCopies: Record<string, number>;
  draftIds: string[];
  draftMetadata: Record<string, { name: string; date: string }>;
  scryfallData: Record<string, ScryCard>;
}
```

**Step 3: Remove player state variables**

Remove from function body:
- `storedTopPlayers` state (lines 64-67)
- `useTopPlayerWeighting` state (lines 68-71)
- `topPlayers` derived value (line 85)

**Step 4: Update calculateCardStats calls**

Change line 137 from:
```typescript
const stats = calculateCardStats(filteredPicks, topPlayers, metadataMap);
```
to:
```typescript
const stats = calculateCardStats(filteredPicks, metadataMap);
```

**Step 5: Remove player handlers**

Remove `handleTopPlayersChange` (lines 228-234) and `handleWeightingToggle` (lines 237-242).

**Step 6: Update Settings component props**

Remove from Settings props (around line 338-352):
- `players={initialPlayers}`
- `topPlayers={topPlayers}`
- `onPlayersChange={handleTopPlayersChange}`
- `useTopPlayerWeighting={useTopPlayerWeighting}`
- `onToggleWeighting={handleWeightingToggle}`

**Step 7: Update CardTable props**

Change line 487 from:
```typescript
useTopPlayerWeighting={useTopPlayerWeighting && topPlayers.length > 0}
```
to remove entirely (CardTable will need updating too).

**Step 8: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "refactor(PageClient): remove top player state management"
```

---

### Task 3: Remove Top Player Column from CardTable

**Files:**
- Modify: `src/app/components/CardTable.tsx`

**Step 1: Read current file**

Read the file to understand current structure.

**Step 2: Remove useTopPlayerWeighting prop**

Remove from CardTableProps interface and function parameters.

**Step 3: Remove top player geomean column**

Remove any column/cell that displays `topPlayerGeomean` or conditionally shows based on `useTopPlayerWeighting`.

**Step 4: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "refactor(CardTable): remove top player weighting column"
```

---

### Task 4: Remove topPlayerGeomean from CardStats Type

**Files:**
- Modify: `src/core/types.ts`

**Step 1: Remove topPlayerGeomean field**

Remove line 75:
```typescript
/** Geomean using only top player picks (when toggle enabled) */
topPlayerGeomean: number;
```

**Step 2: Remove PlayerConfig type**

Remove lines 122-130:
```typescript
/**
 * Configuration for player-based filtering and weighting.
 */
export type PlayerConfig = {
  /** All unique player names found across drafts */
  knownPlayers: string[];
  /** User-selected top players (persisted to localStorage) */
  topPlayers: string[];
};
```

**Step 3: Remove drafterName from CardPick**

Remove line 60:
```typescript
/** Name of the player who made this pick */
drafterName: string;
```

**Step 4: Update MatchResult type to use seats**

Change lines 168-173:
```typescript
export type MatchResult = {
  seat1: number;
  seat2: number;
  seat1GamesWon: number;
  seat2GamesWon: number;
};
```

**Step 5: Run tests to see what breaks**

Run: `pnpm test`
Expected: Multiple failures due to type changes - this is expected and will guide next steps.

**Step 6: Commit**

```bash
git add src/core/types.ts
git commit -m "refactor(types): remove player identity fields, add seat-based match results"
```

---

### Task 5: Remove Top Player Logic from calculateStats

**Files:**
- Modify: `src/core/calculateStats.ts`
- Modify: `src/core/calculateStats.test.ts`

**Step 1: Remove topPlayers parameter from calculateWeight**

Change function signature (around line 33-36):
```typescript
function calculateWeight(pick: CardPick): number {
  return calculatePickWeight({
    copyNumber: pick.copyNumber,
    wasPicked: pick.wasPicked,
  });
}
```

**Step 2: Remove topPlayers from calculateSingleCardStats**

Remove `topPlayersSet` parameter and `topPlayerGeomean` calculation.

**Step 3: Remove topPlayers from calculateCardStats**

Change signature from:
```typescript
export function calculateCardStats(
  picks: CardPick[],
  topPlayers: string[],
  draftMetadata: Map<string, DraftMetadata> = new Map()
): CardStats[]
```
to:
```typescript
export function calculateCardStats(
  picks: CardPick[],
  draftMetadata: Map<string, DraftMetadata> = new Map()
): CardStats[]
```

**Step 4: Remove extractPlayers function**

Remove the entire `extractPlayers` function and its export.

**Step 5: Update tests**

Update `calculateStats.test.ts` to:
- Remove `extractPlayers` tests
- Remove `topPlayers` parameter from `calculateCardStats` calls
- Remove `drafterName` from test data CardPick objects
- Remove assertions on `topPlayerGeomean`

**Step 6: Run tests**

Run: `pnpm test src/core/calculateStats.test.ts`
Expected: All tests pass

**Step 7: Commit**

```bash
git add src/core/calculateStats.ts src/core/calculateStats.test.ts
git commit -m "refactor(calculateStats): remove top player weighting logic"
```

---

### Task 6: Simplify calculatePickWeight in utils

**Files:**
- Modify: `src/core/utils.ts`

**Step 1: Remove top player parameters**

Change function (lines 15-30) to:
```typescript
export function calculatePickWeight(params: {
  copyNumber: number;
  wasPicked: boolean;
}): number {
  const { copyNumber, wasPicked } = params;

  const copyWeight = Math.pow(0.5, copyNumber - 1);
  const unpickedWeight = wasPicked ? 1 : 0.5;

  return copyWeight * unpickedWeight;
}
```

**Step 2: Run tests**

Run: `pnpm test`
Expected: Tests pass

**Step 3: Commit**

```bash
git add src/core/utils.ts
git commit -m "refactor(utils): simplify calculatePickWeight, remove player params"
```

---

### Task 7: Update Data Loaders

**Files:**
- Modify: `src/build/tursoDataLoader.ts`

**Step 1: Remove topPlayers parameter from loadCardDataFromTurso**

Change signature (around line 371):
```typescript
export async function loadCardDataFromTurso(): Promise<{
  cards: EnrichedCardStats[];
  draftCount: number;
  currentCubeCards: string[];
  currentCubeCopies: Record<string, number>;
  draftIds: string[];
  draftMetadata: Record<string, { name: string; date: string; numDrafters?: number }>;
  scryfallData: Record<string, ScryCard>;
}>
```

**Step 2: Remove players from return value**

Remove `players` field from return object and the `extractPlayers` call.

**Step 3: Update calculateCardStats call**

Remove `topPlayers` argument from the call.

**Step 4: Remove drafterName from CardPick construction**

When building CardPick objects, remove the `drafterName` field.

**Step 5: Run tests**

Run: `pnpm test`
Expected: Tests pass

**Step 6: Commit**

```bash
git add src/build/tursoDataLoader.ts
git commit -m "refactor(tursoDataLoader): remove player extraction and top player params"
```

---

### Task 8: Update Page Server Component

**Files:**
- Modify: `src/app/page.tsx`

**Step 1: Remove initialPlayers from PageClient props**

The page.tsx server component calls `loadCardDataFromTurso` and passes data to PageClient. Update to remove `players`/`initialPlayers`.

**Step 2: Commit**

```bash
git add src/app/page.tsx
git commit -m "refactor(page): remove player data from server component"
```

---

### Task 9: Full Test Suite Verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 2: Build the app**

Run: `pnpm build`
Expected: Build succeeds with no type errors

**Step 3: Commit any final fixes**

```bash
git add -A
git commit -m "fix: resolve remaining type errors from top player removal"
```

---

## Phase 2: Remove Player Aliases & Hardcoded Names

### Task 10: Remove PLAYER_ALIASES from parseCsv

**Files:**
- Modify: `src/core/parseCsv.ts`
- Modify: `src/core/parseCsv.test.ts`

**Step 1: Remove PLAYER_ALIASES constant**

Delete the entire `PLAYER_ALIASES` object (lines 17-27).

**Step 2: Remove normalizePlayerName function**

Delete the function and its export.

**Step 3: Remove buildPlayerNameMap function**

Delete the function and its export.

**Step 4: Update tests**

Remove tests for the deleted functions.

**Step 5: Run tests**

Run: `pnpm test src/core/parseCsv.test.ts`
Expected: Pass

**Step 6: Commit**

```bash
git add src/core/parseCsv.ts src/core/parseCsv.test.ts
git commit -m "refactor(parseCsv): remove PLAYER_ALIASES and player normalization"
```

---

### Task 11: Remove TOP_PLAYERS from CLI

**Files:**
- Modify: `src/cli/promptBuilder.ts`

**Step 1: Remove TOP_PLAYERS constant**

Delete line 28:
```typescript
export const TOP_PLAYERS = ["Aspi", "Neo", "arborist77"];
```

**Step 2: Remove player dictionary imports and usage**

Remove imports of `formatPlayerDict`, `encodePlayer` from cardCodes.ts and any usage.

**Step 3: Run tests**

Run: `pnpm test`
Expected: Failures in cardCodes tests (expected)

**Step 4: Commit**

```bash
git add src/cli/promptBuilder.ts
git commit -m "refactor(cli): remove TOP_PLAYERS constant and player encoding"
```

---

### Task 12: Remove Player Encoding from cardCodes

**Files:**
- Modify: `src/cli/cardCodes.ts`
- Modify: `src/cli/cardCodes.test.ts`

**Step 1: Remove player encoding functions**

Delete:
- `normalizePlayerNameForDict`
- `buildPlayerDictionary`
- `formatPlayerDict`
- `encodePlayer`

**Step 2: Remove PLAYER_ALIASES import**

Remove the import from parseCsv.

**Step 3: Update tests**

Remove player encoding tests from `cardCodes.test.ts`.

**Step 4: Run tests**

Run: `pnpm test src/cli/cardCodes.test.ts`
Expected: Pass

**Step 5: Commit**

```bash
git add src/cli/cardCodes.ts src/cli/cardCodes.test.ts
git commit -m "refactor(cardCodes): remove player encoding functions"
```

---

## Phase 3-8: Database & LLM Changes

*The remaining phases involve database schema changes, LLM tool updates, and CLI refactoring. These will be detailed in a follow-up plan after Phase 1-2 are complete, as they depend on the clean baseline established by removing top player functionality.*

**Remaining high-level tasks:**
- Phase 3: Database schema migration (player_id → seat)
- Phase 4: LLM query/tool updates
- Phase 5: CLI refactoring (DraftState to use seats)
- Phase 6: Test updates
- Phase 7: Git history cleanup
- Phase 8: End-to-end verification

---

## Execution Notes

- Run `pnpm test` after each task to catch regressions early
- Run `pnpm build` periodically to catch type errors
- Commit frequently with descriptive messages
- If a task reveals additional changes needed, add them to the current task rather than creating tech debt
