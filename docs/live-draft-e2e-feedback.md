# Live Draft E2E Test Feedback — Round 2

Feedback from second round of manual E2E testing (2026-03-26) after gap closure agent made its first pass. Items from round 1 that were fixed are removed. New items and persistent issues are listed below.

## Pick Controls UX (NOT FIXED from round 1)

1. **Pick/queue icons are still wrong.** The agent replaced the old icons with a checkmark (✓) for pick and (+) for queue, rendered as tiny outlined boxes to the left of the card. The feedback asked for these controls to use the same visual language as the existing deck builder icons (the stacked-layers `DeckIcon` in `CardNameCell.tsx`) and to live on the right side of the card cell alongside those icons — not as separate iconography on the left.
2. **Deck builder button and card-selected icon still missing** when logged into a live draft with a token.

## Pick Feedback & State (NOT FIXED from round 1)

3. **No visual feedback after making a pick.** The card is not removed or dimmed after picking. The pick button disappears but the card looks the same as unpicked cards.
4. **Double picks still not communicated.** No UI indication that you have two consecutive picks in a double-pick round.
5. **Polling not updating taken cards.** After AI seats make their picks, the card table still shows pick buttons on cards that have already been taken. The polling is either not running or not refreshing the taken cards set in the UI.
6. **Queued cards not auto-dequeued when taken.** If a card in your queue is picked by another seat, it stays in the queue. It should be silently removed.

## Draft Board

7. **Much improved from round 1** — mana symbols are showing, background colors removed, board is wider. Good progress.
8. **Show only front-face mana cost for double-faced cards.** Cards like Fable of the Mirror-Breaker are showing mana costs for both faces. Only the front face cost should appear.

## Match Reporting

9. **Spinners removed — good.**
10. **Save button styling improved — good.** More subdued, fits the dark theme better.
11. **Standings table STILL not working.** After saving match results (e.g., 2-0 vs Seat 6, 0-2 vs Seat 8), the standings table shows only dashes for every row. The Player column doesn't even show seat numbers/names. Data is being saved (results persist across page loads) but the standings query or rendering is completely broken. This was the #1 bug from round 1 and is still present.
12. **Win/loss validation still missing.** Values are no longer unrestricted (the 20-win bug from round 1), but inputs should be constrained to exactly 0, 1, or 2.

## Stale State on Draft Reset

13. **Deck builder loads stale cards from previous draft.** When a draft is reset and recreated with the same draft ID, the deck builder shows cards from the previous draft (loaded from localStorage keyed by draft_id + seat). Cards from the old draft appear as "in deck builder" with blue deck icons.
14. **Card table shows stale taken state.** Same root cause — cards picked in the previous draft appear as taken in the new draft. The localStorage state for a draft should be invalidated when the draft resets to `drafting` phase with 0 picks, or the deck builder should check that its stored cards are actually in the current pick set.

## Auto-Pick Behavior

15. **Auto-pick with queued card should fire immediately.** When toggling auto-pick ON with a card already queued and it's your turn, the pick should happen immediately rather than waiting for the next poll cycle.

## API / Protocol Notes (from round 1, still relevant for documentation)

16. **Pick API body field is `card_name`** (not `cardName`).
17. **`/available` endpoint returns `{ cards: [...] }` with `{ card_name, remaining_qty }` objects** (not a flat array with `name` field).
