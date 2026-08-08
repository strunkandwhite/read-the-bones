# Mobile Viewport Units and Queue Drag Handle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop modals clipping off-screen on short iOS viewports, and make queue-row buttons and drag-to-reorder work on touch.

**Architecture:** Two independent changes. First, a mechanical sweep replacing `vh`-based height utilities with `dvh` so modals size against the visible viewport rather than the toolbar-retracted one, locked in by a source-scanning guard test. Second, moving dnd-kit's drag activator from the whole queue row onto the `⠿` grip, which makes the seven ineffective `stopPropagation` guards unnecessary and lets the touch sensor drop its 500ms activation delay.

**Tech Stack:** Next.js 16 (App Router), React 19, Tailwind CSS v4, `@dnd-kit/core` 6.3, Vitest + `@testing-library/react`, Playwright.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-08-mobile-viewport-and-queue-handle-design.md`. Read it before starting.
- **Browser floor is Safari 16.4** (Tailwind v4 needs `@property` and `color-mix()`). `dvh`/`svh`/`lvh` need only Safari 15.4, so they add no new constraint.
- **Desktop behaviour must not change.** `vh`, `dvh`, `svh` and `lvh` all resolve identically without dynamic browser chrome, so the Task 1 sweep is a desktop no-op. Verify no desktop regression before claiming a task done.
- **Do not touch the deck builder.** `DeckBuilderPanel`'s `PointerSensor`, its missing `touch-action`, and `DeckCard`'s hover-only buttons are explicit non-goals. Desktop-first by decision.
- **Do not touch `layout.tsx`'s `maximumScale` / `userScalable`.** Explicit non-goal — iOS Safari has ignored both since iOS 10, so they are not part of this bug.
- **Do not touch `CardTable.tsx:394`.** It sizes from `window.innerHeight`, which is already correct on iOS.
- **`todo.md` is gitignored** (`.gitignore:9`). Never stage it.
- **Tests use no jest-dom matchers.** This repo asserts with `expect(...).toBeTruthy()`, not `toBeInTheDocument()`. Component tests need the `// @vitest-environment jsdom` pragma on line 1; there is no global setup file.
- **Always use `git -C /Users/arpanet/code/read-the-bones <cmd>`.** Never `cd && git`.
- **Branch:** work on `mobile-viewport-and-queue-handle`, which already exists and holds the design spec.
- **There are unrelated uncommitted changes** in `src/core/parseSheetRows.ts` and `src/core/parseSheetRows.test.ts`. They are not yours. Never stage them — always `git add` explicit paths, never `-A` or `.`.

---

### Task 1: Replace `vh` height utilities with `dvh`

**Files:**
- Create: `src/app/viewportUnits.test.ts`
- Modify: `src/app/components/CardStatsModal.tsx:193`
- Modify: `src/app/components/StatsModal.tsx:73`
- Modify: `src/app/components/Settings.tsx:175`
- Modify: `src/app/components/PageClient.tsx:164`, `src/app/components/PageClient.tsx:391`
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx:96`
- Modify: `src/app/components/draft-board/QueuePanel.tsx:423`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Task 2 edits `QueuePanel.tsx` too, so land this task first to avoid a conflict.

- [ ] **Step 1: Write the failing guard test**

Create `src/app/viewportUnits.test.ts`. This runs in the default `node` environment, so it needs no pragma. It scans `.tsx` sources — never itself, since it is `.ts` — so the regex literal below cannot match its own file.

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const APP_DIR = path.resolve(process.cwd(), "src/app");

function collectComponentFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectComponentFiles(full, out);
    } else if (full.endsWith(".tsx") && !full.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

// iOS Safari resolves `vh` against the large viewport — the height the page
// would have with the toolbars retracted. globals.css pins the shell to
// `100dvh` and sets `overflow: hidden`, so the toolbars never retract and a
// `vh`-sized box overflows the visible area with nothing able to scroll to it.
// `h-screen` and `min-h-screen` are Tailwind aliases for `100vh` and carry the
// same defect. The lookbehind lets `dvh`, `svh` and `lvh` through.
const VH_HEIGHT_UTILITY = /\b(?:max-h|min-h|h)-(?:\[[^\]]*(?<![a-z])vh[^\]]*\]|screen\b)/;

describe("viewport height units", () => {
  it("uses dvh rather than vh or screen for height utilities", () => {
    const offenders: string[] = [];

    for (const file of collectComponentFiles(APP_DIR)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (VH_HEIGHT_UTILITY.test(line)) {
            offenders.push(`${path.relative(APP_DIR, file)}:${index + 1}`);
          }
        });
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/viewportUnits.test.ts`

Expected: FAIL. The `offenders` array should list seven entries — `components/CardStatsModal.tsx:193`, `components/StatsModal.tsx:73`, `components/Settings.tsx:175`, `components/PageClient.tsx:164`, `components/PageClient.tsx:391`, `components/draft-board/DraftBoardModal.tsx:96`, `components/draft-board/QueuePanel.tsx:423`.

If the count differs, someone has added or removed a usage since this plan was written. Fix all of them, not just the seven listed.

- [ ] **Step 3: Make the swaps**

Change only the height utility in each class string; leave everything else on the line untouched.

| File | Line | From | To |
|---|---|---|---|
| `components/CardStatsModal.tsx` | 193 | `max-h-[90vh]` | `max-h-[90dvh]` |
| `components/StatsModal.tsx` | 73 | `max-h-[80vh]` | `max-h-[80dvh]` |
| `components/Settings.tsx` | 175 | `max-h-[80vh]` | `max-h-[80dvh]` |
| `components/PageClient.tsx` | 164 | `min-h-screen` | `min-h-dvh` |
| `components/PageClient.tsx` | 391 | `max-h-[95vh]` | `max-h-[95dvh]` |
| `components/draft-board/DraftBoardModal.tsx` | 96 | `max-h-[95vh]` | `max-h-[95dvh]` |
| `components/draft-board/QueuePanel.tsx` | 423 | `max-h-[30vh]` | `max-h-[30dvh]` |

Leave `DraftBoardModal.tsx:96`'s `max-w-[95vw]` alone. `vw` has no toolbar equivalent and is correct as written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/app/viewportUnits.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite for regressions**

Run: `pnpm test`
Expected: PASS. No existing test asserts on these class strings, so nothing should break.

- [ ] **Step 6: Typecheck, lint and knip**

Run: `pnpm typecheck && pnpm lint && pnpm knip`
Expected: all clean. `knip.json`'s `entry` glob is `src/app/**/*.{ts,tsx}`, so the new test file is an entry point and will not be reported unused.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add \
  src/app/viewportUnits.test.ts \
  src/app/components/CardStatsModal.tsx \
  src/app/components/StatsModal.tsx \
  src/app/components/Settings.tsx \
  src/app/components/PageClient.tsx \
  src/app/components/draft-board/DraftBoardModal.tsx \
  src/app/components/draft-board/QueuePanel.tsx
git -C /Users/arpanet/code/read-the-bones commit -m "Size modals against the visible viewport, not the retracted one

iOS Safari resolves vh against the large viewport while the shell is
pinned to 100dvh with scrolling disabled, so modals rendered taller than
the visible area and clipped at both edges with no way to reach the
remainder.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Make the `⠿` grip the drag activator

**Files:**
- Modify: `src/app/components/draft-board/QueuePanel.tsx`
- Test: `src/app/components/draft-board/QueuePanel.test.tsx` (exists, 259 lines — add to it)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a module-private `DragHandle` component in `QueuePanel.tsx`. Not exported; nothing outside the file depends on it.

**Background the implementer needs.** Queue rows currently spread `{...attributes} {...listeners}` onto the whole entry wrapper, so a press on any button inside a row bubbles to the drag sensor. Each of seven buttons tries to block that with `onPointerDown={(e) => e.stopPropagation()}`, but `QueuePanel` uses `MouseSensor` and `TouchSensor`, which activate on `onMouseDown` and `onTouchStart`. Stopping `pointerdown` holds off neither, so with `TouchSensor` at `delay: 500` any tap held past half a second becomes a drag and the click never fires.

`useDraggable` returns two refs for exactly this: `setNodeRef` marks the drag *source* (the rect that moves), `setActivatorNodeRef` marks what you grab. Moving the activator to the grip puts the buttons outside the draggable subtree, so the guards become unnecessary rather than merely fixed.

**Correction (found in final review): the six pre-existing `fireEvent.click` tests do not discharge the spec's call for "a direct regression test for defect 2."** `QueuePanel.test.tsx` covers all seven buttons via "calls onRemove when remove button clicked", "calls onSetEntryMode when mode toggled", "flow-through mode toggle calls onSetEntryMode with pause", "groups two single entries when the lower one's group button is clicked", "ejects a card from a group into its own entry after the group", and "reorders cards within a group via the up/down buttons" — but `fireEvent.click` in jsdom dispatches a synthetic click directly; it never engages `MouseSensor` or `TouchSensor`, so all six of these passed before this fix too and cannot regress it. Keeping them passing (Step 7) is still required — a real regression would still show up as one of them breaking — but they are not what proves the fix works. The actual regression protection is the three new structural tests added in Step 1, which assert the drag activator sits on the grip rather than the row.

- [ ] **Step 1: Write the failing tests**

Append these three tests inside the existing `describe("QueuePanel", ...)` block in `src/app/components/draft-board/QueuePanel.test.tsx`, after the last `it(...)` in that block (currently "collapses a two-card group to a single entry when one card is ejected", ending near line 228). They reuse the file's existing `defaultProps`, `singleEntryQueue` and `groupEntryQueue`.

```tsx
  it("puts the drag activator on the grip handle rather than the row", () => {
    render(<QueuePanel {...defaultProps} />);
    const handle = screen.getByRole("button", { name: "Reorder Lightning Bolt" });
    expect(handle.getAttribute("aria-roledescription")).toBe("draggable");
  });

  it("exposes one draggable activator per entry, each a real button", () => {
    const { container } = render(<QueuePanel {...defaultProps} />);
    const activators = container.querySelectorAll('[aria-roledescription="draggable"]');
    expect(activators.length).toBe(singleEntryQueue.length);
    activators.forEach((el) => expect(el.tagName).toBe("BUTTON"));
  });

  it("labels the group handle with the group size", () => {
    render(<QueuePanel {...defaultProps} queue={groupEntryQueue} />);
    expect(
      screen.getByRole("button", { name: "Reorder group of 3 cards" }),
    ).toBeTruthy();
  });
```

`aria-roledescription="draggable"` is dnd-kit's default, set in `core.cjs.development.js:3403`, and comes from the `attributes` object — so it lands wherever `attributes` is spread. That is what makes these a genuine test of the refactor.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/components/draft-board/QueuePanel.test.tsx`

Expected: the three new tests FAIL. The first and third fail with testing-library's "Unable to find an accessible element with the role \"button\"" — no such handle exists yet. The second fails on `expect(el.tagName).toBe("BUTTON")` receiving `"DIV"`, because `attributes` is currently spread on the row wrapper. The 20 pre-existing tests must still pass.

- [ ] **Step 3: Add the `DragHandle` component**

In `src/app/components/draft-board/QueuePanel.tsx`, extend the existing `@dnd-kit/core` import block (lines 4-18) with the two attribute types:

```tsx
  type DraggableAttributes,
  type DraggableSyntheticListeners,
```

Then add `DragHandle` immediately above the `// ─── Draggable Entry ───` section comment:

```tsx
// The grip is the sole drag activator, which keeps the buttons beside it
// clickable — they are no longer inside the draggable subtree, so no press on
// them can reach a drag sensor. A dedicated handle also removes the
// drag-versus-scroll ambiguity that the old 500ms touch delay existed to
// resolve. 44px is the minimum comfortable touch target; desktop shrinks it.
function DragHandle({
  setActivatorNodeRef,
  attributes,
  listeners,
  label,
}: {
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  label: string;
}) {
  return (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center border-none bg-transparent p-0 leading-none text-zinc-600 select-none active:cursor-grabbing sm:h-5 sm:w-5"
    >
      ⠿
    </button>
  );
}
```

`aria-label` goes after the spreads so `attributes` can never shadow it.

- [ ] **Step 4: Rewire `DraggableEntry` to use the handle**

Destructure the new ref on line 159:

```tsx
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } =
    useDraggable({ id: makeDragEntryId(entryIndex) });
```

Replace the group branch's wrapper and grip (currently lines 186-196) with:

```tsx
      <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} className="select-none">
        <div className={`rounded px-2 py-2.5 sm:py-1.5 text-sm sm:text-xs border border-zinc-700/60 bg-zinc-800/50 ${allTaken ? "opacity-40" : ""}`}>
          <div className="flex items-center gap-1.5">
            <DragHandle
              setActivatorNodeRef={setActivatorNodeRef}
              attributes={attributes}
              listeners={listeners}
              label={`Reorder group of ${entry.cards.length} cards`}
            />
            <span className="flex-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              Group ({entry.cards.length})
            </span>
            {groupButton}
            {modeToggle}
          </div>
```

Three things changed: `{...attributes} {...listeners}` are gone from the outer `div`, `cursor-grab` is gone from the inner `div`, and the decorative `<span ...>⠿</span>` is now `<DragHandle />`.

Replace the single-card branch (currently lines 221-240) with:

```tsx
  return (
    <div ref={setNodeRef} style={{ opacity: isDragging ? 0.3 : 1 }} className="select-none">
      <div className="flex items-center gap-1.5 rounded px-2 py-2.5 sm:py-1 text-sm sm:text-xs border border-transparent bg-zinc-800/30">
        <DragHandle
          setActivatorNodeRef={setActivatorNodeRef}
          attributes={attributes}
          listeners={listeners}
          label={`Reorder ${card.cardName}`}
        />
        <span className={`flex-1 ${isTaken ? "text-zinc-600 line-through" : "text-zinc-300"}`}>
          {card.cardName}
        </span>
        {groupButton}
        {modeToggle}
        <button
          onClick={() => onRemove(card.cardName)}
          aria-label={`Remove ${card.cardName}`}
          className="cursor-pointer border-none bg-transparent px-2.5 py-1.5 sm:px-1 sm:py-0.5 text-lg sm:text-sm leading-none text-zinc-500 hover:text-zinc-300"
        >
          &times;
        </button>
      </div>
    </div>
  );
```

- [ ] **Step 5: Delete the seven dead guards**

Remove every `onPointerDown={(e) => e.stopPropagation()}` line in this file. Before the edits above there were seven, at lines 94, 109, 124, 168, 232, 279 and 288 — the two `MoveButtons` arrows, `GroupButton`, `modeToggle`, the single-card remove `×`, and `GroupCard`'s eject `⏏` and remove `×`. Step 4 already removed the one at 232.

Verify none remain:

Run: `grep -n "stopPropagation" src/app/components/draft-board/QueuePanel.tsx`
Expected: no output.

- [ ] **Step 6: Drop the touch activation delay**

Replace the `TouchSensor` line in the `useSensors` call (currently line 314):

```tsx
    useSensor(TouchSensor, { activationConstraint: { distance: 8 } }),
```

The `delay: 500` existed only to tell a drag from a scroll when the whole row was grabbable. The handle carries `touch-action: none`, so the browser will not claim the gesture and a distance threshold is enough. `MouseSensor`'s `{ distance: 5 }` is unchanged.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/components/draft-board/QueuePanel.test.tsx`
Expected: PASS — all 23 tests, the 20 pre-existing plus the 3 new.

If a pre-existing test now fails, do not edit it to suit the change. The old tests use `fireEvent.click`, which is unaffected by which element holds the drag listeners, so a failure means the refactor broke real behaviour.

- [ ] **Step 8: Run the full suite, typecheck, lint and knip**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm knip`
Expected: all clean.

- [ ] **Step 9: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add \
  src/app/components/draft-board/QueuePanel.tsx \
  src/app/components/draft-board/QueuePanel.test.tsx
git -C /Users/arpanet/code/read-the-bones commit -m "Make the queue grip the drag activator instead of the whole row

The row-level listeners meant every button needed a guard against
starting a drag, and those guards stopped pointerdown while the sensors
activate on mousedown and touchstart — so a tap held past the 500ms
touch delay became a drag and never fired the click. Anchoring the
activator to the grip puts the buttons outside the draggable subtree
and lets the delay drop to a distance threshold.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Mobile e2e coverage for the priority flow

**Files:**
- Create: `e2e/flows/mobile.spec.ts`
- Modify: `e2e/playwright.config.ts:18-23`

**Interfaces:**
- Consumes: `createMockContext(page, "live-draft")` from `e2e/helpers/mock-api.ts`; `authenticateAs(page, { draftId })` from `e2e/helpers/auth.ts`; `openCardStatsModal(page, cardName)` from `e2e/helpers/assertions.ts`; `scrollCardTable(page, scrollTop)` and `getVisibleCardNames(page)` from `e2e/helpers/card-table.ts`.
- Produces: nothing importable.

**What this can and cannot catch.** Headless Chrome has no browser chrome, so `vh === dvh` there and Task 1's bug is invisible to Playwright. This task covers the priority flow's tap targets and reachability at 375×667 — it is not a regression test for the `dvh` fix, and nothing automated can be. Do not claim otherwise in the commit message.

- [ ] **Step 1: Add the mobile project to the Playwright config**

Replace the `projects` array in `e2e/playwright.config.ts` (lines 18-23) with:

```ts
  projects: [
    {
      name: "chromium",
      testIgnore: "**/mobile.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      testMatch: "**/mobile.spec.ts",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 667 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
```

`testIgnore` on the desktop project stops the mobile spec running twice. The mobile project stays on Chromium rather than a WebKit device descriptor so no extra browser download is needed — `CLAUDE.md` documents chromium as the only required install.

- [ ] **Step 2: Write the failing spec**

Create `e2e/flows/mobile.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import { openCardStatsModal } from "../helpers/assertions";
import { scrollCardTable, getVisibleCardNames } from "../helpers/card-table";

// Minimal card stats response for the stats modal
const cardStatsResponse = {
  pick: {
    drafts_in_pool: 3,
    times_picked: 2,
    avg_pick: 10,
    median_pick: 9,
    geomean_pick: 8.5,
  },
  pick_history: [
    {
      draftId: "alpha",
      draftName: "Alpha Draft",
      draftDate: "2026-01-01",
      pickPosition: 8,
      picked: true,
      numSeats: 10,
    },
  ],
  pick_distribution: [0, 1, 0, 1, 0],
  times_banned: 0,
  color_pair_breakdown: [],
};

// The reported failures were on a 375x667 iPhone SE. Headless Chrome has no
// browser chrome, so vh and dvh are identical here and this suite cannot see
// the clipping bug — it covers the priority flow's reachability only.
test.describe("Mobile priority flow", () => {
  test.beforeEach(async ({ page }) => {
    await authenticateAs(page, { draftId: "gamma" });
    await createMockContext(page, "live-draft");
    await page.route("**/api/cards/stats*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(cardStatsResponse),
      }),
    );
  });

  test("card table renders and scrolls", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    const before = await getVisibleCardNames(page);
    expect(before.length).toBeGreaterThan(0);

    await scrollCardTable(page, 400);

    const after = await getVisibleCardNames(page);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  test("the card modal fits the viewport and its close button is reachable", async ({ page }) => {
    await page.goto("/");
    await openCardStatsModal(page, "Sylvan Library");

    const close = page.getByLabel("Close");
    await expect(close).toBeVisible();

    const box = await close.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });

  test("the hold-to-pick button is fully inside the viewport", async ({ page }) => {
    await page.goto("/");
    await openCardStatsModal(page, "Sylvan Library");

    const pick = page.getByLabel("Hold to pick this card");
    await pick.scrollIntoViewIfNeeded();
    await expect(pick).toBeVisible();

    const box = await pick.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });
});
```

The `live-draft` scenario fixture sets `nextSeat` to 3 and authenticates as seat 3, so `isMyTurn` is true and `HoldToPickButton` renders. Its `aria-label` is `"Hold to pick this card"` (`HoldToPickButton.tsx:28`).

- [ ] **Step 3: Run the mobile project**

Run: `pnpm exec playwright test --config e2e/playwright.config.ts --project mobile-chromium`

Expected: PASS. If Chromium is missing, install it first with `npx playwright install chromium`.

If "the card table renders and scrolls" fails on `expect(after).not.toEqual(before)`, the virtualizer may not have re-rendered — check that `scrollCardTable`'s `div[style*="overflow-y: auto"]` selector still matches, since `CardTable.tsx:428` sets that style inline.

- [ ] **Step 4: Run the desktop project to confirm no double-run or regression**

Run: `pnpm exec playwright test --config e2e/playwright.config.ts --project chromium`
Expected: PASS, and `mobile.spec.ts` must not appear in the output.

- [ ] **Step 5: Run the whole check suite**

Run: `pnpm precommit`
Expected: PASS. This runs typecheck → lint → knip → unit tests → e2e, and a husky pre-push hook enforces it anyway, so catching failures here is cheaper.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add \
  e2e/flows/mobile.spec.ts \
  e2e/playwright.config.ts
git -C /Users/arpanet/code/read-the-bones commit -m "Cover the mobile priority flow at 375x667

Exercises scroll table, open card, and reach the pick button on the
viewport the failures were reported from. Headless Chrome has no browser
chrome, so this cannot see the vh/dvh clipping itself — that still needs
the physical device.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Record the deferred follow-ups**

Append to `todo.md`. **Do not stage or commit it** — it is gitignored at `.gitignore:9`.

```markdown
## Mobile follow-ups (deferred from 2026-08-08 mobile fix)

- Deck-builder touch drag: DeckBuilderPanel uses PointerSensor with no
  `touch-action: none` on DeckCard, so iOS claims the gesture and fires
  pointercancel. Desktop-first by decision.
- DeckCard's remove-float and queue-toggle buttons are
  `opacity-0 group-hover/card:opacity-100`, so they are invisible on touch.
- layout.tsx `maximumScale: 1` / `userScalable: false` are a WCAG 2.1 SC 1.4.4
  failure. iOS Safari ignores them, but Android Chrome and iOS in-app WebViews
  honour them. Removing them is an audit-signal tidy-up.
- CardTable.tsx:394's `Math.max(400, ...)` floor can exceed available height in
  landscape on a short phone, pushing the table bottom into the unscrollable
  region.
- QueuePanel could unify on PointerSensor to match DeckBuilderPanel, but
  dnd-kit's TouchSensor has a `static setup()` registering a non-passive
  touchmove listener commented "required for iOS Safari" that PointerSensor
  lacks. Needs real-device verification before switching.
```

---

## Final verification

- [ ] **Confirm the working tree holds only intended changes**

Run: `git -C /Users/arpanet/code/read-the-bones status -s`
Expected: only `src/core/parseSheetRows.ts` and `src/core/parseSheetRows.test.ts` remain modified — those were dirty before this work and must stay uncommitted.

- [ ] **Confirm the commit log**

Run: `git -C /Users/arpanet/code/read-the-bones log --oneline master..HEAD`
Expected: four commits — the design spec, then Tasks 1, 2 and 3.

- [ ] **Hand back to the user for device testing**

The `dvh` fix cannot be verified by any automated check in this repo. Tell the user it needs confirming on the reporting device, ideally over Safari Web Inspector (iPhone Settings → Safari → Advanced → Web Inspector, then connect to a Mac). Until then the fix is reasoned and reproduced-in-simulation, not confirmed.
