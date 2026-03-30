# Multi-Copy Card Picks in Live Drafts

## Problem

Some cube pools contain multiple copies of individual cards (e.g., Mishra's Bauble ×2, basic lands ×3). The card table already displays a "×N" badge for these cards. However, the live draft pick system treats every card as single-copy: picking one copy removes the card entirely from availability, other players' queues, and the card table display.

The root cause is four code paths that use existence checks (`SELECT 1` / `NOT IN`) instead of count-vs-quantity checks.

## Design

### Backend: `processPick.ts`

#### Pick validation (lines 58-65)

Current code rejects a pick if any copy of the card has been picked:

```sql
SELECT 1 FROM pick_events WHERE draft_id = ? AND card_id = ?
```

Replace with a count check against the card's quantity in the cube snapshot:

```sql
-- Get picked count and total qty in one query
SELECT COUNT(pe.pick_n) as picked_count, csc.qty
FROM cube_snapshot_cards csc
JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
LEFT JOIN pick_events pe ON pe.card_id = csc.card_id AND pe.draft_id = d.draft_id
WHERE d.draft_id = ? AND csc.card_id = ?
GROUP BY csc.card_id, csc.qty
```

Reject only when `picked_count >= qty`.

#### Auto-pick availability query (lines 138-148)

Current code excludes any card_id with a pick event:

```sql
AND csc.card_id NOT IN (SELECT card_id FROM pick_events WHERE draft_id = ?)
```

Replace with a quantity-aware filter:

```sql
SELECT csc.card_id
FROM cube_snapshot_cards csc
JOIN drafts d ON d.cube_snapshot_id = csc.cube_snapshot_id
LEFT JOIN (
  SELECT card_id, COUNT(*) as cnt
  FROM pick_events WHERE draft_id = ?
  GROUP BY card_id
) pe ON csc.card_id = pe.card_id
WHERE d.draft_id = ?
AND COALESCE(pe.cnt, 0) < csc.qty
```

#### Queue removal (line 113)

Currently calls `removeCardFromAllQueues()` unconditionally after every pick. Change to conditional: after inserting the pick, check whether `picked_count >= qty` for the card. Only call `removeCardFromAllQueues()` when the last copy is taken. If copies remain, skip queue removal.

#### Cautious auto-pick pause (lines 99-110)

Currently pauses cautious-mode players whenever someone picks a card from their queue. Change to the same condition: only trigger the cautious pause when the last copy of the card is taken. If copies remain, the queued card is still available — no reason to pause.

Both the queue removal and cautious pause share the same "is this the last copy?" check, so compute it once after inserting the pick.

### UI: Taken card filtering

#### `useCardFiltering.ts`

Replace `takenCardNamesSet: Set<string>` with `takenCardCounts: Map<string, number>` — a count of how many times each card name appears in `takenCards`. A card is "fully taken" only when `takenCardCounts.get(name) >= cubeCopies[name]`.

The hook needs `cubeCopies: Record<string, number>` added to its props.

The `hideTaken` filter changes from set membership to:

```typescript
const isTaken = (takenCardCounts.get(c.cardName) ?? 0) >= (cubeCopies[c.cardName] ?? 1);
```

The `takenCardNamesSet` return value changes to only include fully-taken card names (to preserve downstream consumers like dimming logic).

### UI: Copy badge

#### `CardNameCell.tsx`

In draft mode (when an active draft is selected), replace the `×N` badge with `R/T` format:
- R = remaining copies (total − picked count)
- T = total copies in the cube

Examples: `2/2` → `1/2` → `0/2`

Show whenever total copies ≥ 2. Badge color shifts based on remaining:
- Copies remaining (R > 0): purple (current style)
- No copies remaining (R = 0): gray/dimmed

The component receives a new `remainingCopies` prop. When not in draft mode, fall back to the existing `×N` display.

#### `CardTable.tsx`

Compute remaining copies per card: `cubeCopies[name] - (takenCardCounts.get(name) ?? 0)`. Pass both `cubeCopies` and `remainingCopies` to `CardNameCell`.

### Files to modify

1. **`src/core/processPick.ts`** — Validation query, auto-pick availability query, conditional queue removal, conditional cautious pause
2. **`src/app/hooks/useCardFiltering.ts`** — Count-based taken logic, add `cubeCopies` prop
3. **`src/app/components/CardNameCell.tsx`** — Badge format (`R/T` in draft mode, `×N` otherwise)
4. **`src/app/components/CardTable.tsx`** — Compute remaining copies, pass to CardNameCell
5. **`src/app/components/PageClient.tsx`** — Pass `cubeCopies` to useCardFiltering

### Edge cases

- **Concurrent last-copy picks:** Handled by existing optimistic concurrency on `pick_n`. Only one INSERT succeeds per pick number.
- **Auto-pick cascade with multi-copy cards:** The quantity-aware availability query correctly shows remaining copies as available for cascade picks.
- **Card in queue at draft completion:** Existing logic handles this — queue entries are orphaned but harmless.

### Testing

- **`processPick` unit tests:** Pick a 2-copy card once (allowed), pick again (allowed), pick a third time (rejected). Verify queue removal only happens on the second pick. Verify cautious pause only triggers on the second pick.
- **`useCardFiltering` unit tests:** 2-copy card with 1 pick (not fully taken, still visible with hideTaken), 2-copy card with 2 picks (fully taken, hidden with hideTaken).
- **E2E:** Pick a multi-copy card, verify it remains in the card table for other drafters with updated badge.
