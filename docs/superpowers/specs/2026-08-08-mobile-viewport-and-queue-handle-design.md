# Mobile Viewport Units and Queue Drag Handle — Design

**Date:** 2026-08-08
**Status:** Approved

## Problem

A user on an iPhone SE (2nd gen or later, 375×667 CSS px) reports that buttons
don't work, queue reordering doesn't work, and UI elements load over one another
or off screen. No other user has reported problems. Two independent defects
account for it, both of which only surface on a short touch screen.

### 1. Modals are capped in `vh` while the app shell is `dvh`

`globals.css` pins the shell to the dynamic viewport and disables page scrolling:

```css
html, body { overflow: hidden; height: 100dvh; }
```

Every modal, however, caps its height in plain `vh`. On iOS Safari `vh` resolves
against the **large** viewport — the height the page would have with the toolbars
retracted — while `dvh` tracks what is actually visible. Because `overflow: hidden`
means the page never scrolls, Safari's toolbars never retract, so the visible area
is permanently the small one (~555px on a 375×667 SE) while modals keep sizing
themselves to 667px.

Reproduced against `CardStatsModal` at 375×667 with the shell forced to 555px:

```
modal height: 600px  (90vh = 0.9 × 667)  inside a 555px overlay
clipped above top:     23px
clipped below visible: 23px
unreachable: [{ label: "Close", top: -10, bottom: 18 }]
pageCanScrollToReachIt: false   (html/body overflow: hidden)
```

The modal is centred in a box taller than the viewport, so it is clipped at
**both** edges, and the `overflow: hidden` shell means nothing can scroll to
reach the clipped region. The Close button is sliced in half.

This only bites when a modal's content is tall enough to hit the cap, which is
why it reproduces on a short screen and nowhere else.

### 2. `QueuePanel`'s button guards are aimed at the wrong sensor

Queue rows spread dnd-kit's `{...listeners}` onto the whole entry wrapper
(`QueuePanel.tsx:187`, `:222`), so a press on any button inside a row bubbles up
to the drag sensor. Each of the seven buttons tries to prevent that with:

```tsx
onPointerDown={(e) => e.stopPropagation()}
```

`stopPropagation()` only stops the event it is called on. `QueuePanel` configures
`MouseSensor` and `TouchSensor`, which activate on `onMouseDown` and
`onTouchStart` respectively (dnd-kit `core.cjs.development.js:1679`, `:1733`).
Stopping `pointerdown` holds off neither. The guard targets `PointerSensor`,
which this panel does not use.

`DeckCard` carries the identical guard and works correctly, because
`DeckBuilderPanel` *does* use `PointerSensor`. The pattern was copied into
`QueuePanel` without the sensors matching.

With `TouchSensor` at `{ delay: 500, tolerance: 8 }`, the user-visible effect is:
release inside 500ms and the click fires; hold longer — normal for a deliberate
tap on a small target — and the drag activates instead, dnd-kit calls
`preventDefault`, and the click never fires. Buttons work as a function of how
fast you tap. On desktop `MouseSensor`'s `{ distance: 5 }` masks this entirely.

## Goals

- Modals fit the visible viewport on iOS Safari, with no change to desktop.
- Queue buttons respond reliably to touch.
- Queue reordering works on touch, via a real drag handle.

## Non-goals

- **Deck-builder touch support.** `DeckBuilderPanel` uses `PointerSensor` with no
  `touch-action: none`, and `DeckCard`'s remove-float and queue-toggle buttons are
  `opacity-0 group-hover/card:opacity-100`. Deck building is desktop-first;
  both stay as they are.
- **Re-enabling pinch zoom.** `layout.tsx:22-23` sets `maximumScale: 1,
  userScalable: false`, but Safari on iOS has ignored both since iOS 10, so they
  have no effect on the reporting device. Even with zoom enabled it would not
  help: the clipped region lies outside `html, body { overflow: hidden }`, so no
  amount of zoom or pan reaches it. Removing them is an orthogonal accessibility
  tidy-up (WCAG 2.1 SC 1.4.4, still honoured by Android Chrome and iOS in-app
  WebViews), tracked separately.
- **Dropping Tailwind v4.** The compiled CSS contains 57 `@property` rules and
  139 `color-mix()` calls, giving a hard floor of Safari 16.4. This is accepted;
  the reporting device is assumed to be an SE 2nd gen or later, which can run
  iOS 16.4+.
## Design

### 1. `vh` → `dvh`

| File | Line | Change |
|---|---|---|
| `CardStatsModal.tsx` | 193 | `max-h-[90vh]` → `max-h-[90dvh]` |
| `DraftBoardModal.tsx` | 96 | `max-h-[95vh]` → `max-h-[95dvh]` |
| `PageClient.tsx` | 391 | `max-h-[95vh]` → `max-h-[95dvh]` |
| `StatsModal.tsx` | 73 | `max-h-[80vh]` → `max-h-[80dvh]` |
| `Settings.tsx` | 175 | `max-h-[80vh]` → `max-h-[80dvh]` |
| `QueuePanel.tsx` | 423 | `max-h-[30vh]` → `max-h-[30dvh]` |

`PageClient.tsx:164`'s `min-h-screen` (`100vh`) also overshoots the shell, but it
is a background-colour wrapper with content flowing from the top, so the overshoot
is invisible. Change it to `min-h-dvh` for consistency, not as a fix.

`DraftBoardModal`'s `max-w-[95vw]` is unchanged — `vw` has no toolbar equivalent.

**Why `dvh` and not `svh`:** with `overflow: hidden` on the shell the toolbars never
retract, so `dvh` is pinned and cannot change mid-scroll. That removes `dvh`'s usual
hazard (reflow during scroll) and makes it equivalent to `svh` here. `dvh` matches
the `100dvh` already in `globals.css`.

**Desktop impact: none.** Without dynamic browser chrome, `vh`, `dvh`, `svh` and
`lvh` all resolve identically.

**Known limitation:** `dvh` tracks the layout viewport, so it does not shrink when
the software keyboard opens. A modal containing a text input (search,
`PickAutocomplete`) can still be occluded by the keyboard. Out of scope; would
need the `visualViewport` API.

### 2. The `⠿` grip becomes a real drag handle

Rows already render a `⠿` grip glyph (`QueuePanel.tsx:190`, `:224`), but it is
decorative — the listeners are on the whole row. The UI already implies the
affordance; the code should honour it.

`useDraggable` returns two refs for exactly this split:

- `setNodeRef` — stays on the row wrapper. This is the drag *source*, the rect
  that gets measured and moved.
- `setActivatorNodeRef` — goes on the grip. This is what you grab.

Changes in `DraggableEntry`:

- Destructure `setActivatorNodeRef` from `useDraggable`.
- Move `{...attributes} {...listeners}` off the row wrappers onto the grip.
  `attributes` supplies `role`, `tabIndex` and the `aria-*` set, which belong on
  a handle.
- The grip becomes a `<button type="button">` carrying `ref={setActivatorNodeRef}`,
  `touch-action: none`, `cursor-grab`, and a touch target of at least 44×44 CSS px
  on mobile. It is currently a bare `<span>` with no padding.
- Move `cursor-grab` off the row onto the grip.
- **Delete all seven `onPointerDown` guards.** Once the buttons are no longer
  descendants of the activator, their events never reach a drag listener. The
  handle makes the guards unnecessary rather than making them correct.

### 3. Sensor activation constraint

`QueuePanel.tsx:312-316`. The `delay: 500` on `TouchSensor` exists solely to
disambiguate drag-from-scroll when the entire row is grabbable. A dedicated handle
with `touch-action: none` removes that ambiguity, so:

```
useSensor(TouchSensor, { activationConstraint: { distance: 8 } })
```

Drag begins as soon as the finger moves 8px on the grip, rather than after a long
press. `MouseSensor`'s `{ distance: 5 }` is unchanged.

**`MouseSensor` + `TouchSensor` are deliberately kept rather than unified on
`PointerSensor`.** Unifying would match `DeckBuilderPanel` and eliminate the
sensor/event mismatch class of bug at the root, which is tempting. But dnd-kit's
`TouchSensor` ships a `static setup()` that registers a non-passive window
`touchmove` listener, commented in-source as *"required for iOS Safari"*;
`PointerSensor` has no equivalent. Whether `touch-action: none` fully substitutes
for that on a real iPhone cannot be verified from a headless Linux environment, so
a known-working iOS path is not traded for an untested one.

Accepted trade-off: `touch-action: none` on the grip means a scroll gesture that
happens to begin on the grip will not scroll the queue list. The grip is small and
the list has ample non-grip area, so this is acceptable.

With `delay: 500` this meant a scroll gesture starting on the grip simply did
nothing for half a second before the drag armed. Replacing it with
`{ distance: 8 }` changes that: 8px of finger movement now starts a reorder
immediately, so an accidental short drag is no longer a no-op by way of doing
nothing — it is a no-op by way of `reorderEntryToSlot` rejecting it. `DropSlot`s
are ~6px tall between rows, `closestCenter` resolves a short drag to whichever
slot is already adjacent to the dragged entry, and `reorderEntryToSlot` returns
`null` for exactly the two slots immediately above and below the entry's current
position (`slot === from || slot === from + 1`). A short accidental drag off the
grip lands on one of those slots and produces no reorder.

### 4. `CardTable`'s scroll-container floor

`CardTable.tsx:394` sizes its scroll container from `window.innerHeight`, which
already reports the true visible height on iOS — that part was correct. But the
container height was `Math.max(400, window.innerHeight - rect.top - 56)`, and
the `400` floor breaks the guarantee: whenever `rect.top > innerHeight - 456`
the container is forced to 400px even though less than 400px is actually
available below it. On a 555px visible viewport that is `rect.top > 99px`,
which is plausible in portrait once `PageClient`'s `pt-4`, toolbar row and
filter row are accounted for. Because the shell is `overflow: hidden`, the
overshoot is unreachable — the bottom of the card table, the user's primary
in-scope flow, is permanently clipped.

The fix drops the floor to `0`:

```ts
const available = window.innerHeight - rect.top - 56;
setScrollHeight(Math.max(0, available));
```

`Math.max(0, …)` only guards against a negative height (e.g. `rect.top` far
below the viewport during an intermediate layout state); it can never push the
container past what is actually visible. At 375×667 in headless Chrome
`available` is roughly 511px, well clear of the old 400px floor, so this does
not change behavior on the size Playwright exercises — it only stops the
container from overshooting on shorter or more chrome-heavy viewports.

## Testing

- **Unit** (`@testing-library/react`, alongside the existing `DeckCard.test.tsx` /
  `DeckZone.test.tsx`): a `QueuePanel` test asserting each button's handler fires
  on click. This is a direct regression test for defect 2.
- **Unit:** assert the grip renders as a `button` with an accessible name, and
  that the row wrapper no longer carries drag listeners.
- **E2E** (Playwright, `e2e/playwright.config.ts`): a mobile-viewport project
  exercising scroll card table → open card → pick.

**Queue button taps were dropped from the E2E plan during implementation,
without comment in the original spec — recorded here.** The actual regression
protection for defect 2 is the three structural unit tests added to
`QueuePanel.test.tsx`: they assert the drag activator lives on the grip button
rather than the row, that every activator is a real `<button>`, and that the
group handle is labelled — i.e. that the seven row buttons sit outside the
draggable subtree, which is the invariant that makes them clickable. That is a
stronger guarantee than an E2E tap, which only samples one button on one
device profile. Separately, the mobile E2E spec (`e2e/flows/mobile.spec.ts`)
stops at a trial click on the hold-to-pick button and does not carry a pick
through to completion at 375×667 — full pick completion is covered only by
the desktop suite.

**What automated tests cannot cover.** Headless Chrome has no browser chrome, so
`vh === dvh` there and defect 1 is invisible to it — reproducing it required
forcing the viewport split by hand. Playwright cannot catch a regression here
either. Final confirmation of the `dvh` fix requires the physical device, ideally
over Safari Web Inspector (iPhone Settings → Safari → Advanced → Web Inspector).

## Follow-ups (not in this work)

Log in `todo.md`:

- Deck-builder touch drag: `PointerSensor` without `touch-action: none`.
- `DeckCard`'s hover-only remove-float and queue-toggle buttons.
- Removing `maximumScale` / `userScalable` from `layout.tsx` for the accessibility
  audit signal.
- `CardTable.tsx:394`'s `Math.max(400, …)` floor can exceed available height in
  landscape on a short phone, pushing the table bottom into the unscrollable region.
