# Queue Panel UX: How-To Section + Buttons-Only Grouping

## Context

After running a live draft, players gave two pieces of feedback about the
live-draft UI:

1. **Queue vs. float is confusing.** People could not tell the difference
   between queueing a card and floating it. (Queue = will be auto-picked on
   your turn; float = a private watchlist that is never auto-picked.)
2. **Drag-and-drop is hard to use**, especially on mobile. The pick queue in
   the pod view relies on `@dnd-kit` for reordering, grouping (hold-to-merge),
   and ungrouping (drag a card out). Players struggled with all of it.

This spec covers two independent changes, to be shipped as **separate commits**
so the drag-and-drop removal can be reverted on its own if feedback turns.

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

## Part 2 — Queue panel: remove drag-and-drop, button-based grouping

Rework `src/app/components/draft-board/QueuePanel.tsx` to remove all `@dnd-kit`
usage. (`@dnd-kit` stays a dependency — the deck builder still uses it; out of
scope here.) The panel becomes plain rows plus buttons.

**Kept as-is:** the per-entry **▲▼ move** buttons (entries and within-group
cards both already have these), the **⏸ / ▶ mode** toggle, and the **× remove**
button.

**Added:**

- **Group button (`⊓`) per entry** — merges this entry with the entry *above*
  it. One button is sufficient for all grouping: group two adjacent cards by
  pressing the lower one's `⊓`; group with a card below by pressing *its* `⊓`;
  group distant cards by moving them adjacent first. Disabled on the first
  entry. Merge rules:
  - single + single → new group, upper card first
  - single + group, or group + group → concatenate all cards into one group
  - the resulting group keeps the **upper** entry's mode

  A single button (rather than group-up *and* group-down) keeps rows uncluttered
  — directly addressing the mobile complaint.

- **Eject button (`⤷`) per grouped card** — pulls that card out of its group
  into its own standalone entry, placed immediately after the group. If a group
  drops to one card, it collapses back to a normal single entry (consistent with
  the existing `cards.length > 1` group rule).

**Dropped:** moving a card directly between two groups. The same result is
reached by eject + group.

### Implementation notes

- No new store actions. Grouping and ejecting build a new queue array and call
  the existing `onReorder` prop — exactly as the old drag handlers did. The
  existing `handleMoveEntry` / `handleMoveCard` helpers are reused; add
  `handleGroupWithAbove(entryIndex)` and `handleEject(entryIndex, cardIndex)`.
- Remove `DndContext`, `DragOverlay`, sensors, collision detection, `DropSlot`,
  the draggable wrappers, and the `⠿` drag handles.
- `QueuePanel.test.tsx` is rewritten to drive the buttons (click move / group /
  eject) instead of simulating drags. Cover: group single+single, add single to
  group, group+group merge, eject to standalone, group collapsing to a single on
  eject, and the disabled-on-first-entry case.

### Resulting layout

```
Pick Queue              Auto-pick ☑
─────────────────────────────────────
Lightning Bolt        [⏸][▲▼][×]      ← entry 0: no ⊓ (nothing above)
Doom Blade        [⊓] [⏸][▲▼][×]      ← press ⊓ → GROUP{Bolt, Doom}
GROUP (2)         [⊓] [▶][▲▼]
  Teferi              [⤷][▲▼][×]      ← ⤷ ejects Teferi to its own entry
  Snapcaster          [⤷][▲▼][×]
```

## Verification

- `pnpm precommit` (typecheck → lint → knip → tests → e2e) on each commit.
- Part 1: open Settings, expand "How it works", confirm content and that it
  collapses by default.
- Part 2: in the pod view, exercise move / group / eject via buttons; confirm
  grouping rules, eject placement, group→single collapse, and that auto-pick
  still consumes groups correctly. Screenshot the reworked panel.
