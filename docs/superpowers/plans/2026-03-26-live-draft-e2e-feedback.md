# Live Draft E2E Feedback Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all 18 feedback items from live draft E2E testing, fixing bugs, improving UX, and cleaning up visual presentation.

**Architecture:** These changes span the draft board UI (modal, cells, standings), card table (pick/queue controls), match reporting, and a standings API field naming bug. Most changes are UI-only (React component styling and layout), with one backend fix (snake_case → camelCase field mapping in standings API).

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4, Vitest

**Spec reference:** `docs/live-draft-e2e-feedback.md`

**Quality commands:**
```bash
pnpm typecheck   # TypeScript type checking
pnpm lint        # ESLint (zero warnings)
pnpm knip        # Unused exports/files
pnpm test        # Vitest
pnpm precommit   # All of the above
```

---

## Chunk 1: Standings Bug Fix & Match Reporting Polish

These fix the most critical bug (broken standings) and polish match reporting.

### Task 1: Fix Standings Field Name Mismatch (Feedback #15)

The standings table shows dashes because the API returns `match_wins`, `match_losses`, `game_wins`, `game_losses` (snake_case) but `StandingsSection.tsx` reads `matchWins`, `matchLosses`, `gameWins`, `gameLosses` (camelCase). Fix the API response to use camelCase.

**Files:**
- Modify: `src/core/db/queries/picks.ts:343-349`
- Modify: `src/core/db/queries/picks.ts:248-254` (StandingsEntry interface)
- Modify: `src/core/db/queries/picks.ts:352-357` (sort comparator)
- Modify: `src/app/api/drafts/[id]/standings/route.test.ts` (if assertions reference old field names)

- [ ] **Step 1: Update StandingsEntry interface**

In `src/core/db/queries/picks.ts`, change the interface at lines 248-254:

```typescript
export interface StandingsEntry {
  seat: number | "[REDACTED]";
  matchWins: number;
  matchLosses: number;
  gameWins: number;
  gameLosses: number;
}
```

- [ ] **Step 2: Update the standings push and sort**

Update lines 343-349 (the `standings.push` call):

```typescript
    standings.push({
      seat: isRedacted ? "[REDACTED]" : seat,
      matchWins: s.matchWins,
      matchLosses: s.matchLosses,
      gameWins: s.gameWins,
      gameLosses: s.gameLosses,
    });
```

Update lines 352-357 (the sort comparator):

```typescript
  standings.sort((a, b) => {
    if (b.matchWins !== a.matchWins) return b.matchWins - a.matchWins;
    const aRate = a.gameWins / Math.max(1, a.gameWins + a.gameLosses);
    const bRate = b.gameWins / Math.max(1, b.gameWins + b.gameLosses);
    return bRate - aRate;
  });
```

- [ ] **Step 3: Update any tests referencing old field names**

Search for `match_wins`, `match_losses`, `game_wins`, `game_losses` in test files and update to camelCase.

```bash
grep -rn "match_wins\|match_losses\|game_wins\|game_losses" src/ --include="*.test.ts"
```

- [ ] **Step 4: Run tests**

```bash
pnpm test
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db/queries/picks.ts src/app/api/drafts/
git commit -m "Fix standings: use camelCase field names in API response to match client"
```

---

### Task 2: Fix Match Reporting Inputs (Feedback #12, #13)

Remove spinners from number inputs and constrain values to 0-2.

**Files:**
- Modify: `src/app/components/draft-board/MatchReporting.tsx:179-213`

- [ ] **Step 1: Update the input elements**

In `MatchReporting.tsx`, find the two `<input type="number"` elements (wins and losses inputs). Update both to:

1. Add `min={0}` and `max={2}` attributes
2. Add CSS to hide spinners: add `MozAppearance: "textfield"` to the style object
3. Add a `className` with Tailwind's `[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none` to hide WebKit spinners
4. Add `onBlur` handler to clamp values: if value > 2, set to 2; if value < 0 or empty, set to ""

For each input, add this style property:
```typescript
MozAppearance: "textfield" as const,
```

And update the `onChange` handler to clamp:
```typescript
onChange={(e) => {
  const val = e.target.value;
  // Allow empty (clearing) or values 0-2
  if (val === "" || (Number(val) >= 0 && Number(val) <= 2)) {
    handleInputChange(opponent, "wins", val);
  }
}}
```

(Same pattern for losses input, using `"losses"` instead of `"wins"`)

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/draft-board/MatchReporting.tsx
git commit -m "Constrain match inputs to 0-2, hide number spinners"
```

---

### Task 3: Fix Match Reporting Save Button Styling (Feedback #14)

The bright green/blue save buttons don't match the dark theme. Make them more subdued.

**Files:**
- Modify: `src/app/components/draft-board/MatchReporting.tsx:214-229`

- [ ] **Step 1: Update save button colors**

Change the save button background colors:
- Unsaved: from `#2563eb` (bright blue) to `#3f3f46` (zinc-700) with `#e0e0e0` text
- Saved: from `#166534` (bright green) to `#27272a` (zinc-800) with `#6ee7b7` (emerald-300) text
- Hover (unsaved): `#52525b` (zinc-600)

Update the button style object:

```typescript
style={{
  padding: "2px 10px",
  fontSize: "11px",
  borderRadius: "4px",
  border: input.saved ? "1px solid #374151" : "1px solid #52525b",
  backgroundColor: input.saved ? "#27272a" : "#3f3f46",
  color: input.saved ? "#6ee7b7" : "#e0e0e0",
  cursor: input.saving ? "not-allowed" : "pointer",
  opacity: input.saving ? 0.6 : 1,
}}
```

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/draft-board/MatchReporting.tsx
git commit -m "Subdue match save button styling to match dark theme"
```

---

## Chunk 2: Pick Controls UX (Feedback #1, #2, #3, #4, #5)

### Task 4: Restyle Pick & Queue Controls as Icons (Feedback #1, #2)

Replace the big green "Pick" button and circular "+" queue button with small inline icons that match the deck builder icon pattern on the right side of card cells.

**Files:**
- Modify: `src/app/components/CardTable.tsx` (PickButton component + liveDraftActions column)

- [ ] **Step 1: Replace PickButton with icon-style control**

Replace the `PickButton` component (lines 47-80) with a smaller, icon-based version:

```typescript
function PickButton({ cardName, onPick }: { cardName: string; onPick: (name: string) => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (confirming) {
      timeoutRef.current = setTimeout(() => setConfirming(false), 3000);
      return () => clearTimeout(timeoutRef.current);
    }
  }, [confirming]);

  if (confirming) {
    return (
      <button
        onClick={(e) => { e.stopPropagation(); setConfirming(false); onPick(cardName); }}
        className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] font-bold text-red-400 ring-1 ring-red-500/50 animate-pulse hover:text-red-300"
        title="Click again to confirm pick"
      >
        ✓
      </button>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
      className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] text-emerald-500/70 ring-1 ring-emerald-500/30 hover:text-emerald-400 hover:ring-emerald-400/50"
      title="Pick this card"
    >
      ✓
    </button>
  );
}
```

- [ ] **Step 2: Restyle queue button**

In the liveDraftActions column cell (around lines 225-243), replace the circular queue button with a smaller icon:

For the "not queued" state:
```tsx
<button
  onClick={(e) => { e.stopPropagation(); onQueueAddRef.current?.(cardName); }}
  className="inline-flex h-4 w-4 items-center justify-center rounded text-[9px] text-blue-500/50 ring-1 ring-blue-500/30 hover:text-blue-400 hover:ring-blue-400/50"
  title="Add to pick queue"
>
  +
</button>
```

For the "queued" state:
```tsx
<button
  onClick={(e) => { e.stopPropagation(); onQueueRemoveRef.current?.(cardName); }}
  className="inline-flex h-4 w-4 items-center justify-center rounded bg-blue-500/20 text-[9px] font-medium text-blue-400 ring-1 ring-blue-500/40 hover:bg-blue-500/30"
  title={`Queued #${position} — click to remove`}
>
  {position}
</button>
```

- [ ] **Step 3: Adjust column width**

Change the liveDraftActions column size from its current value to `40` (narrower, since icons are smaller):

```typescript
size: 40,
```

- [ ] **Step 4: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/app/components/CardTable.tsx
git commit -m "Restyle pick and queue controls as small inline icons"
```

---

### Task 5: Fix Missing Deck Builder Icons in Live Draft (Feedback #3)

When logged into a live draft, the deck builder button and card icons are missing because `selectedSeat` is not set. Fix: when `mySeat` is resolved, auto-set the selected seat.

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Add effect to sync mySeat → selectedSeat**

In `PageClient.tsx`, after the `useMySeat` call (around line 198), add an effect:

```typescript
  // When mySeat resolves from token auth, auto-select that seat
  useEffect(() => {
    if (mySeat !== null && draftSelection.selectedSeat === null) {
      draftSelection.setSelectedSeat(mySeat);
    }
  }, [mySeat, draftSelection.selectedSeat, draftSelection.setSelectedSeat]);
```

Verify that `useDraftSelection` returns a `setSelectedSeat` function. If not, check the hook for the appropriate setter name.

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Auto-select seat when token login resolves mySeat"
```

---

### Task 6: Refresh UI After Pick (Feedback #4)

After making a pick, the card isn't removed or visually marked as taken. Force a data refresh after a successful pick.

**Files:**
- Modify: `src/app/components/PageClient.tsx` (handlePick function)

- [ ] **Step 1: Trigger status refresh after successful pick**

In `PageClient.tsx`, find the `handlePick` callback. After a successful pick (when `res.ok`), trigger the live draft status to re-poll immediately. The `liveDraftStatus` hook likely has a `refresh` or `refetch` method, or the `dataChanged` counter is used to trigger re-polls.

Find how `liveDraftStatus` triggers re-fetches. Look for a `refresh()` method or a way to manually increment `dataChanged`. Add a call after the successful `res.ok` check:

```typescript
      if (!res.ok) {
        const data = await res.json();
        setPickError(data.error || "Pick failed");
      } else {
        // Force immediate refresh of draft status and board
        liveDraftStatus.refresh?.();
      }
```

If `refresh` doesn't exist on the hook, check the hook implementation and use whatever mechanism it provides for manual re-fetch. The goal is to update `liveDraftStatus.status` immediately so `takenCardNames` is refreshed and the picked card shows as taken.

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Force draft status refresh after successful pick"
```

---

### Task 7: Show Double-Pick Indicator (Feedback #5)

Nothing in the UI indicates when you have a double pick (snake draft turn). Add an indicator near the auto-pick toggle when it's the player's turn and they get consecutive picks.

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Compute consecutive pick count**

In `PageClient.tsx`, after the `isMyTurn` check (around line 199), compute how many consecutive picks the player has:

```typescript
  // Check if player has multiple consecutive picks (snake draft turn)
  const consecutivePicks = (() => {
    if (!isMyTurn || !liveDraftStatus.status || mySeat === null) return 0;
    const { nextSeat, latestPickN, numSeats, picksPerPlayer } = liveDraftStatus.status;
    if (nextSeat !== mySeat) return 0;
    // Count consecutive picks starting from current position
    let count = 0;
    let pickN = latestPickN + 1;
    const totalPicks = numSeats * picksPerPlayer;
    while (pickN <= totalPicks) {
      const round = Math.ceil(pickN / numSeats);
      const posInRound = ((pickN - 1) % numSeats);
      const isForward = round % 2 === 1;
      const seat = isForward ? posInRound + 1 : numSeats - posInRound;
      if (seat !== mySeat) break;
      count++;
      pickN++;
    }
    return count;
  })();
```

- [ ] **Step 2: Render double-pick indicator**

Near the auto-pick toggle button, add:

```tsx
            {isMyTurn && consecutivePicks > 1 && (
              <span className="rounded-md bg-amber-900/50 px-2 py-1 text-xs font-medium text-amber-300">
                {consecutivePicks}× pick
              </span>
            )}
```

- [ ] **Step 3: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 4: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Show double-pick indicator during snake draft turns"
```

---

## Chunk 3: Draft Board Overhaul (Feedback #7, #8, #9, #10, #11)

### Task 8: Overhaul Draft Board Cells — Mana Symbols & No Background Colors (Feedback #7, #8, #9)

Replace colored dots with actual mana SVG symbols. Remove background color-coding on cells.

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardCell.tsx`

- [ ] **Step 1: Replace colored dots with mana SVGs**

In `DraftBoardCell.tsx`, replace the mana symbol rendering section (lines 85-100, the colored circles) with actual `<img>` tags using the same SVG files as `ManaSymbols.tsx`:

Replace the mana symbols section with:

```tsx
          {manaCost && manaSymbols.length > 0 && (
            <span style={{ display: "flex", gap: "1px", flexShrink: 0 }}>
              {manaSymbols.map((sym, i) => {
                const svgName = sym.replace(/[{}\/]/g, "");
                return (
                  <img
                    key={i}
                    src={`/mana/${svgName}.svg`}
                    alt={sym}
                    width={12}
                    height={12}
                    style={{ display: "block" }}
                  />
                );
              })}
            </span>
          )}
```

- [ ] **Step 2: Remove background color-coding**

Replace the `getBackgroundColor` function to return transparent for all cells:

```typescript
function getBackgroundColor(
  _colorIdentity: string | undefined,
  isMySeat: boolean,
): string {
  return isMySeat ? "rgba(59,130,246,0.06)" : "transparent";
}
```

Or remove the function entirely and inline: use `isMySeat ? "rgba(59,130,246,0.06)" : "transparent"` where `backgroundColor` is set.

- [ ] **Step 3: Improve cell layout for readability**

Update the cell content styles to give card names more room:

```typescript
style={{
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
  fontSize: "11px",
  lineHeight: "1.2",
}}
```

- [ ] **Step 4: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/app/components/draft-board/DraftBoardCell.tsx
git commit -m "Replace colored dots with mana SVGs, remove background color-coding"
```

---

### Task 9: Make Draft Board Wider and Taller (Feedback #10)

The board is too cramped. Increase modal max width, cell widths, and scrollable area height.

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx`
- Modify: `src/app/components/draft-board/DraftBoardMatrix.tsx`

- [ ] **Step 1: Increase modal max width**

In `DraftBoardModal.tsx`, find the modal container style with `maxWidth: 1400px` and change to:

```typescript
maxWidth: "95vw",
```

- [ ] **Step 2: Increase matrix max height**

In `DraftBoardMatrix.tsx`, find the scrollable div style with `maxHeight: "60vh"` and change to:

```typescript
maxHeight: "75vh",
```

- [ ] **Step 3: Increase cell minimum width**

In `DraftBoardMatrix.tsx`, find the `<td>` or column width for seat columns. Update the `minWidth` to give cells more room:

```typescript
minWidth: "130px",
```

(Check the current value first — it may be in the th/td styles or a CSS property)

- [ ] **Step 4: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 5: Commit**

```bash
git add src/app/components/draft-board/DraftBoardModal.tsx src/app/components/draft-board/DraftBoardMatrix.tsx
git commit -m "Make draft board wider and taller for readability"
```

---

### Task 10: Remove Seat Pick Count Badges (Feedback #11)

The "Seat N: X picks" badges below the board are redundant. Remove the Draft Progress section that shows them.

**Files:**
- Modify: `src/app/components/draft-board/StandingsSection.tsx`

- [ ] **Step 1: Remove the pick count badges**

In `StandingsSection.tsx`, find the "Draft Progress" section (around lines 37-89) that renders badges like `"{Seat Name}: {count} picks"`. Remove the badge list but keep the "Next pick" indicator if useful.

Simplify the drafting-phase section to only show the next pick info:

```tsx
function DraftProgress({
  board,
  status,
}: {
  board: BoardData;
  status: LiveDraftStatus | null;
}) {
  if (!status || board.phase !== "drafting") return null;

  const nextPickNumber = (status.latestPickN ?? 0) + 1;
  const nextSeatName =
    status.nextSeat !== null
      ? board.seatNames[status.nextSeat - 1] ?? `Seat ${status.nextSeat}`
      : null;

  return (
    <div style={{ padding: "8px 0", fontSize: "12px", color: "#888" }}>
      {nextSeatName && (
        <span>
          Next pick: <span style={{ color: "#e0e0e0" }}>{nextSeatName}</span> (Pick #{nextPickNumber})
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/draft-board/StandingsSection.tsx
git commit -m "Remove redundant seat pick count badges from draft board"
```

---

## Chunk 4: Auto-Pick Immediate Fire & API Consistency

### Task 11: Auto-Pick with Queued Card Fires Immediately (Feedback #6)

When auto-pick is toggled ON and the player already has a queued card and it's their turn, fire the pick immediately instead of waiting for the next polling cycle.

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Add effect to fire queued pick when auto-pick turns on**

In `PageClient.tsx`, add an effect that watches for `isMyTurn`, `autoPick`, and the pick queue:

```typescript
  // Fire queued pick immediately when auto-pick is on and it's our turn
  useEffect(() => {
    if (!isMyTurn || !autoPick) return;
    if (!pickQueue.queuedCards || pickQueue.queuedCards.size === 0) return;
    // Get the first queued card (lowest priority number = next pick)
    const sorted = [...pickQueue.queuedCards.entries()].sort((a, b) => a[1] - b[1]);
    const [nextCard] = sorted[0];
    handlePick(nextCard);
  }, [isMyTurn, autoPick, pickQueue.queuedCards, handlePick]);
```

Note: This may need adjustment based on how `pickQueue.queuedCards` is structured (Map vs other). Read the `usePickQueue` hook to confirm the data structure before implementing.

Also ensure `handlePick` is stable (memoized with useCallback) to avoid infinite re-render loops.

- [ ] **Step 2: Run typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```

- [ ] **Step 3: Commit**

```bash
git add src/app/components/PageClient.tsx
git commit -m "Fire queued pick immediately when auto-pick is on and it's player's turn"
```

---

### Task 12: Document API Field Naming (Feedback #16, #17)

These are documentation issues. Update the CLAUDE.md REST API table to use the correct field names.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Verify current API behavior**

```bash
grep -n "card_name\|cardName" src/app/api/drafts/\[id\]/pick/route.ts
```

Confirm the pick API uses `card_name` in the request body.

```bash
grep -n "card_name\|remaining_qty" src/app/api/drafts/\[id\]/available/route.ts
```

Confirm the available endpoint response shape.

- [ ] **Step 2: Update CLAUDE.md**

In the REST API section of `CLAUDE.md`, add notes to the pick and available routes clarifying the field names:
- Pick route: `POST body: { card_name: string }` (not `cardName`)
- Available route: `Response: { cards: [{ card_name, remaining_qty }] }`

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document correct API field names for pick and available endpoints"
```

---

## Chunk 5: Final Verification

### Task 13: Run Full Quality Suite

- [ ] **Step 1: Run precommit checks**

```bash
pnpm precommit
```

This runs typecheck → lint → knip → tests. All must pass.

- [ ] **Step 2: Fix any issues**

If knip reports unused exports or lint reports warnings, fix them.

- [ ] **Step 3: Final commit if needed**

```bash
git add -A
git commit -m "Fix lint/knip issues from E2E feedback changes"
```

---

## Scope Exclusions

The following feedback items are excluded from this plan:

1. **Feedback #18 (Chrome DevTools MCP + Vercel)** — Infrastructure/tooling issue, not a code change. The workaround (use localhost for visual testing) is documented.

2. **Feedback #6 partial: server-side auto-pick optimization** — The client-side immediate fire (Task 11) addresses the UX. Server-side auto-pick already works via the processPick cascade; the gap is only in the client-side delay when toggling ON.
