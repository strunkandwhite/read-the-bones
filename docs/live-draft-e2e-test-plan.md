# Live Draft E2E Test Plan

Manual test plan for verifying the full live draft flow with 10 seats, 5 picks per player (50 total picks), 9 AI drafters, and 1 human player.

## Prerequisites

- Working Node.js environment with access to Turso and CubeCobra
- pnpm installed, dependencies installed (`pnpm install`)
- Environment variables set: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (from `.env.local`)
- Dev server running (`pnpm dev`)

## Step 1: Create the Draft

```bash
pnpm draft:create-live \
  --name "sandbox-test" \
  --date 2026-03-26 \
  --seats 10 \
  --picks-per-player 5 \
  --pool cubecobra:samp
```

This will:
- Fetch the 540-card samp cube from CubeCobra
- Resolve all cards through the Scryfall cache
- Create the draft in Turso with `phase = 'setup'` and `in_app = true`
- Generate 10 cryptographic seat tokens
- Print 10 shareable URLs in the format: `http://localhost:3000/drafts/<draft-id>?token=<token>`

Save all 10 URLs. Give seat 1's URL to the human player. Keep seats 2-10 for AI simulation.

## Step 2: Start the Draft

```bash
pnpm draft:start sandbox-test
```

Transitions the draft from `setup` to `drafting`. Picks can now be submitted.

## Step 3: Check Draft Status

```bash
curl -s "http://localhost:3000/api/drafts/sandbox-test/status" | python3 -m json.tool
```

Response includes:
- `phase` — should be `"drafting"`
- `nextSeat` — which seat picks next (should be `1`)
- `latestPickN` — current pick count (should be `0`)
- `totalPicks` — should be `50`

## Step 4: Verify Seat Resolution

Using seat 1's token:

```bash
curl -s "http://localhost:3000/api/drafts/sandbox-test/me" \
  -H "X-Seat-Token: <seat-1-token>"
```

Expected: `{ "seat": 1, "autoPick": true, "displayName": null }`

## Step 5: Simulate Picks

The draft uses snake order: Round 1 goes seats 1-10, Round 2 goes 10-1, etc. With 5 picks per player and 10 seats, that's 5 rounds of 10 picks each.

Pick order:
```
Round 1 (->): seats 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
Round 2 (<-): seats 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
Round 3 (->): seats 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
Round 4 (<-): seats 10, 9, 8, 7, 6, 5, 4, 3, 2, 1
Round 5 (->): seats 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
```

To submit a pick for an AI seat:

```bash
curl -X POST "http://localhost:3000/api/drafts/sandbox-test/pick" \
  -H "Content-Type: application/json" \
  -H "X-Seat-Token: <token-for-that-seat>" \
  -d '{"card_name": "Lightning Bolt"}'
```

To get available cards:

```bash
curl -s "http://localhost:3000/api/drafts/sandbox-test/available?before_pick_n=<next-pick-number>"
```

### Simulation Loop

1. Check `/api/drafts/sandbox-test/status` to get `nextSeat`
2. If `nextSeat` is the human player (seat 1), wait for them to pick via the UI
3. If `nextSeat` is an AI seat (2-10), fetch available cards, pick one randomly:

```bash
# Get a random available card name, then POST a pick
CARD=$(curl -s ".../available?before_pick_n=$NEXT_PICK" | python3 -c "import sys,json,random; cards=json.load(sys.stdin); print(random.choice(cards[:50])['name'])" 2>/dev/null)
curl -X POST ".../pick" -H "Content-Type: application/json" -H "X-Seat-Token: $TOKEN" -d "{\"card_name\": \"$CARD\"}"
```

4. Repeat until all 50 picks are made (phase auto-transitions to `playing`)

### Example Simulation Script

```bash
#!/bin/bash
DRAFT_ID="sandbox-test"
BASE_URL="http://localhost:3000/api/drafts/$DRAFT_ID"
TOTAL_PICKS=50

# Declare seat tokens (seats 2-10, from draft:create-live output)
declare -A TOKENS
TOKENS[2]="<token>"
TOKENS[3]="<token>"
# ... fill in tokens for seats 2-10

while true; do
  STATUS=$(curl -s "$BASE_URL/status")
  PHASE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['phase'])")
  NEXT_SEAT=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['nextSeat'])")
  LATEST_PICK=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin)['latestPickN'])")

  if [ "$PHASE" != "drafting" ]; then
    echo "Draft phase: $PHASE — done!"
    break
  fi

  if [ "$LATEST_PICK" -ge "$TOTAL_PICKS" ]; then
    echo "All $TOTAL_PICKS picks complete!"
    break
  fi

  if [ "$NEXT_SEAT" -eq 1 ]; then
    echo "Pick $((LATEST_PICK + 1))/50 — Waiting for human (seat 1)..."
    sleep 3
    continue
  fi

  NEXT_PICK=$((LATEST_PICK + 1))
  CARD=$(curl -s "$BASE_URL/available?before_pick_n=$NEXT_PICK" | python3 -c "
import sys, json, random
cards = json.load(sys.stdin)
if cards:
    print(random.choice(cards[:50])['name'])
else:
    print('')
")

  if [ -z "$CARD" ]; then
    echo "No cards available — something went wrong"
    break
  fi

  TOKEN="${TOKENS[$NEXT_SEAT]}"
  curl -s -X POST "$BASE_URL/pick" \
    -H "Content-Type: application/json" \
    -H "X-Seat-Token: $TOKEN" \
    -d "{\"card_name\": \"$CARD\"}" > /dev/null

  echo "Pick $NEXT_PICK/50 — Seat $NEXT_SEAT picked: $CARD"
  sleep 0.5
done
```

## Step 6: Visual Verification

Open the human player's URL in a browser:

```
http://localhost:3000/drafts/sandbox-test?token=<seat-1-token>
```

You should see:
- The draft auto-selected as the active draft
- The card table showing available cards with queue icons
- A "Pick" button on available cards when it's your turn (seat 1)
- A "Draft Board" button in the toolbar
- Click "Draft Board" to see the pick matrix with all picks in snake order

### Via Chrome DevTools MCP

```
mcp__chrome-devtools__navigate_page  url=http://localhost:3000/drafts/sandbox-test?token=<seat-1-token>
mcp__chrome-devtools__take_screenshot  fullPage=true
```

## Step 7: Verify Match Reporting

After all 50 picks are made, the draft auto-transitions to `playing` phase.

1. Open Draft Board modal
2. Scroll to standings section
3. Verify match reporting inputs appear for the human player's seat
4. Submit a test match result:

```bash
curl -X POST "http://localhost:3000/api/drafts/sandbox-test/match" \
  -H "Content-Type: application/json" \
  -H "X-Seat-Token: <seat-1-token>" \
  -d '{"opponent_seat": 2, "wins": 2, "losses": 1}'
```

5. Verify the standings table updates

## Step 8: Cleanup

```bash
pnpm draft:admin set-phase sandbox-test --phase complete
```

Or to fully remove:

```bash
pnpm draft:reset sandbox-test
```

## Key API Endpoints Reference

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/drafts/<id>/status` | GET | None | Draft state, next seat |
| `/api/drafts/<id>/me` | GET | X-Seat-Token | Resolve token to seat |
| `/api/drafts/<id>/pick` | POST | X-Seat-Token | Submit a pick |
| `/api/drafts/<id>/queue` | GET/PUT | X-Seat-Token | Manage pick queue |
| `/api/drafts/<id>/board` | GET | None | Full pick matrix |
| `/api/drafts/<id>/match` | POST | X-Seat-Token | Report match result |
| `/api/drafts/<id>/available` | GET | None | Available cards |
| `/api/drafts/<id>/seat-settings` | PUT | X-Seat-Token | Auto-pick toggle, display name |
| `/api/drafts/<id>/standings` | GET | None | Match standings |

## Notes

- The `card_name` in the pick POST must match exactly (Scryfall-resolved name)
- Picks cascade: if a seat has `auto_pick = true` and a queue set, the server will auto-pick for subsequent seats until it hits a seat that needs manual input
- Optimistic concurrency: if two picks race for the same `pick_n`, one gets a conflict error — just retry
- The draft auto-transitions to `playing` phase when all 50 picks are submitted
- The `/me` endpoint requires the gap closure plan (Task 1) to be implemented first
- The `/drafts/[id]` page route requires Task 3 from the gap closure plan
