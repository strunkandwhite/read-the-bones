# Live Draft UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix nine live draft bugs and UX issues reported during E2E testing with two players.

**Architecture:** Fixes span the snake draft algorithm, pick processing, polling hooks, API caching, and UI components. The snake draft rework is the most complex change; the rest are targeted fixes.

**Tech Stack:** TypeScript, Next.js, React, Turso/libSQL, Vitest

---

## Task 1: Fix standings cache and board cache (Items #8, #3 partial)

The simplest, highest-impact fixes. The standings API returns `Cache-Control: public, s-maxage=60` and the board API returns `s-maxage=5`. These CDN caches cause stale data after match entry and during fast pick sequences.

**Files:**
- Modify: `src/app/api/drafts/[id]/standings/route.ts:12`
- Modify: `src/app/api/drafts/[id]/board/route.ts:73`

- [ ] **Step 1: Fix standings cache header**

In `standings/route.ts`, change the cache header from `public, s-maxage=60` to `no-store`:

```typescript
headers: { "Cache-Control": "no-store" },
```

- [ ] **Step 2: Fix board cache header**

In `board/route.ts`, change from `public, s-maxage=5` to `no-store`:

```typescript
headers: { "Cache-Control": "no-store" },
```

- [ ] **Step 3: Run tests and commit**

Run: `pnpm precommit`

---

## Task 2: Pod view improvements (Items #1, #9)

**Files:**
- Modify: `src/app/components/draft-board/DraftBoardModal.tsx`
- Modify: `src/app/hooks/useLiveDraftStatus.ts`

- [ ] **Step 1: Show seat identity in pod view header**

In `DraftBoardModal.tsx`, add the player's seat display near the phase badge in the header. When `mySeat` is not null, render something like "You are Seat 3" (or use their display name if set). The `mySeat` prop is already passed to the component.

- [ ] **Step 2: Track phase and match count changes in polling hook**

In `useLiveDraftStatus.ts`, the `dataChanged` counter only increments when `latestPickN` changes. Add tracking for `phase` and `matchCount` changes:

- Add `prevPhaseRef` and `prevMatchCountRef` refs
- In the poll callback, increment `dataChanged` when `data.phase !== prevPhaseRef.current` or `data.matchCount !== prevMatchCountRef.current`
- Update the refs after comparison

This ensures the pod view re-renders when the draft transitions to `playing` (fixing item #9) and when matches are reported (helping item #8).

- [ ] **Step 3: Run tests and commit**

Run: `pnpm precommit`

---

## Task 3: Snake draft double-pick logic rework (Item #4)

The most complex change. Current `derivePickSeat` has three regions: single-pick rounds, double-pick rounds, and a possible trailing single round. The correct behavior:
- Always end on double-pick rounds (never a trailing single)
- On the first double-pick round, the edge player gets a **triple pick** to bridge the transition

Current algorithm in `snakeDraft.ts`:
```
singlePickRounds = floor(picksPerPlayer / 2)
remainingPerPlayer = picksPerPlayer - singlePickRounds
fullDoubleRounds = floor(remainingPerPlayer / 2)
hasTrailingSingle = remainingPerPlayer % 2 === 1
```

With 10 seats, 10 picks: 5 single rounds, 2 double rounds, 1 trailing single. Wrong — should be 5 single, 2.5 double (no trailing single).

**Files:**
- Modify: `src/core/snakeDraft.ts`
- Modify: `src/core/snakeDraft.test.ts`

- [ ] **Step 1: Write failing tests for new behavior**

Add test cases in `snakeDraft.test.ts`:

1. **No trailing single round ever**: For various seat/pick combos (2/10, 4/6, 10/45, 10/10), verify the last pick has `isDoublePick: true` (not false)
2. **Triple pick on transition**: Verify the edge seat gets 3 consecutive picks when doubles begin
3. **Every seat still gets exactly picksPerPlayer picks** (existing test, keep it)
4. **2 seats, 10 picks**: Verify pick order — should be simple alternating with doubles at the end

Run tests to verify they fail: `pnpm test src/core/snakeDraft.test.ts`

- [ ] **Step 2: Redesign derivePickSeat**

Rewrite the algorithm to:
1. Calculate how many single-pick rounds and double-pick rounds are needed
2. Never produce a trailing single round
3. Handle the transition triple-pick correctly
4. Consider adding a `picksInTurn` field to `PickSeatResult` (1, 2, or 3) instead of the boolean `isDoublePick`

The math: Work backward from the total picks. Each double round consumes `numSeats * 2` picks. Each single round consumes `numSeats` picks. The transition round consumes `numSeats * 2 + 1` picks (one seat gets 3). Solve for how many of each round type to have.

- [ ] **Step 3: Add getConsecutivePickCount helper**

Add a `getConsecutivePickCount(pickNumber, opts)` function to `snakeDraft.ts` that returns how many consecutive picks the seat at `pickNumber` has starting from that pick. This replaces the inline logic in `PageClient.tsx` lines 230-246 which uses incorrect single-region-only math.

- [ ] **Step 4: Update buildPickMatrix if needed**

`buildPickMatrix` already derives from `derivePickSeat`, so it should inherit the fix. But verify the rendering handles triple-pick rounds correctly — the `DraftBoardMatrix` component renders double-pick rounds as 2 stacked `<tr>` elements, so triple picks may need 3 rows or a different approach.

- [ ] **Step 5: Run all tests**

Run: `pnpm precommit`

---

## Task 4: Toolbar badge and layout fixes (Items #2, #6)

**Files:**
- Modify: `src/app/components/PageClient.tsx`

- [ ] **Step 1: Replace inline consecutivePicks with snakeDraft helper**

Replace the inline calculation at lines 230-246 with a call to the new `getConsecutivePickCount` from `snakeDraft.ts` (added in Task 3).

- [ ] **Step 2: Change badge to "Your pick"**

At line 592, change the condition and text:

From:
```tsx
{isMyTurn && consecutivePicks > 1 && (
  <span className="...">
    {consecutivePicks}&times; pick
  </span>
)}
```

To:
```tsx
{isMyTurn && (
  <span className="...">
    Your pick
  </span>
)}
```

- [ ] **Step 3: Remove max-width constraint**

At line 448, remove `max-w-7xl` from the container:

From: `"mx-auto max-w-7xl px-4 pb-0 pt-4 sm:px-6 lg:px-8"`
To: `"mx-auto px-4 pb-0 pt-4 sm:px-6 lg:px-8"`

- [ ] **Step 4: Increase button sizes on large screens**

Add `xl:` breakpoint sizing for toolbar action buttons (the icon buttons for pod view, deck builder, standings, settings). Increase padding and icon size at `xl:` breakpoint.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm precommit`

---

## Task 5: Auto-pick and queue cleanup fixes (Items #5, #7)

**Files:**
- Modify: `src/core/db/queries/pickQueue.ts` — add `clearAllQueues` function
- Modify: `src/core/processPick.ts` — call `clearAllQueues` on draft completion
- Modify: `src/core/processPick.test.ts` — test queue clearing
- Modify: `src/app/api/drafts/[id]/queue/route.ts` — fire auto-pick when queuing

- [ ] **Step 1: Add clearAllQueues to pickQueue.ts**

```typescript
export async function clearAllQueues(client: Client, draftId: string): Promise<void> {
  await client.execute({
    sql: "DELETE FROM pick_queue WHERE draft_id = ?",
    args: [draftId],
  });
}
```

- [ ] **Step 2: Clear queues on draft completion in processPick.ts**

At lines 105-110, after setting phase to `'playing'`, call `clearAllQueues`:

```typescript
if (totalAfter >= totalExpected) {
  await client.execute({
    sql: `UPDATE drafts SET phase = 'playing' WHERE draft_id = ?`,
    args: [input.draftId],
  });
  await clearAllQueues(client, input.draftId);
  return { picks, phaseChanged: true, newPhase: 'playing' };
}
```

- [ ] **Step 3: Write test for queue clearing on completion**

In `processPick.test.ts`, add a test that verifies `clearAllQueues` is called when the draft transitions to `playing` phase.

- [ ] **Step 4: Fire auto-pick immediately when queuing**

In `/api/drafts/[id]/queue/route.ts` PUT handler, after saving the queue, check if auto-pick should fire:

1. Load draft metadata (phase, num_seats, picks_per_player)
2. Check if phase is `'drafting'`
3. Count current picks and call `getNextPick` to see if it's this player's turn
4. Check if the player has `auto_pick` enabled
5. If all conditions met, call `processPick` with the first queued card

Return the pick result in the response so the client can update immediately.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm precommit`

---

## Future Work (Not Implemented)

- **Card detail modal**: A modal on card click showing stats, larger pick/queue buttons. Needs design for what stats to show.
- **Consolidated icon column**: Rework pick/queue/owned columns into a single column with pop-out action menu. Blue = actionable, green = owned, green+superscript = queued.

---

## Verification

1. Create a test draft: `pnpm draft:create-live --name "Test" --date 2026-03-26 --seats 2 --picks-per-player 10 --pool cubecobra:samp`
2. Start it: `pnpm draft:start test`
3. Open both seat URLs in separate browser windows
4. Verify: "Your pick" badge shows when it's your turn
5. Verify: Pod view shows your seat number
6. Verify: App is full width
7. Verify: Queue a card with auto-pick ON → pick fires immediately
8. Verify: Both seats' picks appear in real-time without refresh
9. Verify: When draft completes, queues are cleared and standings/match entry appear without refresh
10. Verify: After entering a match result, standings table updates immediately
11. Verify: Pick matrix shows correct double-pick rows at the end (no trailing single)
12. Delete test draft: `pnpm draft:delete test`
