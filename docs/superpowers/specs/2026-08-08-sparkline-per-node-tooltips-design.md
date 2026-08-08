# Sparkline Per-Node Tooltips

## Problem

The pick history sparkline in the card stats modal shows a single tooltip listing
every draft date and pick number at once. With many drafts the list is long, needs
its own scrollbar (`max-h-32 overflow-y-auto`), and forces the reader to map a row
in the list back to a dot on the chart by eye.

## Goal

Hovering a dot shows a tooltip for that dot only: its date and pick label.

## Design

`Sparkline` gains a `hoveredIndex` state (`number | null`). It renders one tooltip,
positioned at the hovered node, instead of the always-composed full list.

### Hover targets

The visible dots are `r=3.5` — too small to hover reliably. Each node gets a
transparent circle of `r=9` on top of the visible dot that owns the
`onMouseEnter` / `onMouseLeave` handlers. The visible dot grows to `r=5` while
hovered so the tooltip's subject is unambiguous.

### Tooltip placement

The tooltip stays anchored above the whole SVG (`bottom-full`, as today) rather
than above the individual dot. Dots sit at varying heights; a tooltip that tracked
each dot's `y` would overlap the line and neighbouring dots. Anchoring above the
chart keeps it clear of the data and keeps it inside the modal's `overflow-y-auto`
box, which is why the current implementation opens upward.

Horizontal placement follows the hovered dot's `x`. Because the chart is only
160px wide and the tooltip is wider than a single node's slot, a centred tooltip
would spill past the container at both ends. Alignment is picked from which third
of the chart the dot falls in — no measurement needed:

- left third: tooltip's left edge at the dot (`translateX(0)`)
- middle third: centred on the dot (`translateX(-50%)`)
- right third: tooltip's right edge at the dot (`translateX(-100%)`)

### Label formatting

The existing three-case label logic (aggregated picked, aggregated unpicked, single
draft) moves out of the JSX map into a `formatPickLabel(entry: DraftScore): string`
helper in the same file. Same strings as today:

- aggregated, some picked: `Pick 12 (4/5)`
- aggregated, none picked: `unpicked (0/5)`
- single draft, picked: `Pick 12`
- single draft, unpicked: `unpicked`

Tooltip content stays `<date>: <label>`.

### What does not change

- The chart geometry, colours, line path, and `draftTimeline` x-positioning.
- The empty-history early return.
- `CardStatsModal`'s call site and `aggregateByDate`.

## Testing

New `Sparkline.test.tsx` (vitest + jsdom + testing-library, matching
`CardStatsModal.test.tsx`):

- no tooltip is rendered before any hover
- hovering the second node shows only that node's date and pick label
- moving off the node removes the tooltip
- an aggregated entry renders the `(picked/total)` suffix, and an aggregated entry
  with zero picks renders `unpicked (0/N)`

Hover targets are found by `data-testid` on the transparent circles, since SVG
circles have no accessible role to query by.

## Non-goals

Touch and keyboard access. The sparkline is hover-only today; changing that is a
separate concern from splitting the tooltip.
