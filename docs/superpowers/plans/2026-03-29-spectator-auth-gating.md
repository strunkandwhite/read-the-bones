# Spectator Auth Gating Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent spectators (users without a valid seat token) from seeing float/queue/pick UI when viewing a live draft seat they don't own.

**Architecture:** Compute a single `isAuthed` boolean in `PageClient.tsx` (true when `mySeat !== null && mySeat === selectedSeat`) and gate all downstream UI at prop-passing boundaries. No new hooks, components, or abstractions — just conditional prop passing in the orchestrator. `mySeat` is derived from the seat token via `useMySeat(draftId, token)` → `/api/drafts/{id}/me`, so `mySeat !== null` already implies a valid token.

**Tech Stack:** React, TypeScript, Next.js

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/app/components/PageClient.tsx` | Modify | Derive `isAuthed`, gate all downstream props |
| `src/app/components/Settings.tsx` | Modify | Accept + render auth badge |

No other files change. Child components (`CardStatsModal`, `CardTable`, `DeckBuilderPanel`, etc.) are already pure presentational — they render whatever props they receive.

---

## Chunk 1: Auth Gating

### Task 1: Derive `isAuthed` and gate card status

**Files:**
- Modify: `src/app/components/PageClient.tsx:172-221`

- [ ] **Step 1: Add `isAuthed` derivation**

After line 194 (after `useLiveDraftPicking`), add:

```ts
const isAuthed = mySeat !== null && mySeat === draftSelection.selectedSeat;
```

This goes after `isMyTurn` is available so the derivation reads naturally with its peers.

- [ ] **Step 2: Gate `getCardStatus` behind `isAuthed`**

Modify the `getCardStatus` callback (lines 199-221) to only return `"queued"` / `"floated"` when authed:

```ts
const getCardStatus = useCallback(
  (cardName: string): CardStatusResult => {
    // Picked by the current seat
    if (seatCardNames?.has(cardName)) {
      return { status: "picked" };
    }
    // Queue/float status only visible to authenticated seat owner
    if (isAuthed) {
      const queuePriority = pickQueue.queuedCards.get(cardName);
      if (queuePriority != null) {
        return { status: "queued", queuePosition: queuePriority };
      }
      if (floatedCardsSet.has(cardName)) {
        return { status: "floated" };
      }
    }
    // Taken by someone else
    if (takenCardNamesSet?.has(cardName)) {
      return { status: "taken" };
    }
    return { status: "none" };
  },
  [seatCardNames, pickQueue.queuedCards, floatedCardsSet, takenCardNamesSet, isAuthed],
);
```

This gates the card table status icons (`CardStatusIcon`) and the card stats modal's `cardStatus` prop in one place.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```
feat: derive isAuthed and gate card status for spectators
```

---

### Task 2: Gate card stats modal action buttons

**Files:**
- Modify: `src/app/components/PageClient.tsx:640-657`

- [ ] **Step 1: Gate all action callback props with `isAuthed`**

Modify the `<CardStatsModal>` JSX (lines 640-657) to prepend `isAuthed &&` to action props:

```tsx
<CardStatsModal
  cardName={selectedCard}
  scryfallImageUrl={getImageUrl(selectedCard)}
  isOpen={!!selectedCard}
  onClose={() => setSelectedCard(null)}
  draftId={draftSelection.activeDraft && liveDraftStatus.status?.phase !== "drafting" ? draftSelection.activeDraft : undefined}
  isLiveDraft={!!draftSelection.activeDraft && liveDraftStatus.status?.phase === "drafting"}
  isMyTurn={isAuthed && isMyTurn}
  cardStatus={selectedCardStatus?.status ?? "none"}
  queuePosition={selectedCardStatus?.queuePosition}
  onPick={isAuthed && selectedCard ? () => handlePick(selectedCard) : undefined}
  onQueue={isAuthed && selectedCard && !(isMyTurn && pickQueue.queue.length === 0 && autoPick) ? () => pickQueue.addToQueue(selectedCard) : undefined}
  onUnqueue={isAuthed && selectedCard ? () => pickQueue.removeFromQueue(selectedCard) : undefined}
  onFloat={isAuthed && selectedCard ? () => addFloat(selectedCard) : undefined}
  onUnfloat={isAuthed && selectedCard ? () => removeFloat(selectedCard) : undefined}
  isLocal={isLocal}
  excludeDraftId={liveDraftStatus.status?.phase === "drafting" ? draftSelection.activeDraft ?? undefined : undefined}
/>
```

When `isAuthed` is false, all action callbacks are `undefined`. CardStatsModal's existing `showActions` logic (line 50-51) plus `ActionButtons` render nothing when callbacks are absent.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```
feat: gate card stats modal actions behind isAuthed
```

---

### Task 3: Gate deck builder floated cards and sync inputs

**Files:**
- Modify: `src/app/components/PageClient.tsx:266-277` (useDeckBuilderSync call)
- Modify: `src/app/components/PageClient.tsx:624-634` (DeckBuilderPanel JSX)

- [ ] **Step 1: Gate `useDeckBuilderSync` inputs**

Modify the `useDeckBuilderSync` call (lines 266-277) to pass empty arrays when not authed. The sync hook merges `floatedCards` and `queuedCardNames` into the deck builder card list — spectators shouldn't get speculative cards:

```tsx
useDeckBuilderSync({
  deckBuilderActive,
  seatCardList,
  deckBuilderState: deckBuilder.state,
  dispatch: deckBuilder.dispatch,
  scryfallDataMap,
  activeDraft: draftSelection.activeDraft,
  selectedSeat: draftSelection.selectedSeat,
  ready: deckBuilder.ready,
  floatedCards: isAuthed ? floatedCards : [],
  queuedCardNames: isAuthed ? queuedCardNames : [],
});
```

- [ ] **Step 2: Gate `DeckBuilderPanel` floated card props**

Modify the `<DeckBuilderPanel>` JSX (lines 624-634):

```tsx
<DeckBuilderPanel
  state={deckBuilder.state}
  dispatch={deckBuilder.dispatch}
  scryfallData={scryfallDataMap}
  cardStats={cardStatsMap}
  draftName={cardData.draftMetadata[draftSelection.activeDraft]?.name ?? draftSelection.activeDraft}
  onClose={() => setDeckBuilderModalOpen(false)}
  floatedCards={isAuthed ? floatedCards : []}
  onRemoveFloat={isAuthed ? removeFloat : undefined}
  saveStatus={deckBuilder.saveStatus}
/>
```

When `isAuthed` is false: `floatedCards` is empty (DeckZone computes zero floated indices), and `onRemoveFloat` is undefined (DeckCard's remove button won't render).

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```
feat: gate deck builder floated/queued cards behind isAuthed
```

---

### Task 4: Auth badge in Settings

**Files:**
- Modify: `src/app/components/Settings.tsx:9-28` (props interface)
- Modify: `src/app/components/Settings.tsx:141` (scrollable content area)
- Modify: `src/app/components/PageClient.tsx:500-516` (Settings JSX)

- [ ] **Step 1: Add props to Settings interface**

Add two new optional props to `SettingsProps` (line 9-28 of `Settings.tsx`):

```ts
// Auth state
isAuthed?: boolean;
mySeat?: number | null;
```

Destructure them in the function signature (line 30-46).

- [ ] **Step 2: Render auth badge**

Insert before the "Draft view" section heading (after line 141, before line 142):

```tsx
{isAuthed && mySeat != null && (
  <div className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-800/40 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-400">
    <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
    Logged in as Seat {mySeat}
  </div>
)}
```

- [ ] **Step 3: Pass props from PageClient**

Add to the `<Settings>` JSX in `PageClient.tsx` (around line 500-516):

```tsx
isAuthed={isAuthed}
mySeat={mySeat}
```

- [ ] **Step 4: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 5: Commit**

```
feat: show auth badge in settings when logged into a seat
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full quality checks**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, tests, e2e all pass

- [ ] **Step 2: Manual verification**

Test these scenarios with a running dev server against a live draft in "drafting" phase:

1. **Spectator (no token):** Select a seat → card stats modal should show stats only (no float/queue/pick buttons), card table should show no queue/float icons, deck builder should have no floated cards, settings should have no auth badge.

2. **Authed (valid token, viewing own seat):** All float/queue/pick buttons visible in card stats modal, queue/float icons in card table, floated cards in deck builder, auth badge in settings.

3. **Authed but viewing another seat:** Same as spectator — no action buttons, no queue/float icons, no floated cards. Auth badge should NOT show (since selectedSeat !== mySeat, `isAuthed` is false).

4. **Switch back to own seat:** All action UI reappears, auth badge shows.
