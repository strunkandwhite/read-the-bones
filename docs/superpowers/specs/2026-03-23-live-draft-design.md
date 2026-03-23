# Live Draft System Design

Run a complete rotisserie draft within Read the Bones — from pool definition through drafting, match play, and final standings. Replaces the Google Sheet as the primary drafting interface.

## Principles

- **A draft is a draft.** Live drafts use the same schema as historical imports. The only difference is how the data enters the system.
- **Derived state.** "Whose turn is it?" is always computed from pick_events + the snake formula. No stored current-turn pointer.
- **Card table is home base.** Players search, filter, pick, and queue cards from the existing card table. No separate picking interface.
- **Honor system with guardrails.** Seat tokens scope actions to the right player. No passwords, no auth system.

## Schema Changes

### Extending `drafts`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `phase` | text | `'complete'` | One of: `setup`, `drafting`, `playing`, `complete` |
| `in_app` | boolean | `false` | `true` for drafts created through the live flow |
| `picks_per_player` | integer | — | Number of picks each seat makes (e.g., 45, 40) |

Historical drafts are migrated to `phase = 'complete'`, `in_app = false`. `picks_per_player` is backfilled as `max(pick_n) / num_seats` for completed drafts (advisory only — not used for snake derivation on historical drafts).

### Deprecating `is_complete`

The existing `is_complete` column is replaced by `phase`. Migration:
- `is_complete = 1` → `phase = 'complete'`
- `is_complete = 0` → `phase = 'drafting'` (active imports from Sheets)

All queries referencing `is_complete` are updated to use `phase` instead. The `is_complete` column is dropped after migration.

### Extending `match_events`

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `reported_by_seat` | integer | `null` | Which seat submitted the result, or null for admin/import |

### New: `seat_tokens`

| Column | Type | Description |
|--------|------|-------------|
| `draft_id` | text (FK) | References `drafts.draft_id` |
| `seat` | integer | 1-indexed seat number |
| `token` | text | Cryptographically random, unique |
| `display_name` | text (nullable) | Player-chosen name |
| `auto_pick` | boolean | If true, queue fires automatically on this seat's turn. Default true. |

- Primary key: `(draft_id, seat)`
- Unique index on `token`

### New: `pick_queue`

| Column | Type | Description |
|--------|------|-------------|
| `draft_id` | text (FK) | References `drafts.draft_id` |
| `seat` | integer | 1-indexed seat number |
| `priority` | integer | 1 = first choice, 2 = second, etc. |
| `oracle_id` | text (FK) | References `cards.oracle_id` |

- Primary key: `(draft_id, seat, priority)`

Auto-pick preference is a **global toggle per seat**, stored in `seat_tokens.auto_pick`. The player toggles it via the UI, which updates it server-side. During `processPick` cascades, the server checks the next seat's `auto_pick` flag — if false, the cascade stops and waits for manual confirmation.

## Draft Lifecycle

### Phases

```
setup → drafting → playing → complete
```

- **setup**: Pool defined, seats configured, tokens generated. Not yet drafting.
- **drafting**: Picks are happening. Transitions to `playing` when `count(pick_events) == num_seats * picks_per_player`.
- **playing**: All picks made. Players report match results.
- **complete**: All matches reported (or admin marks it done).

The `drafting → playing` transition is auto-detected. Other transitions are admin-triggered via CLI.

### Creating a Draft (CLI)

```bash
pnpm draft:create-live \
  --name "Tarkir Rotisserie" \
  --date 2026-04-01 \
  --seats 10 \
  --picks-per-player 45 \
  --pool cubecobra:modern_cube_id \
  --banned-cards "Card A,Card B"
```

The command:
1. Creates the draft record with `in_app = true`, `phase = 'setup'`
2. Fetches the card pool (CubeCobra API or pasted list file)
3. Resolves card names through the existing Scryfall pipeline
4. Creates a cube snapshot
5. Generates one cryptographically random token per seat
6. Prints all seat tokens/URLs for the organizer to distribute

### Card Pool Sources

**CubeCobra import (primary):** Fetches `GET https://cubecobra.com/cube/api/cubelist/:id`, which returns a newline-separated plaintext list of card names with CORS enabled. The cube ID is extracted from a CubeCobra URL or passed directly.

**Paste fallback:** A text file of card names, one per line. Passed as `--pool file:path/to/list.txt`.

Both feed into the existing Scryfall resolution + cube snapshot pipeline. If the CubeCobra API is unavailable, the CLI prints an error suggesting the `file:` fallback.

### Token Distribution

The CLI prints seat URLs in the format: `https://<host>/drafts/<id>?token=<token>`. The organizer shares these links with players. The client extracts the token from the URL on first visit and persists it in localStorage keyed by draft ID. Subsequent visits to the draft page use the stored token automatically.

## Snake Draft Order

The `derivePickSeat` function computes which seat picks at any position.

### Inputs

- `pickNumber` — 1-indexed absolute pick position
- `numSeats` — number of drafters
- `picksPerPlayer` — total picks each player makes

### Single vs. Double Picks

Double picks begin at the round boundary after the halfway point of each player's picks:

```
doublePickStartRound = floor(picksPerPlayer / 2) + 1
```

Before that round, each seat picks one card per turn. From that round onward, each seat picks two cards sequentially on their turn.

### Snake Pattern

Odd rounds go forward (seat 1 → N), even rounds go reverse (seat N → 1). Within a double-pick turn, both picks belong to the same seat before the snake advances.

### Pseudocode

```
function derivePickSeat(pickNumber, numSeats, picksPerPlayer):
  singlePickRounds = floor(picksPerPlayer / 2)
  singlePickTotal = singlePickRounds * numSeats
  picksPerDoubleRound = numSeats * 2

  if pickNumber <= singlePickTotal:
    // Single-pick region
    round = ceil(pickNumber / numSeats)          // 1-indexed round
    posInRound = (pickNumber - 1) % numSeats      // 0-indexed position within round
  else:
    // Double-pick region
    doublePickIndex = pickNumber - singlePickTotal - 1  // 0-indexed into double region
    doubleRound = floor(doublePickIndex / picksPerDoubleRound)
    posInDoubleRound = doublePickIndex % picksPerDoubleRound
    round = singlePickRounds + 1 + doubleRound
    posInRound = floor(posInDoubleRound / 2)      // each seat gets 2 consecutive picks

  isForward = (round % 2 == 1)
  if isForward:
    seat = posInRound + 1
  else:
    seat = numSeats - posInRound

  return { seat, round, isDoublePick: pickNumber > singlePickTotal }
```

### Example (10 seats, 45 picks)

```
singlePickRounds = floor(45/2) = 22
singlePickTotal = 22 * 10 = 220

Rounds 1-22 (single): 220 picks
  Round 1 (→): seats 1,2,3,...,10
  Round 2 (←): seats 10,9,8,...,1
  ...

Rounds 23+ (double): 230 picks (20 picks per round)
  Round 23 (→): seats 1,1,2,2,3,3,...,10,10
  Round 24 (←): seats 10,10,9,9,...,1,1
  ...

Verification (4 seats, 6 picks each, 24 total):
  singlePickRounds = 3, singlePickTotal = 12
  Pick  1 → Round 1 →, seat 1    Pick 13 → Round 4 ←, seat 4 (double)
  Pick  2 → Round 1 →, seat 2    Pick 14 → Round 4 ←, seat 4
  Pick  3 → Round 1 →, seat 3    Pick 15 → Round 4 ←, seat 3
  Pick  4 → Round 1 →, seat 4    Pick 16 → Round 4 ←, seat 3
  Pick  5 → Round 2 ←, seat 4    Pick 17 → Round 4 ←, seat 2
  Pick  6 → Round 2 ←, seat 3    Pick 18 → Round 4 ←, seat 2
  Pick  7 → Round 2 ←, seat 2    Pick 19 → Round 4 ←, seat 1
  Pick  8 → Round 2 ←, seat 1    Pick 20 → Round 4 ←, seat 1
  Pick  9 → Round 3 →, seat 1    Pick 21 → Round 5 →, seat 1 (double)
  Pick 10 → Round 3 →, seat 2    Pick 22 → Round 5 →, seat 1
  Pick 11 → Round 3 →, seat 3    Pick 23 → Round 5 →, seat 2
  Pick 12 → Round 3 →, seat 4    Pick 24 → Round 5 →, seat 2
```

## Pick Flow

### Token Authentication

The seat token is passed as a request header (`X-Seat-Token`) or query parameter. The API route looks up the token in `seat_tokens` and resolves the `(draft_id, seat)` pair. Requests with invalid or missing tokens are rejected for mutation endpoints.

### Making a Pick

`POST /api/drafts/[id]/pick` with body `{ card_name }` and seat token.

The `processPick` function:

1. **Validate**: draft phase is `drafting`, it's this seat's turn (derived), card is available and not banned
2. **Insert** the pick into `pick_events` using optimistic concurrency: `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM pick_events WHERE draft_id = ? AND pick_n = ?)`. If the pick_n already exists (concurrent write), return a conflict error and the client retries.
3. **Clean up queues**: remove the picked card from every seat's `pick_queue`
4. **Cascade**: derive the next seat, check if that seat has an auto-pick queued for an available card. If yes, repeat from step 1 for that seat. Continue until a seat has no valid auto-pick, then stop. Maximum cascade depth: `num_seats * 2` (one full snake round of double picks). If exceeded, stop and let the next poll trigger further processing.
5. **Phase check**: if `count(pick_events) == num_seats * picks_per_player`, transition draft to `playing`
6. **Return** all new picks created (including cascaded auto-picks)

### Optimistic Local Update

When a player submits a pick, the client adds it to the local state immediately. On server confirmation, the client reconciles (the response includes any cascaded picks). On error, the client rolls back.

## Pick Queue

### Interaction

The card table is the queue interface. On available cards:

- **Hover** reveals a queue icon (alongside existing hover icons)
- **Click the queue icon** adds the card to the bottom of the queue. The icon changes to show the queue position number (e.g., circled "3")
- **Click the position number** removes the card from the queue. Remaining positions renumber automatically.

Queued cards are visually marked in the card table so the player can see their queue while browsing.

### Behavior

- The queue is **private** — only the token holder can view or modify it
- Auto-pick is **on by default** (stored in `seat_tokens.auto_pick`). Players toggle it via the UI.
- When another player picks a card in your queue, `processPick` removes it from your queue. The client reflects this on the next poll.
- When it's your turn and your top queued card is available:
  - If auto-pick is on: the system picks it during the `processPick` cascade
  - If auto-pick is off: the card is pre-filled in the pick UI for manual confirmation
- If all queued cards are taken, the player picks manually

### API

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `GET /api/drafts/[id]/queue` | GET | Token | Returns the player's queue |
| `PUT /api/drafts/[id]/queue` | PUT | Token | Replaces the queue. Body: `[{ card_name }]` (ordered by priority) |

## Real-Time Updates

### Polling

Clients poll `GET /api/drafts/[id]/status` every 3-5 seconds during the `drafting` and `playing` phases. The response includes:

- `phase` — current draft phase
- `latestPickN` — highest pick number recorded
- `nextSeat` — derived from pick count + snake formula
- `recentPicks` — last N picks (for quick display without a full board fetch)

The client compares `latestPickN` against its local state. If new picks exist, it fetches the updated board data.

### Polling During `playing` Phase

During match play, polling frequency can decrease (every 10-30 seconds). The status response includes match completion count so clients know when new results are in.

## Draft Board Modal

A modal overlay (like the existing deck builder) showing the complete pick matrix.

### Layout

- **Header row (sticky):** Seat numbers or display names. Each seat gets a distinct color. The authenticated player's column is subtly highlighted.
- **Rows per round:** Round number on the left with snake direction arrow (→ forward, ← reverse). Round pairs are visually grouped with a separator.
- **Cells:** Card name with mana symbol icons (from Scryfall SVG data) showing color identity. Hover over a card name to see art + oracle text in a tooltip.
- **Active pick indicator:** A pulsing dashed border on the cell where the next pick belongs.
- **Double-pick rounds:** Labeled with "DOUBLE" marker. Each cell shows two stacked card names.

### Scrolling

The header row sticks to the top. When the modal opens during a live draft, it auto-scrolls to the current round.

### Standings Section

Below the pick matrix (or as a tab within the modal), the standings section shows:

- **During `drafting` phase:** Pick count per seat, current position in the snake
- **During `playing` phase:** Match list and standings table
- **During `complete` phase:** Final standings

### Match Reporting

Each player sees their matchup list within the standings section:

- **Completed matches:** Display-only text showing the result
- **Incomplete matches:** Input fields for wins/losses with a save button
- Submitted results write to `match_events` with `reported_by_seat` set
- **Conflicts:** Either player can submit a result. A second submission for the same matchup overwrites the first. If players disagree, they coordinate externally and one resubmits, or the admin corrects via CLI.

The standings table sorts seats by match wins, with game win percentage as tiebreaker.

### Availability

The draft board modal is accessible for any draft — live or historical. For historical drafts, it shows the completed matrix. This replaces the need to reference the Google Sheet for pick order.

## Admin CLI Tools

All admin operations are implemented as core functions, exposed through CLI scripts. These functions are designed for a future admin UI but only accessible via CLI for now.

| Command | Description |
|---------|-------------|
| `pnpm draft:create-live` | Create a live draft with pool, seats, tokens |
| `pnpm draft:start <name>` | Transition from `setup` → `drafting` |
| `pnpm draft:undo-pick <name>` | Remove the most recent pick (or a specific pick) |
| `pnpm draft:edit-pick <name> --pick <n> --card <name>` | Change a recorded pick |
| `pnpm draft:regen-token <name> --seat <n>` | Generate a new token for a seat |
| `pnpm draft:set-phase <name> --phase <phase>` | Force a phase transition |
| `pnpm draft:add-ban <name> --card <name>` | Ban a card mid-draft |
| `pnpm draft:remove-ban <name> --card <name>` | Remove a ban |
| `pnpm draft:reorder-seats <name> --order 3,1,4,2,...` | Change seat pick order (`setup` phase only) |
| `pnpm draft:enter-match <name> --seats 1,5 --wins 2,1` | Admin-enter a match result |

## API Routes (New)

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/drafts/[id]/status` | GET | None | Draft state, next seat, latest pick |
| `/api/drafts/[id]/pick` | POST | Token | Submit a pick |
| `/api/drafts/[id]/queue` | GET | Token | Get player's pick queue |
| `/api/drafts/[id]/queue` | PUT | Token | Replace player's pick queue |
| `/api/drafts/[id]/board` | GET | None | Full pick matrix data |
| `/api/drafts/[id]/match` | POST | Token | Report a match result |
| `/api/drafts/[id]/standings` | GET | None | Match standings |

## Not in v1

- In-app draft creation UI (admin page)
- Timer / on-the-clock features
- Playoff bracket support
- Notifications (email, webhook, push when it's your turn)
- Spectator chat or comments
