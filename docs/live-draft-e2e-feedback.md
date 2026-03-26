# Live Draft E2E Test Feedback

Feedback from manual E2E testing of the live draft feature (2026-03-26). This should be addressed alongside or after the gap closure plan (`docs/superpowers/plans/2026-03-26-live-draft-gap-closure.md`).

## Pick Controls UX

1. **The big green "Pick" button to the left of each card is ugly.** The `+` queue button is also ugly. Both buttons are needed, but the current presentation is wrong.
2. **Use the existing deck icons as controls.** We already have small icons on the right side of card cells for deck builder actions — the pick and queue controls should follow that same pattern rather than introducing a separate visual language.
3. **The deck builder button and card-selected icon on the right of the card cell are missing** when logged into a live draft. Likely because seat isn't being set properly (token login sets the active draft but not the seat).

## Pick Feedback & State

4. **No visual feedback after making a pick.** After picking a card, the button reverts to "Pick" but the card isn't removed or visually marked as taken. The card appears still pickable but returns an error if you try to pick it again. The UI should immediately reflect that the card was picked (remove from available list, show as taken, etc.).
5. **Double picks are not communicated.** The snake draft has double-pick rounds (seat picks twice consecutively at the turn). Nothing in the UI indicates you have a double pick. After making one pick, it should be clear that you still owe another pick before passing to the next seat.
6. **Auto-pick with a queued pick should fire immediately.** When you toggle auto-pick ON and already have a card queued, it should consume the next queued card right away if it's your turn — not wait for the next polling cycle.

## Draft Board

7. **The draft board is illegible.** Card names are truncated, colored dots are meaningless noise, background colors on every cell make it impossible to scan. The whole thing is too cramped.
8. **Use mana symbols instead of colored dots.** We already have mana symbol rendering elsewhere in the app. The dots convey no useful information — actual mana pips would be meaningful.
9. **Drop the background color-coding on cells.** If we're showing mana symbols, the background colors are redundant and just add visual noise.
10. **The board needs to be both wider and taller.** Cells are too small, card names are truncated. Give it more space.
11. **Remove the "Seat N: X picks" badges.** The pick count per seat is self-evident from looking at the board itself. The badges below the board are redundant clutter.

## Match Reporting

12. **Remove spinners from the win/loss inputs.** The up/down spinner arrows on the number inputs are annoying and unnecessary.
13. **Constrain valid values to 0, 1, and 2.** Currently accepts any number (e.g., 20 wins was accepted and saved). The inputs should enforce `min=0 max=2` or use a segmented control / radio buttons.
14. **Save buttons need better styling.** The bright green/blue "Save"/"Saved" buttons don't match the app's color palette. They should be more subdued and consistent with the rest of the dark theme.
15. **Standings table is not working.** After saving match results, the standings table shows only dashes for every row. The data is being saved (results persist) but the standings query or rendering is broken.

## API / Protocol Issues

16. **The pick API body field is `card_name`, not `cardName`.** The E2E test plan and simulation scripts had this wrong. The API returns `{"error":"card_name required"}` if you use `cardName`. Ensure documentation and client code are consistent.
17. **The `/available` endpoint returns `{ cards: [...] }` with objects shaped `{ card_name, remaining_qty }`.** Not a flat array of objects with a `name` field. Documentation and client code should match.

## Vercel Preview + MCP DevTools

18. **Chrome DevTools MCP cannot interact with Vercel-protected deployments.** The initial page loads but all subsequent JS/API requests get 401'd because the `x-vercel-protection-bypass` query param isn't forwarded on subresource requests. This means MCP-based visual testing requires either localhost or an unprotected deployment.
