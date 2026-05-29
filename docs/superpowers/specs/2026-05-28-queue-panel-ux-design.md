# Queue Panel UX: How-To Section + Buttons-Only Grouping

## Context

After running a live draft, players gave two pieces of feedback about the
live-draft UI:

1. **Queue vs. float is confusing.** People could not tell the difference
   between queueing a card and floating it. (Queue = will be auto-picked on
   your turn; float = a private watchlist that is never auto-picked.)
2. **The queue's drag-and-drop felt finicky.** It relied on `@dnd-kit` for
   reordering, grouping (hold-to-merge), *and* ungrouping (drag a card out), all
   on one gesture. Follow-up feedback clarified the real problem: players value
   drag-and-drop for reordering (especially on mobile and for moving cards more
   than a few slots), but the **hold-to-merge grouping kept triggering by
   accident** when they only wanted to slide the order around. Drag-and-drop
   "worked well before grouping, then got finicky." Even grouping's original
   requester said they'd rather lose grouping than the drag reordering.

This spec covers two independent changes, shipped as **separate commits** so the
queue rework can be reverted on its own if feedback turns.

## Part 1 — "How it works" help section

Add a collapsible **"How it works"** section to the Settings panel, in its own
component (`src/app/components/HowItWorks.tsx`) so `Settings.tsx` stays small.
Collapsed by default. Content adapted from the explanation given to players,
using the existing **pause / flow-through** terminology (not "cautious /
resilient", which were deliberately retired):

- **What RTB is** — a combined draft + stats app.
- **Your seat link** — unique per player; don't share it; the device remembers
  your seat afterward.
- **The three views** — card list (stats + Scryfall-style search), deck builder
  (your picked / queued / floated cards), pod view (everyone's picks; pick here
  on your turn; manage your queue).
- **Auto-pick** — when on, your turn auto-takes the next available queued card.
- **Queue vs. float** — queue = will be picked on your turn (if auto-pick is
  on); float = a private watchlist, never auto-picked.
- **Pause vs. flow-through** — pause: if your top card was taken, auto-pick
  switches off so you can reassess; flow-through: just take the next available
  card.
- **Grouping** — "any one of these" (e.g. three removal spells). When one card
  in a group is picked, the whole group leaves your queue.
- **Privacy** — picks are public; queues and floats are private.

No data or API changes — static content rendered from Settings.

## Part 2 — Queue panel: drag reorders, buttons group

Rework `src/app/components/draft-board/QueuePanel.tsx` to **separate the two
gestures that were entangled**: drag-and-drop becomes reorder-only, and grouping
moves to explicit buttons. This keeps the drag-and-drop players liked while
removing the accidental grouping that made it feel finicky.

**Drag-and-drop (kept, simplified):**

- Only **top-level entries** are draggable, and only to **reorder** them. A
  group moves as a single unit. Reuse `@dnd-kit` with `DropSlot` insertion lines
  between entries and a `DragOverlay`.
- Remove the grouping/ungrouping drag paths entirely: no merge zones, no
  hold-to-merge timer, no within-group card dragging, no drag-a-card-out-to-
  ungroup. Collision detection collapses to plain `closestCenter` over the slots.
- Drop the per-entry **▲▼ move** buttons — dragging now does that job
  (the keyboard sensor keeps it accessible).

**Grouping (now buttons, never drag):**

- **Group button (`⧉`) per entry** — merges this entry with the entry *above*
  it. One button covers all cases: group two adjacent cards via the lower one's
  `⧉`; for distant cards, drag them adjacent first, then `⧉`. Disabled on the
  first entry. Merge rules:
  - single + single → new group, upper card first
  - single + group, or group + group → concatenate all cards into one group
  - the resulting group keeps the **upper** entry's mode
- **Eject button (`⏏`) per grouped card** — pulls that card out into its own
  standalone entry, placed immediately after the group. If a group drops to one
  card it collapses back to a single entry (the existing `cards.length > 1`
  rule).
- **Within-group reorder** stays on **▲▼** buttons on each grouped card (groups
  are small; this avoids re-introducing the in-group drag that caused trouble).

The **⏸ / ▶ mode** toggle and per-card **× remove** are unchanged.

**Dropped:** moving a card directly between two groups (do it via eject + group).

### Implementation notes

- No new store actions. Reordering, grouping, and ejecting all build a new queue
  array and call the existing `onReorder` prop. Helpers: `handleMoveCard`
  (within group), `handleGroupWithAbove(entryIndex)`, `handleEject(entryIndex,
  cardIndex)`, and the drag-end reorder handler.
- `QueuePanel.test.tsx` drives the buttons (group / eject / within-group move).
  Cover: group single+single, add single to group, group+group merge, eject to
  standalone, group collapsing to a single on eject, within-group move, and the
  disabled-on-first-entry case. The drag-reorder slot math is extracted into a
  pure `reorderEntryToSlot` helper and unit-tested directly (the dnd-kit drag
  *gesture* itself isn't automatable in jsdom, so it's verified manually).

### Resulting layout

```
Pick Queue              Auto-pick ☑
─────────────────────────────────────
⠿ Lightning Bolt      [⧉][⏸][×]      ← drag any row to reorder
⠿ Doom Blade          [⧉][⏸][×]      ← press ⧉ → GROUP{Bolt, Doom}
⠿ GROUP (2)           [⧉][▶]
    Teferi            [▲▼][⏏][×]      ← ⏏ ejects Teferi to its own entry
    Snapcaster        [▲▼][⏏][×]
```

## Verification

- `pnpm precommit` (typecheck → lint → knip → tests → e2e) on each commit.
- Part 1: open Settings, expand "How it works", confirm content and that it
  collapses by default.
- Part 2: in the pod view, exercise move / group / eject via buttons; confirm
  grouping rules, eject placement, group→single collapse, and that auto-pick
  still consumes groups correctly. Screenshot the reworked panel.
