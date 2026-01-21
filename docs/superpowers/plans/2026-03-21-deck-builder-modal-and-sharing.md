# Deck Builder Modal & Sharing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the deck builder from an inline panel to a near-fullscreen modal, make the controls bar and table headers sticky, and change shared deck links from a separate route to query params on the main page.

**Architecture:** The deck builder panel becomes a modal overlay managed by `PageClient`. The controls bar and card table thead get CSS sticky positioning. Shared deck links use `/?deck=abc123` query params, with `PageClient` fetching and loading shared decks on mount. The `/deck/[id]` page route and `SharedDeckClient` are deleted.

**Tech Stack:** Next.js (App Router), React, TanStack Table, Tailwind CSS, @dnd-kit, Turso (via existing API routes)

**Spec:** `docs/superpowers/specs/2026-03-21-deck-builder-modal-and-sharing-design.md`

---

## Chunk 1: Sticky Controls Bar + Table Headers

### Task 1: Make the controls bar sticky

**Files:**
- Modify: `src/app/components/PageClient.tsx:270` (controls bar div)

- [ ] **Step 1: Add a ref to measure controls bar height**

In `PageClient.tsx`, add a ref and state for the controls bar height. Add `useRef` and a `ResizeObserver` to track the height and expose it via a CSS custom property on the containing `div`.

At the top of `PageClient` (after existing hooks, ~line 84):

```tsx
const controlsBarRef = useRef<HTMLDivElement>(null);
const [controlsBarHeight, setControlsBarHeight] = useState(0);

useEffect(() => {
  const el = controlsBarRef.current;
  if (!el) return;
  const observer = new ResizeObserver(([entry]) => {
    setControlsBarHeight(entry.contentRect.height);
  });
  observer.observe(el);
  return () => observer.disconnect();
}, []);
```

- [ ] **Step 2: Make the controls bar sticky**

Change the controls bar `<div>` at line 270 from:

```tsx
<div className="mb-6 flex flex-wrap items-center gap-4">
```

to:

```tsx
<div
  ref={controlsBarRef}
  className="sticky top-0 z-30 -mx-4 mb-6 flex flex-wrap items-center gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 dark:border-zinc-800 dark:bg-zinc-950"
>
```

The negative margins + padding re-expand to full container width so the sticky background covers edge to edge.

- [ ] **Step 3: Verify in dev server**

Run: `pnpm dev`

Scroll the page and confirm:
- The controls bar (search, color filter, deck builder button, active draft indicator) sticks to the top
- The header and draft stats scroll away
- The sticky bar has a solid background (no content bleed-through)

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Make controls bar sticky at top of viewport"
```

### Task 2: Make the card table thead sticky below the controls bar

**Files:**
- Modify: `src/app/components/CardTable.tsx:287` (thead element)
- Modify: `src/app/components/CardTable.tsx:22-33` (CardTableProps interface)
- Modify: `src/app/components/PageClient.tsx:434` (CardTable usage)

- [ ] **Step 1: Add `stickyTopOffset` prop to CardTable**

In `CardTable.tsx`, add to the `CardTableProps` interface (line 22):

```tsx
export interface CardTableProps {
  cards: EnrichedCardStats[];
  colorFilter: string[];
  colorFilterMode: ColorFilterMode;
  currentCubeCopies: Record<string, number>;
  takenCardNames?: Set<string>;
  seatCardNames?: Set<string>;
  onAddSpeculative?: (cardName: string) => void;
  onRemoveSpeculative?: (cardName: string) => void;
  deckBuilderCardCounts?: Map<string, number>;
  speculativeCardNames?: Set<string>;
  stickyTopOffset?: number;
}
```

Add it to the destructuring in the function signature (line 67):

```tsx
export function CardTable({
  cards,
  colorFilter,
  colorFilterMode,
  currentCubeCopies,
  takenCardNames,
  seatCardNames,
  onAddSpeculative,
  onRemoveSpeculative,
  deckBuilderCardCounts,
  speculativeCardNames,
  stickyTopOffset,
}: CardTableProps) {
```

- [ ] **Step 2: Make thead sticky with the offset**

Change the `<thead>` at line 287 from:

```tsx
<thead className="bg-zinc-50 dark:bg-zinc-800">
```

to:

```tsx
<thead
  className="bg-zinc-50 dark:bg-zinc-800"
  style={stickyTopOffset != null ? { position: "sticky", top: stickyTopOffset, zIndex: 20 } : undefined}
>
```

- [ ] **Step 3: Pass `stickyTopOffset` from PageClient**

In `PageClient.tsx`, pass the measured controls bar height to `CardTable` (around line 434):

```tsx
<CardTable
  cards={searchFilteredCards}
  colorFilter={search.colorFilter}
  colorFilterMode={search.colorFilterMode}
  currentCubeCopies={displayedCubeCopies}
  takenCardNames={takenCardNamesSet}
  seatCardNames={seatCardNames}
  onAddSpeculative={showDeckBuilder ? handleAddSpeculative : undefined}
  onRemoveSpeculative={showDeckBuilder ? handleRemoveSpeculative : undefined}
  deckBuilderCardCounts={showDeckBuilder ? deckBuilderCardCounts : undefined}
  speculativeCardNames={showDeckBuilder ? speculativeCardNames : undefined}
  stickyTopOffset={controlsBarHeight}
/>
```

Note: The speculative card conditions still use `showDeckBuilder` here. Task 3 will rename this to `deckBuilderActive`.

- [ ] **Step 4: Verify in dev server**

Scroll and confirm:
- Table column headers stick directly below the controls bar
- No gap or overlap between controls bar and thead
- Sorting indicators still work when clicking sticky headers

- [ ] **Step 5: Commit**

```bash
git add src/app/components/CardTable.tsx src/app/components/PageClient.tsx
git commit -m "Make card table thead sticky below controls bar"
```

## Chunk 2: Deck Builder Modal

### Task 3: Convert DeckBuilderPanel to render inside a modal overlay

**Files:**
- Modify: `src/app/components/PageClient.tsx:84,270,388-399,418-430,441-444`

This task wraps the existing `DeckBuilderPanel` in a modal overlay and changes `showDeckBuilder` to `deckBuilderModalOpen`. We also introduce a separate `deckBuilderActive` boolean to decouple speculative interactions from modal visibility.

- [ ] **Step 1: Replace `showDeckBuilder` state with `deckBuilderActive` + `deckBuilderModalOpen`**

In `PageClient.tsx`, replace line 84:

```tsx
const [showDeckBuilder, setShowDeckBuilder] = useState(false);
```

with:

```tsx
const [deckBuilderActive, setDeckBuilderActive] = useState(false);
const [deckBuilderModalOpen, setDeckBuilderModalOpen] = useState(false);

// Persist modal open state in localStorage
useEffect(() => {
  const stored = localStorage.getItem("deckBuilderOpen");
  if (stored === "true" && draftSelection.activeDraft && draftSelection.selectedSeat !== null) {
    setDeckBuilderActive(true);
    setDeckBuilderModalOpen(true);
  }
}, []); // eslint-disable-line react-hooks/exhaustive-deps

useEffect(() => {
  localStorage.setItem("deckBuilderOpen", String(deckBuilderModalOpen));
}, [deckBuilderModalOpen]);

// Close modal and deactivate deck builder when draft/seat deselected
useEffect(() => {
  if (!draftSelection.activeDraft || draftSelection.selectedSeat === null) {
    setDeckBuilderActive(false);
    setDeckBuilderModalOpen(false);
  }
}, [draftSelection.activeDraft, draftSelection.selectedSeat]);
```

- [ ] **Step 2: Update the toggle button**

Replace the deck builder toggle button (lines 388-399):

```tsx
{draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
  <button
    onClick={() => {
      if (!deckBuilderActive) setDeckBuilderActive(true);
      setDeckBuilderModalOpen((prev) => !prev);
    }}
    className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      deckBuilderModalOpen
        ? "bg-blue-600 text-white hover:bg-blue-500"
        : deckBuilderActive
          ? "bg-blue-600/30 text-blue-300 hover:bg-blue-600/50 dark:bg-blue-600/20 dark:hover:bg-blue-600/30"
          : "bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600"
    }`}
  >
    Deck Builder
  </button>
)}
```

Three visual states: inactive (gray), active but modal closed (dim blue — deck builder is running, you can add speculative cards), modal open (solid blue).

- [ ] **Step 3: Replace inline panel with modal overlay**

Replace the DeckBuilderPanel rendering block (lines 418-430):

```tsx
{/* Deck Builder Modal */}
{deckBuilderModalOpen && draftSelection.activeDraft && draftSelection.selectedSeat !== null && (
  <div
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    onClick={(e) => {
      if (e.target === e.currentTarget) setDeckBuilderModalOpen(false);
    }}
  >
    <div className="m-4 flex max-h-[calc(100vh-2rem)] w-full max-w-7xl flex-col rounded-xl shadow-2xl">
      <DeckBuilderPanel
        state={deckBuilder.state}
        dispatch={deckBuilder.dispatch}
        scryfallData={scryfallDataMap}
        cardStats={cardStatsMap}
        draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name ?? draftSelection.activeDraft}
        onClose={() => setDeckBuilderModalOpen(false)}
      />
    </div>
  </div>
)}
```

- [ ] **Step 4: Update speculative card prop conditions**

Change lines 441-444 from `showDeckBuilder` to `deckBuilderActive`:

```tsx
onAddSpeculative={deckBuilderActive ? handleAddSpeculative : undefined}
onRemoveSpeculative={deckBuilderActive ? handleRemoveSpeculative : undefined}
deckBuilderCardCounts={deckBuilderActive ? deckBuilderCardCounts : undefined}
speculativeCardNames={deckBuilderActive ? speculativeCardNames : undefined}
```

- [ ] **Step 5: Update initialization effects**

The `showDeckBuilder` references in the initialization effects (lines 125-156) need updating. Replace all occurrences of `showDeckBuilder` with `deckBuilderActive` in these two `useEffect` blocks:

- Line 128: `if (showDeckBuilder && ...` → `if (deckBuilderActive && ...`
- Line 142: `if (!showDeckBuilder)` → `if (!deckBuilderActive)`
- Line 149: `if (!showDeckBuilder || ...` → `if (!deckBuilderActive || ...`
- Line 155: `[seatCardList, showDeckBuilder]` → `[seatCardList, deckBuilderActive]`

- [ ] **Step 6: Remove max-height constraint from DeckBuilderPanel**

In `src/app/components/deck-builder/DeckBuilderPanel.tsx`, on the `<div>` at lines 217-220 that wraps the deck zones:

```tsx
<div
  className="overflow-y-auto p-4 space-y-4"
  style={{ maxHeight: "45vh" }}
>
```

Add `flex-1` to the className and remove the `style` prop:

```tsx
<div className="overflow-y-auto p-4 space-y-4 flex-1">
```

- [ ] **Step 7: Add Escape key listener**

Add a global keydown listener in `PageClient.tsx` for Escape:

```tsx
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && deckBuilderModalOpen) {
      setDeckBuilderModalOpen(false);
    }
  }
  document.addEventListener("keydown", handleKeyDown);
  return () => document.removeEventListener("keydown", handleKeyDown);
}, [deckBuilderModalOpen]);
```

- [ ] **Step 8: Verify in dev server**

Test:
- Click "Deck Builder" → modal opens over card table with dark overlay
- Click overlay background → modal closes
- Press Escape → modal closes
- Click "Deck Builder" again → modal reopens (deck state preserved)
- When modal is closed but deck builder was activated, speculative `+` buttons still appear on card table rows
- Refresh page with modal open → modal reopens
- Deselect active draft → modal closes

- [ ] **Step 9: Update PageClient tests**

In `src/app/components/PageClient.test.tsx`, the existing tests don't directly test `showDeckBuilder` so they should still pass. Run:

```bash
pnpm test
```

If any tests reference `showDeckBuilder` or deck builder visibility, update them to use the new state names.

- [ ] **Step 10: Commit**

```bash
git add src/app/components/PageClient.tsx src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "Convert deck builder to modal overlay with quick-toggle and localStorage persistence"
```

## Chunk 3: Sharing Flow Redesign

### Task 4: Update share link generation to use query params

**Files:**
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx:123-145,199-208`

- [ ] **Step 1: Change URL format in handleShareDeck**

In `DeckBuilderPanel.tsx`, change line 136:

```tsx
const url = `${window.location.origin}/deck/${deckId}`;
```

to:

```tsx
const url = `${window.location.origin}/?deck=${deckId}`;
```

- [ ] **Step 2: Re-enable the share button**

Remove the `disabled` attribute and update the button styling (lines 200-207). Change from:

```tsx
<button
  onClick={handleShareDeck}
  disabled
  className="rounded-md bg-blue-600/50 px-3 py-1.5 text-xs font-medium text-white/50 cursor-not-allowed transition-colors"
  title="This feature is coming soon."
>
```

to:

```tsx
<button
  onClick={handleShareDeck}
  className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 transition-colors"
>
```

Also remove the TODO comment on line 199. Only the opening `<button>` tag attributes change; the button's children (the `shareStatus` ternary on line 206) remain unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/app/components/deck-builder/DeckBuilderPanel.tsx
git commit -m "Generate /?deck= query param links and re-enable share button"
```

### Task 5: Load shared decks from query param on main page

**Files:**
- Modify: `src/app/components/PageClient.tsx` (add shared deck loading logic)

- [ ] **Step 1: Read `deck` query param and fetch shared deck on mount**

Add `useSearchParams` import at the top of `PageClient.tsx`:

```tsx
import { useSearchParams } from "next/navigation";
```

Inside the `PageClient` function, after the `draftSelection` hook (around line 37), add:

```tsx
const searchParams = useSearchParams();
const sharedDeckId = searchParams.get("deck");

// Load shared deck from query param
useEffect(() => {
  if (!sharedDeckId) return;

  async function loadSharedDeck() {
    try {
      const res = await fetch(`/api/deck/${sharedDeckId}`);
      if (!res.ok) return;
      const deckState = await res.json();

      // Set draft context to match the shared deck
      draftSelection.setActiveDraft(deckState.draftId);
      draftSelection.setSelectedSeat(deckState.seat);

      // Load the shared deck into the deck builder
      deckBuilder.dispatch({ type: "INIT_FROM_SNAPSHOT", snapshot: deckState });

      // Activate and open the deck builder modal
      setDeckBuilderActive(true);
      setDeckBuilderModalOpen(true);
    } catch (err) {
      console.error("Failed to load shared deck:", err);
    }
  }

  loadSharedDeck();
}, [sharedDeckId]); // eslint-disable-line react-hooks/exhaustive-deps
```

Note: This effect needs to run after the `deckBuilder` hook is available, so place it after the `useDeckBuilder` call (after line 110). Also note: `setActiveDraft` internally reads localStorage for the stored seat, then `setSelectedSeat` immediately overrides it — both calls are batched by React 18+, so the final state will have the correct seat from the shared deck.

**No changes needed for localStorage conflicts.** The `useDeckBuilder` hook hydrates from localStorage synchronously in a `useEffect`, while the shared deck fetch is async. The fetch always resolves after hydration, so its `INIT_FROM_SNAPSHOT` overwrites the localStorage-hydrated state. Similarly, the `deckBuilderOpen` localStorage hydration (Task 3, Step 1) only fires when `activeDraft` and `selectedSeat` are already set — on a shared deck cold load, they aren't set yet, so the localStorage check is a no-op. The shared deck loading effect handles opening the modal after the fetch completes.

- [ ] **Step 2: Wrap PageClient in Suspense boundary**

`useSearchParams()` requires a Suspense boundary in Next.js App Router. In `src/app/page.tsx`, wrap the `PageClient` in `Suspense`:

```tsx
import { Suspense } from "react";
```

And in the return:

```tsx
<Suspense fallback={null}>
  <PageClient initialCardData={cardData} initialDraftStats={draftStats} />
</Suspense>
```

- [ ] **Step 3: Verify in dev server**

Test the full sharing flow:
1. Open an active draft, select a seat, open the deck builder
2. Click "Share Deck" — URL is copied to clipboard in `/?deck=abc123` format
3. Open the copied URL in a new tab
4. Confirm: card table loads with the correct draft, deck builder modal opens with the shared deck
5. Make an edit (move a card), refresh — the original shared deck reloads (edits lost)
6. Click "Share Deck" again — a new URL is generated

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx src/app/page.tsx
git commit -m "Load shared decks from ?deck= query param on main page"
```

### Task 6: Delete the old shared deck route

**Files:**
- Delete: `src/app/deck/[id]/page.tsx`
- Delete: `src/app/deck/[id]/SharedDeckClient.tsx`

- [ ] **Step 1: Delete the files**

```bash
rm -rf src/app/deck
```

- [ ] **Step 2: Run all checks**

```bash
pnpm precommit
```

This runs typecheck, lint, knip (unused code detection), and tests. Verify:
- No type errors from deleted imports
- No unused exports flagged by knip (the `getSharedDeck` function is still used by the GET API route, so it should be fine)
- All tests pass

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "Delete /deck/[id] route — shared decks now use /?deck= query param"
```

### Task 7: Final integration test

- [ ] **Step 1: Run all quality checks**

```bash
pnpm precommit
```

All checks must pass: typecheck, lint, knip, tests.

- [ ] **Step 2: Manual smoke test**

Run `pnpm dev` and verify end-to-end:

1. **Sticky behavior:** Scroll down — controls bar and table headers stick, header scrolls away
2. **Modal open/close:** Click Deck Builder → modal opens. Click overlay → closes. Press Escape → closes. Click button → opens again. State preserved across open/close cycles.
3. **Speculative cards:** Close modal → `+` buttons still visible on card table rows. Add a speculative card. Open modal → card appears in deck.
4. **Persistence:** Refresh with modal open → modal reopens. Refresh with modal closed → stays closed.
5. **Sharing:** Share a deck → `/?deck=` URL copied. Open in new tab → card table loads with correct draft, modal opens with shared deck. Edit and refresh → original deck reloads.
6. **No active draft:** Deselect active draft → modal closes, deck builder button disappears.

- [ ] **Step 3: Commit any remaining fixes**

If any issues are found during smoke testing, fix and commit.
