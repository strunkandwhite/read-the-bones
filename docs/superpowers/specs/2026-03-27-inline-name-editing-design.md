# Inline Name Editing in Live Draft Pod View

## Problem

Players can set their display name via the API, but no UI exists for it. Players must use the raw API or remain as "Seat N" throughout the draft.

## Solution

Add inline name editing to the draft board column headers. A player clicks their own name to edit it in place. The change saves to the existing `seat-settings` endpoint and propagates to other players through the existing board polling cycle.

## Scope

- Seat owners edit their own name only
- No admin UI
- No new API endpoints
- No restrictions on when names can be edited

## Component: InlineEditableName

A new component with two modes:

**Display mode:** Renders the current name as text. When the seat is editable (`mySeat === seat`), a pencil icon appears on hover.

**Edit mode:** Clicking the name or icon swaps to a text input pre-filled with the current name. The input matches the existing header style (11px, weight 600, seat color, centered). Behavior:
- Enter or blur: save
- Escape: cancel edit and revert to previous value. Must call `e.stopPropagation()` to prevent the Escape event from bubbling up to `DraftBoardModal`, which uses Escape to close the modal.
- Empty submission: calls `onSave("")` to clear the name via the API, then displays "Seat N" fallback
- Max 50 characters enforced client-side
- On API failure: revert the input to the previous name (no silent failures for user-visible text edits)

### Props

| Prop | Type | Purpose |
|------|------|---------|
| `currentName` | `string` | Display name or "Seat N" fallback |
| `seatNumber` | `number` | Seat number (1-based) for fallback display |
| `isEditable` | `boolean` | Whether the current player owns this seat |
| `onSave` | `(name: string) => Promise<void>` | Callback to persist the new name |

## Integration: DraftBoardMatrix

Replace the plain text in column headers:

```tsx
// Before
{board.seatNames[String(seat)] || `Seat ${seat}`}

// After
<InlineEditableName
  currentName={board.seatNames[String(seat)] || `Seat ${seat}`}
  seatNumber={seat}
  isEditable={mySeat === seat}
  onSave={updateDisplayName}
/>
```

The `updateDisplayName` callback originates from `useMySeat` in `PageClient`, then threads through new props: `onUpdateDisplayName` added to both `DraftBoardModalProps` and `DraftBoardMatrixProps` interfaces.

## Hook Change: useMySeat

Expose a new `updateDisplayName` function alongside the existing `toggleAutoPick`:

```typescript
updateDisplayName: (name: string) => Promise<void>
```

It calls `PUT /api/drafts/{id}/seat-settings` with `{ display_name: name }` using the seat token, and updates the `displayName` field in the hook's local state. The `UseMySeatReturn` interface must be updated to include this function.

## Data Flow

1. Player edits name → `InlineEditableName` calls `onSave(newName)`
2. `updateDisplayName` calls `PUT /api/drafts/{id}/seat-settings` with the seat token
3. The hook updates its local `displayName` state, but the column header reads from `board.seatNames` (sourced from the `useDraftBoard` polling hook), so the header text updates on the next board poll — typically within seconds
4. Other players also receive the updated name on their next board poll — both `/api/drafts/{id}/board` and `/api/drafts/{id}/status` already return `seatNames`

No new endpoints, polling mechanisms, or database changes required.

## Editability Rules

- `isEditable = mySeat === seat`
- Auth uses the existing seat token via `X-Seat-Token` header
- The existing endpoint validates token ownership and the 50-character limit

## Testing

- **Unit:** `InlineEditableName` component — display/edit mode toggling, save/cancel behavior, character limit
- **Hook:** `useMySeat` — verify `updateDisplayName` calls the API and updates local state
- **Integration:** Verify name changes appear in the board matrix after save
- **E2E:** Player sets name, second player sees updated name on next poll
