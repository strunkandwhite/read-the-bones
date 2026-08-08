# Sparkline Per-Node Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the pick history sparkline's single all-dates tooltip with one tooltip per dot, showing only the hovered draft's date and pick label.

**Architecture:** `Sparkline` (`src/app/components/Sparkline.tsx`) is a single client component that renders an SVG chart plus a CSS-hover tooltip `div`. The tooltip becomes state-driven: a `hoveredIndex` state set by transparent hover-target circles layered over the small visible dots, and one tooltip rendered for that index. The label-formatting logic currently inlined in the tooltip's `.map()` moves into a `formatPickLabel` helper in the same file.

**Tech Stack:** React 19 (client component), TypeScript, Tailwind CSS v4, Vitest + jsdom + @testing-library/react.

## Global Constraints

- Component is client-side (`"use client"` already at the top of the file) — hooks are allowed.
- `pnpm lint` runs ESLint with zero warnings allowed; `pnpm knip` fails on unused exports. Do not export anything the tests do not import, and do not export `formatPickLabel` unless a test imports it — it stays module-private and is exercised through rendered output.
- Chart geometry (`width = 160`, `height = 48`, `padding = 4`, `dotRadius = 3.5`), colors (`#3b82f6` picked, `#ef4444` unpicked, `#a1a1aa` line), the line path, and the `draftTimeline` x-positioning are unchanged.
- Tooltip text format is unchanged: `` `${date}: ${label}` `` where label is `Pick N`, `Pick N (p/t)`, `unpicked`, or `unpicked (0/t)`.
- The empty-history early return (`<span className="text-xs text-zinc-400">-</span>`) is unchanged.
- `CardStatsModal.tsx` and its `aggregateByDate` helper are not modified by this plan.
- Tests live beside the source file as `src/app/components/Sparkline.test.tsx`, matching `CardStatsModal.test.tsx`, and start with the `// @vitest-environment jsdom` comment.
- The project has `@testing-library/react` and `jsdom` but **not** `@testing-library/jest-dom` or `@testing-library/user-event`. Use plain Vitest matchers (`toBeDefined`, `toBeNull`, `toBe`, `toHaveLength`) — not `toBeInTheDocument` — and drive interaction with `fireEvent`.

---

### Task 1: `formatPickLabel` helper

Extract the three-case tooltip label logic out of the JSX map into a named helper, with no behavior change. This is a pure refactor — the existing single all-dates tooltip still renders after this task.

**Files:**
- Modify: `src/app/components/Sparkline.tsx:90-109` (the tooltip `div` and its `.map()`)
- Test: `src/app/components/Sparkline.test.tsx` (create)

**Interfaces:**
- Consumes: `DraftScore` from `@/core/types` (already imported by `Sparkline.tsx`). Relevant fields: `date: string`, `pickPosition: number`, `wasPicked: boolean`, `pickedCount?: number`, `totalCount?: number`.
- Produces: module-private `function formatPickLabel(entry: DraftScore): string` in `Sparkline.tsx`. Task 2 calls it for the hovered entry.

- [ ] **Step 1: Write the failing test**

Create `src/app/components/Sparkline.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Sparkline } from "./Sparkline";
import type { DraftScore } from "@/core/types";

afterEach(cleanup);

function makeEntry(overrides: Partial<DraftScore> & { date: string }): DraftScore {
  return {
    draftId: "d1",
    draftName: "Test Draft",
    pickPosition: 12,
    wasPicked: true,
    numDrafters: 10,
    round: 2,
    ...overrides,
  };
}

describe("Sparkline label formatting", () => {
  it("labels a single picked draft with its pick position", () => {
    render(<Sparkline history={[makeEntry({ date: "2026-04-01", pickPosition: 12 })]} />);
    expect(screen.getByText("2026-04-01: Pick 12")).toBeDefined();
  });

  it("labels a single unpicked draft as unpicked", () => {
    render(
      <Sparkline
        history={[makeEntry({ date: "2026-04-01", pickPosition: 540, wasPicked: false })]}
      />,
    );
    expect(screen.getByText("2026-04-01: unpicked")).toBeDefined();
  });

  it("labels an aggregated date with a picked/total suffix", () => {
    render(
      <Sparkline
        history={[
          makeEntry({ date: "2026-04-01", pickPosition: 12, pickedCount: 4, totalCount: 5 }),
        ]}
      />,
    );
    expect(screen.getByText("2026-04-01: Pick 12 (4/5)")).toBeDefined();
  });

  it("labels an aggregated date with no picks as unpicked with a total", () => {
    render(
      <Sparkline
        history={[
          makeEntry({
            date: "2026-04-01",
            pickPosition: 540,
            wasPicked: false,
            pickedCount: 0,
            totalCount: 5,
          }),
        ]}
      />,
    );
    expect(screen.getByText("2026-04-01: unpicked (0/5)")).toBeDefined();
  });
});
```

Note: these four tests pass against the *current* component too — the single all-dates tooltip renders the same strings, always in the DOM (it is hidden with `hidden group-hover:block`, and `getByText` does not care about CSS visibility). That is intentional: they pin the label strings so the Task 1 refactor and the Task 2 rewrite cannot silently change them.

- [ ] **Step 2: Run the test to verify it passes against the current component**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm vitest run src/app/components/Sparkline.test.tsx`
Expected: 4 tests PASS. If any fails, the label strings were transcribed wrong — fix the test to match the current component before continuing, since this task is a no-behavior-change refactor.

- [ ] **Step 3: Extract the helper**

In `src/app/components/Sparkline.tsx`, add this above the `Sparkline` function (below the imports):

```tsx
/**
 * Tooltip label for one point: "Pick 12", "Pick 12 (4/5)" for aggregated dates,
 * or the unpicked equivalents.
 */
function formatPickLabel(entry: DraftScore): string {
  if (entry.pickedCount !== undefined && entry.totalCount !== undefined) {
    return entry.pickedCount === 0
      ? `unpicked (0/${entry.totalCount})`
      : `Pick ${entry.pickPosition} (${entry.pickedCount}/${entry.totalCount})`;
  }
  return entry.wasPicked ? `Pick ${entry.pickPosition}` : "unpicked";
}
```

Then replace the tooltip `div`'s body (the `history.map(...)` block at lines ~91-108) with:

```tsx
        {history.map((h, i) => (
          <div key={i}>
            {h.date}: {formatPickLabel(h)}
          </div>
        ))}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm vitest run src/app/components/Sparkline.test.tsx && pnpm typecheck`
Expected: 4 tests PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/components/Sparkline.tsx src/app/components/Sparkline.test.tsx
git -C /Users/arpanet/code/read-the-bones commit -m "Extract sparkline tooltip label formatting into a helper

Pins the label strings with tests before the per-node tooltip rewrite."
```

---

### Task 2: Per-node hover tooltip

Replace the always-rendered list of every date with a single tooltip for the hovered node, driven by `hoveredIndex` state and transparent hover-target circles.

**Files:**
- Modify: `src/app/components/Sparkline.tsx` (imports, component body, SVG dots, tooltip `div`)
- Test: `src/app/components/Sparkline.test.tsx` (modify — the four Task 1 tests must be updated, see Step 1)

**Interfaces:**
- Consumes: `formatPickLabel(entry: DraftScore): string` from Task 1.
- Produces: nothing exported. Hover targets carry `data-testid={`sparkline-hit-${i}`}`; the tooltip carries `data-testid="sparkline-tooltip"`.

- [ ] **Step 1: Rewrite the tests for hover-driven tooltips**

The Task 1 tests assume every label is in the DOM at all times. That stops being true. Replace the whole contents of `src/app/components/Sparkline.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Sparkline } from "./Sparkline";
import type { DraftScore } from "@/core/types";

afterEach(cleanup);

function makeEntry(overrides: Partial<DraftScore> & { date: string }): DraftScore {
  return {
    draftId: "d1",
    draftName: "Test Draft",
    pickPosition: 12,
    wasPicked: true,
    numDrafters: 10,
    round: 2,
    ...overrides,
  };
}

const THREE_DRAFTS: DraftScore[] = [
  makeEntry({ date: "2026-04-01", pickPosition: 12 }),
  makeEntry({ date: "2026-05-01", pickPosition: 30 }),
  makeEntry({ date: "2026-06-01", pickPosition: 7 }),
];

// React synthesizes onMouseEnter/onMouseLeave from delegated mouseover/mouseout
// events, so firing "mouseEnter" directly does nothing — fire mouseOver/mouseOut.
function hover(index: number) {
  fireEvent.mouseOver(screen.getByTestId(`sparkline-hit-${index}`));
}

function unhover(index: number) {
  fireEvent.mouseOut(screen.getByTestId(`sparkline-hit-${index}`));
}

describe("Sparkline", () => {
  it("renders a hover target per point and no tooltip until hovered", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    expect(screen.getAllByTestId(/^sparkline-hit-/)).toHaveLength(3);
    expect(screen.queryByTestId("sparkline-tooltip")).toBeNull();
  });

  it("shows only the hovered point's date and pick label", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(1);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-05-01: Pick 30");
    expect(screen.queryByText("2026-04-01: Pick 12")).toBeNull();
    expect(screen.queryByText("2026-06-01: Pick 7")).toBeNull();
  });

  it("swaps the tooltip when a different point is hovered", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(1);
    hover(2);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-06-01: Pick 7");
  });

  it("hides the tooltip when the pointer leaves the point", () => {
    render(<Sparkline history={THREE_DRAFTS} />);
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip")).toBeDefined();
    unhover(0);
    expect(screen.queryByTestId("sparkline-tooltip")).toBeNull();
  });

  it("labels a single unpicked draft as unpicked", () => {
    render(
      <Sparkline
        history={[makeEntry({ date: "2026-04-01", pickPosition: 540, wasPicked: false })]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: unpicked");
  });

  it("labels an aggregated date with a picked/total suffix", () => {
    render(
      <Sparkline
        history={[
          makeEntry({ date: "2026-04-01", pickPosition: 12, pickedCount: 4, totalCount: 5 }),
        ]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: Pick 12 (4/5)");
  });

  it("labels an aggregated date with no picks as unpicked with a total", () => {
    render(
      <Sparkline
        history={[
          makeEntry({
            date: "2026-04-01",
            pickPosition: 540,
            wasPicked: false,
            pickedCount: 0,
            totalCount: 5,
          }),
        ]}
      />,
    );
    hover(0);
    expect(screen.getByTestId("sparkline-tooltip").textContent).toBe("2026-04-01: unpicked (0/5)");
  });

  it("renders a dash when there is no history", () => {
    render(<Sparkline history={[]} />);
    expect(screen.getByText("-")).toBeDefined();
    expect(screen.queryByTestId(/^sparkline-hit-/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm vitest run src/app/components/Sparkline.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="sparkline-hit-0"]`, because the component does not render hover targets yet.

- [ ] **Step 3: Add hover state and hover targets**

In `src/app/components/Sparkline.tsx`:

Change the React import line. The file currently imports only the type; add:

```tsx
import { useState } from "react";
```

Inside the component, **above** the `if (!history || history.length === 0)` early return (hooks must not sit below a conditional return):

```tsx
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
```

Replace the dots block (the `normalizedPoints.map` rendering `<circle>`) with the visible dot plus a transparent, larger hover target per node:

```tsx
        {/* Dots for each draft */}
        {normalizedPoints.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={hoveredIndex === i ? dotRadius + 1.5 : dotRadius}
            fill={p.wasPicked ? "#3b82f6" : "#ef4444"}
            stroke="white"
            strokeWidth={1}
          />
        ))}
        {/* Transparent hover targets — the visible dots are too small to hit reliably */}
        {normalizedPoints.map((p, i) => (
          <circle
            key={`hit-${i}`}
            data-testid={`sparkline-hit-${i}`}
            cx={p.x}
            cy={p.y}
            r={9}
            fill="transparent"
            onMouseEnter={() => setHoveredIndex(i)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
        ))}
```

- [ ] **Step 4: Replace the tooltip with a single per-node tooltip**

Still in `src/app/components/Sparkline.tsx`, replace the whole tooltip `div` (the one with `pointer-events-none absolute bottom-full ... group-hover:block` and its `history.map`) with:

```tsx
      {hoveredIndex !== null && (
        <div
          data-testid="sparkline-tooltip"
          className="pointer-events-none absolute bottom-full z-50 mb-1 rounded bg-zinc-800 px-2 py-1 text-xs whitespace-nowrap text-white"
          style={{
            left: normalizedPoints[hoveredIndex].x,
            transform: `translateX(${tooltipShift(normalizedPoints[hoveredIndex].x, width)})`,
          }}
        >
          {history[hoveredIndex].date}: {formatPickLabel(history[hoveredIndex])}
        </div>
      )}
```

The wrapper `div`'s `group` class is no longer used by anything — change `className="group relative"` to `className="relative"`.

Add this helper next to `formatPickLabel`:

```tsx
/**
 * Horizontal shift for a tooltip anchored at `x` on a chart `width` wide.
 * The tooltip is wider than a point's slot, so it is left-aligned, centered, or
 * right-aligned depending on which third of the chart the point falls in —
 * centering everything would spill past both ends.
 */
function tooltipShift(x: number, width: number): string {
  if (x < width / 3) return "0";
  if (x > (width * 2) / 3) return "-100%";
  return "-50%";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm vitest run src/app/components/Sparkline.test.tsx`
Expected: all 8 tests PASS.

- [ ] **Step 6: Run the full quality gate**

Run: `cd /Users/arpanet/code/read-the-bones && pnpm typecheck && pnpm lint && pnpm knip && pnpm test`
Expected: all clean. `knip` in particular must not report `formatPickLabel` or `tooltipShift` as unused — both are called inside the component.

- [ ] **Step 7: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/components/Sparkline.tsx src/app/components/Sparkline.test.tsx
git -C /Users/arpanet/code/read-the-bones commit -m "Show one sparkline tooltip per node instead of every date at once

The combined tooltip needed its own scrollbar and made the reader match a
list row back to a dot by eye."
```

---

## Verification

After Task 2, confirm the rendered result in the real app rather than only in jsdom:

- [ ] Run `pnpm dev`, open the app, click a card with several drafts of pick history to open the card stats modal.
- [ ] Hover each dot in the Pick History sparkline: the tooltip shows that dot's date and pick label only, the hovered dot grows, and the tooltip does not spill outside the modal at either end of the chart.
- [ ] Kill the dev server when done.
