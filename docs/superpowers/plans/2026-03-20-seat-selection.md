# Seat Selection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seat selection to the active draft filtering feature, allowing users to highlight a specific seat's picks in the card table.

**Architecture:** Replace `takenCardNames: string[]` with `takenCards: Array<{ name: string; seat: number }>` in the API response, extend `useDraftSelection` with seat state, update `useCardFiltering` to support seat-aware filtering, and add a seat dropdown + row accent styling.

**Tech Stack:** Next.js, React, TanStack Table, Turso (SQLite), Vitest, @testing-library/react

---

## Chunk 1: Data Layer

### Task 1: Server-side query change (`getCards.ts`)

**Files:**
- Modify: `src/core/getCards.ts:29-38` (type), `src/core/getCards.ts:464-472` (query)

- [ ] **Step 1: Update `CardStatsResponse` type**

Replace the `takenCardNames` field in the type definition:

```ts
// In CardStatsResponse (line 37)
// Before:
takenCardNames?: string[];
// After:
takenCards?: Array<{ name: string; seat: number }>;
```

- [ ] **Step 2: Update the taken cards query**

Change the query and mapping at lines 464-472:

```ts
// Before:
let takenCardNames: string[] | undefined;
if (params.activeDraft) {
  const takenResult = await client.execute({
    sql: `SELECT c.name FROM pick_events pe JOIN cards c ON pe.card_id = c.card_id WHERE pe.draft_id = ?`,
    args: [params.activeDraft],
  });
  takenCardNames = takenResult.rows.map((row) => row.name as string);
}

// After:
let takenCards: Array<{ name: string; seat: number }> | undefined;
if (params.activeDraft) {
  const takenResult = await client.execute({
    sql: `SELECT c.name, pe.seat FROM pick_events pe JOIN cards c ON pe.card_id = c.card_id WHERE pe.draft_id = ?`,
    args: [params.activeDraft],
  });
  takenCards = takenResult.rows.map((row) => ({
    name: row.name as string,
    seat: row.seat as number,
  }));
}
```

- [ ] **Step 3: Update the return object**

Change `takenCardNames` to `takenCards` in the return statement at line 495:

```ts
// Before:
takenCardNames,
// After:
takenCards,
```

- [ ] **Step 4: Run typecheck to find all broken consumers**

Run: `pnpm typecheck`
Expected: Type errors in `useCardFiltering.ts`, `useCardFiltering.test.ts`, `PageClient.test.tsx`, and the `/api/cards` route (since `takenCardNames` no longer exists on `CardStatsResponse`).

### Task 2: API route update (`/api/cards`)

**Files:**
- Modify: `src/app/api/cards/route.ts`

- [ ] **Step 1: Check the route for any `takenCardNames` references**

Read the file. The route passes through `getCards()` return value directly. If there are no explicit references to `takenCardNames` in the route handler, this may already work after Task 1. Confirm and move on.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: Route should be clean. Remaining errors should only be in client-side consumers.

### Task 3: Sync status endpoint change

**Files:**
- Modify: `src/core/sync.ts:267-273` (query function)
- Modify: `src/app/api/sync-status/route.ts` (response shape)
- Modify: `src/app/hooks/useSyncStatus.ts:5-9,21-24` (types)

- [ ] **Step 1: Update `getActiveDraftIds` to return objects with `numSeats`**

Rename the function and change its return type in `src/core/sync.ts`:

```ts
// Before (lines 267-273):
export async function getActiveDraftIds(client: Client): Promise<string[]> {
  const result = await client.execute({
    sql: `SELECT draft_id FROM drafts WHERE is_complete = 0`,
    args: [],
  });
  return result.rows.map((row) => row.draft_id as string);
}

// After:
export async function getActiveDraftInfo(
  client: Client
): Promise<Array<{ id: string; numSeats: number }>> {
  const result = await client.execute({
    sql: `SELECT draft_id, num_seats FROM drafts WHERE is_complete = 0`,
    args: [],
  });
  return result.rows.map((row) => ({
    id: row.draft_id as string,
    numSeats: (row.num_seats as number) || 10,
  }));
}
```

- [ ] **Step 2: Update sync-status route**

In `src/app/api/sync-status/route.ts`, change the import and response:

```ts
// Before:
import { getSyncStatus, getActiveDraftIds } from "@/core/sync";
// ...
const [syncStatus, activeDraftIds] = await Promise.all([
  getSyncStatus(client),
  getActiveDraftIds(client),
]);
return NextResponse.json({
  ...syncStatus,
  activeDraftIds,
});

// After:
import { getSyncStatus, getActiveDraftInfo } from "@/core/sync";
// ...
const [syncStatus, activeDrafts] = await Promise.all([
  getSyncStatus(client),
  getActiveDraftInfo(client),
]);
return NextResponse.json({
  ...syncStatus,
  activeDrafts,
});
```

- [ ] **Step 3: Update `useSyncStatus` types and state**

In `src/app/hooks/useSyncStatus.ts`:

```ts
// Before (lines 5-9):
type SyncStatusResponse = {
  lastSyncedAt: string;
  syncInProgress: boolean;
  activeDraftIds: string[];
};

// After:
type ActiveDraftInfo = { id: string; numSeats: number };

type SyncStatusResponse = {
  lastSyncedAt: string;
  syncInProgress: boolean;
  activeDrafts: ActiveDraftInfo[];
};
```

Update the initial state (line 21-25):

```ts
// Before:
const [status, setStatus] = useState<SyncStatusResponse>({
  lastSyncedAt: "0",
  syncInProgress: false,
  activeDraftIds: [],
});

// After:
const [status, setStatus] = useState<SyncStatusResponse>({
  lastSyncedAt: "0",
  syncInProgress: false,
  activeDrafts: [],
});
```

Export the `ActiveDraftInfo` type for use by consumers.

- [ ] **Step 4: Update all `activeDraftIds` references in consumers**

In `src/app/components/PageClient.tsx`, update references:

- Line 45: `syncStatus.activeDraftIds.includes(...)` → `syncStatus.activeDrafts.some(d => d.id === ...)`
- Line 134: `activeDraftIds={syncStatus.activeDraftIds}` → `activeDrafts={syncStatus.activeDrafts}`
- Line 275: `syncStatus.activeDraftIds.includes(...)` → `syncStatus.activeDrafts.some(d => d.id === ...)`

In `src/app/components/Settings.tsx`, update:

- Props type (line 13): `activeDraftIds: string[]` → `activeDrafts: ActiveDraftInfo[]`
- Line 128: `activeDraftIds.length > 0` → `activeDrafts.length > 0`
- Line 140-142: Map over `activeDrafts` using `d.id` as value and key

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: May still have errors in test files and `useCardFiltering` (from Task 1). The sync-status chain should be clean.

- [ ] **Step 6: Commit data layer changes**

```bash
git add src/core/getCards.ts src/core/sync.ts src/app/api/sync-status/route.ts src/app/hooks/useSyncStatus.ts src/app/components/PageClient.tsx src/app/components/Settings.tsx
git commit -m "Replace takenCardNames with takenCards, add numSeats to sync-status"
```

## Chunk 2: Client State & Filtering

### Task 4: Seat state in `useDraftSelection`

**Files:**
- Modify: `src/app/hooks/useDraftSelection.ts`
- Modify: `src/app/hooks/useDraftSelection.test.ts`

- [ ] **Step 1: Write failing tests for seat selection**

Add to `src/app/hooks/useDraftSelection.test.ts`:

```ts
it("initializes selectedSeat as null", () => {
  const { result } = renderHook(() =>
    useDraftSelection({ completedDraftIds: [] })
  );
  expect(result.current.selectedSeat).toBeNull();
});

it("persists selectedSeat per draft in localStorage", () => {
  const { result } = renderHook(() =>
    useDraftSelection({ completedDraftIds: [] })
  );

  act(() => {
    result.current.setActiveDraft("tarkir");
  });
  act(() => {
    result.current.setSelectedSeat(3);
  });

  const stored = JSON.parse(localStorage.getItem("selectedSeats")!);
  expect(stored).toEqual({ tarkir: 3 });
});

it("restores selectedSeat when switching back to a draft", () => {
  localStorage.setItem("selectedSeats", JSON.stringify({ tarkir: 5 }));
  localStorage.setItem("activeDraft", "tarkir");

  const { result } = renderHook(() =>
    useDraftSelection({ completedDraftIds: [] })
  );

  expect(result.current.selectedSeat).toBe(5);
});

it("clears selectedSeat when activeDraft is cleared", () => {
  const { result } = renderHook(() =>
    useDraftSelection({ completedDraftIds: [] })
  );

  act(() => {
    result.current.setActiveDraft("tarkir");
  });
  act(() => {
    result.current.setSelectedSeat(3);
  });
  act(() => {
    result.current.setActiveDraft(null);
  });

  expect(result.current.selectedSeat).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useDraftSelection.test.ts`
Expected: FAIL — `selectedSeat` and `setSelectedSeat` don't exist yet.

- [ ] **Step 3: Implement seat state in `useDraftSelection`**

Add to `src/app/hooks/useDraftSelection.ts`:

1. Add `selectedSeat: number | null` and `setSelectedSeat` to the return interface.
2. Add state: `const [selectedSeat, setSelectedSeatState] = useState<number | null>(null);`
3. On hydration (in the existing mount effect), read `localStorage.getItem("selectedSeats")`, parse as JSON, and if the active draft has a stored seat, set it.
4. Create a `setSelectedSeat` wrapper that:
   - Sets the state
   - Updates the `selectedSeats` map in localStorage for the current `activeDraft`
5. When `activeDraft` changes (in the existing persist effect or a new one):
   - If set to a new draft: look up stored seat from `selectedSeats` map, set `selectedSeat` to it (or null)
   - If cleared: set `selectedSeat` to null

- [ ] **Step 4: Run tests**

Run: `pnpm test src/app/hooks/useDraftSelection.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useDraftSelection.ts src/app/hooks/useDraftSelection.test.ts
git commit -m "Add per-draft seat selection state to useDraftSelection"
```

### Task 5: Seat-aware filtering in `useCardFiltering`

**Files:**
- Modify: `src/app/hooks/useCardFiltering.ts`
- Modify: `src/app/hooks/useCardFiltering.test.ts`

- [ ] **Step 1: Write failing tests**

Update existing tests that reference `takenCardNames` to use `takenCards`, then add seat-aware tests:

```ts
// Update makeCardData helper — replace takenCardNames with takenCards:
// In existing tests, change e.g.:
//   takenCardNames: ["Lightning Bolt"]
// to:
//   takenCards: [{ name: "Lightning Bolt", seat: 1 }]

// New tests:

it("does NOT hide selected seat's cards when hideTaken is true", () => {
  const cardData = makeCardData({
    takenCards: [
      { name: "Lightning Bolt", seat: 1 },
      { name: "Counterspell", seat: 2 },
    ],
  });

  const { result } = renderHook(() =>
    useCardFiltering({
      cardData,
      activeDraft: "draft-1",
      hideTaken: true,
      selectedSeat: 1,
      searchQuery: "",
      scryfallMatchNames: null,
    })
  );

  const names = result.current.displayCards.map((c) => c.cardName);
  expect(names).toContain("Lightning Bolt"); // seat 1's pick, kept
  expect(names).not.toContain("Counterspell"); // seat 2's pick, hidden
  expect(names).toContain("Swords to Plowshares"); // available
});

it("returns seatCardNames for selected seat", () => {
  const cardData = makeCardData({
    takenCards: [
      { name: "Lightning Bolt", seat: 1 },
      { name: "Counterspell", seat: 2 },
    ],
  });

  const { result } = renderHook(() =>
    useCardFiltering({
      cardData,
      activeDraft: "draft-1",
      hideTaken: false,
      selectedSeat: 1,
      searchQuery: "",
      scryfallMatchNames: null,
    })
  );

  expect(result.current.seatCardNames).toBeDefined();
  expect(result.current.seatCardNames!.has("Lightning Bolt")).toBe(true);
  expect(result.current.seatCardNames!.has("Counterspell")).toBe(false);
});

it("returns undefined seatCardNames when no seat selected", () => {
  const cardData = makeCardData({
    takenCards: [{ name: "Lightning Bolt", seat: 1 }],
  });

  const { result } = renderHook(() =>
    useCardFiltering({
      cardData,
      activeDraft: "draft-1",
      hideTaken: false,
      selectedSeat: null,
      searchQuery: "",
      scryfallMatchNames: null,
    })
  );

  expect(result.current.seatCardNames).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/hooks/useCardFiltering.test.ts`
Expected: FAIL — `selectedSeat` prop doesn't exist, `seatCardNames` not returned.

- [ ] **Step 3: Implement seat-aware filtering**

In `src/app/hooks/useCardFiltering.ts`:

1. Add `selectedSeat: number | null` to `UseCardFilteringProps`.
2. Add `seatCardNames: Set<string> | undefined` to `UseCardFilteringReturn`.
3. Replace the `takenCardNamesSet` memo to derive from `takenCards`:

```ts
const takenCardNamesSet = useMemo(() => {
  if (!activeDraft || !cardData.takenCards) return undefined;
  return new Set(cardData.takenCards.map((c) => c.name));
}, [activeDraft, cardData.takenCards]);
```

4. Add `seatCardNames` memo:

```ts
const seatCardNames = useMemo(() => {
  if (!activeDraft || !cardData.takenCards || selectedSeat === null) return undefined;
  return new Set(
    cardData.takenCards
      .filter((c) => c.seat === selectedSeat)
      .map((c) => c.name)
  );
}, [activeDraft, cardData.takenCards, selectedSeat]);
```

5. Update the `displayCards` filter to exempt the selected seat's cards:

```ts
if (activeDraft && takenCardNamesSet && hideTaken) {
  cards = cards.filter(
    (c) => !takenCardNamesSet.has(c.cardName) || seatCardNames?.has(c.cardName)
  );
}
```

6. Return `seatCardNames` alongside the existing return values.

- [ ] **Step 4: Run tests**

Run: `pnpm test src/app/hooks/useCardFiltering.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/hooks/useCardFiltering.ts src/app/hooks/useCardFiltering.test.ts
git commit -m "Add seat-aware card filtering with seatCardNames derivation"
```

## Chunk 3: UI Changes

### Task 6: Seat dropdown in Settings

**Files:**
- Modify: `src/app/components/Settings.tsx`

- [ ] **Step 1: Add seat selection props to `SettingsProps`**

```ts
// Add to SettingsProps:
selectedSeat: number | null;
onSelectedSeatChange: (seat: number | null) => void;
activeDraftNumSeats: number;
```

`activeDraftNumSeats` is derived by the parent (`PageClient`) from `syncStatus.activeDrafts` based on the currently selected active draft.

- [ ] **Step 2: Add seat dropdown UI**

After the active draft `<select>` (around line 147), add the seat dropdown on the same row. Wrap both selects in a `flex gap-3` container:

```tsx
{activeDrafts.length > 0 && (
  <div className="mb-6">
    <h3 className="mb-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
      Active draft
    </h3>
    <div className="flex gap-3">
      {/* Existing active draft dropdown */}
      <div className="relative flex-1">
        <select ...>...</select>
        <svg ...chevron... />
      </div>

      {/* Seat selector — only when a draft is selected */}
      {activeDraft && (
        <div className="relative flex-1">
          <select
            value={selectedSeat ?? ""}
            onChange={(e) => onSelectedSeatChange(e.target.value ? Number(e.target.value) : null)}
            className="block w-full appearance-none rounded-lg border border-zinc-300 bg-white py-1.5 pl-3 pr-9 text-sm text-zinc-900 focus:border-transparent focus:ring-2 focus:ring-blue-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
          >
            <option value="">No seat</option>
            {Array.from({ length: activeDraftNumSeats }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>Seat {n}</option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
          </svg>
        </div>
      )}
    </div>

    {/* Hide taken checkbox (existing, unchanged) */}
    {activeDraft && (
      <label className="mt-2 flex items-center gap-2 ...">
        ...
      </label>
    )}
  </div>
)}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: Error in `PageClient.tsx` — missing new props on `<Settings>`. Expected at this stage.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/Settings.tsx
git commit -m "Add seat selector dropdown to Settings panel"
```

### Task 7: Row accent styling in CardTable

**Files:**
- Modify: `src/app/components/CardTable.tsx:22-28,326-333`

- [ ] **Step 1: Add `seatCardNames` prop**

```ts
// In CardTableProps (line 22-28):
export interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
  takenCardNames?: Set<string>;
  seatCardNames?: Set<string>;  // NEW
}
```

- [ ] **Step 2: Update row styling**

At lines 326-333, update the `<tr>` to apply three visual states:

```tsx
<tr
  key={row.id}
  className="bg-white transition-colors hover:bg-zinc-50 dark:bg-zinc-900 dark:hover:bg-zinc-800"
  style={{
    opacity:
      takenCardNames?.has(row.original.cardName) &&
      !seatCardNames?.has(row.original.cardName)
        ? 0.35
        : 1,
    borderLeft: seatCardNames?.has(row.original.cardName)
      ? "4px solid rgb(59 130 246)"  // blue-500
      : "4px solid transparent",
  }}
>
```

The transparent border on non-seat rows prevents layout shift.

- [ ] **Step 3: Destructure `seatCardNames` from props**

Update the component destructuring to include the new prop.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: Error in `PageClient.tsx` — not passing `seatCardNames` to `<CardTable>` yet. Expected.

- [ ] **Step 5: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Add three-state row styling for seat selection in CardTable"
```

### Task 8: Wire everything in PageClient

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Derive `activeDraftNumSeats` from sync status**

```ts
const activeDraftNumSeats = useMemo(() => {
  if (!draftSelection.activeDraft) return 0;
  const info = syncStatus.activeDrafts.find(
    (d) => d.id === draftSelection.activeDraft
  );
  return info?.numSeats ?? 10;
}, [draftSelection.activeDraft, syncStatus.activeDrafts]);
```

- [ ] **Step 2: Derive `seatCardNames` from filtering hook**

Update the `useCardFiltering` call to pass `selectedSeat`:

```ts
const { displayCards, searchFilteredCards, availableCount, takenCardNamesSet, seatCardNames } =
  useCardFiltering({
    cardData,
    activeDraft: draftSelection.activeDraft,
    hideTaken: draftSelection.hideTaken,
    selectedSeat: draftSelection.selectedSeat,
    searchQuery: search.searchQuery,
    scryfallMatchNames: search.scryfallMatchNames,
  });
```

- [ ] **Step 3: Pass new props to Settings**

Add to the `<Settings>` component:

```tsx
selectedSeat={draftSelection.selectedSeat}
onSelectedSeatChange={draftSelection.setSelectedSeat}
activeDraftNumSeats={activeDraftNumSeats}
```

- [ ] **Step 4: Pass `seatCardNames` to CardTable**

```tsx
<CardTable
  cards={searchFilteredCards}
  colorFilter={search.colorFilter}
  colorFilterMode={search.colorFilterMode}
  currentCubeCopies={displayedCubeCopies}
  takenCardNames={takenCardNamesSet}
  seatCardNames={seatCardNames}
/>
```

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — all types should align now.

- [ ] **Step 6: Run all tests**

Run: `pnpm test`
Expected: May have failures in `PageClient.test.tsx` if the test mocks `useSyncStatus` with the old `activeDraftIds` shape.

- [ ] **Step 7: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Wire seat selection through PageClient to Settings and CardTable"
```

### Task 9: Fix tests

**Files:**
- Modify: `src/app/components/PageClient.test.tsx`
- Modify: `src/core/__tests__/sync.test.ts` (if it tests `getActiveDraftIds`)

- [ ] **Step 1: Update PageClient test mocks**

Update the `useSyncStatus` mock to return `activeDrafts: []` instead of `activeDraftIds: []`. Update any assertions that reference `activeDraftIds`.

Update the `useCardFiltering` mock to accept `selectedSeat` and return `seatCardNames`.

Update the `useDraftSelection` mock to return `selectedSeat` and `setSelectedSeat`.

- [ ] **Step 2: Update sync test if needed**

If `src/core/__tests__/sync.test.ts` tests `getActiveDraftIds`, rename references to `getActiveDraftInfo` and update expected return shape.

- [ ] **Step 3: Run full test suite and precommit**

Run: `pnpm precommit`
Expected: PASS — typecheck, lint, knip, tests all green.

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.test.tsx src/core/__tests__/sync.test.ts
git commit -m "Update test mocks for takenCards and activeDrafts shape changes"
```
