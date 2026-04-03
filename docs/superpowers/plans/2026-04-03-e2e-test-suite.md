# E2E Test Suite Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken 15-test e2e suite with a robust ~38-test regression safety net organized by user journey.

**Architecture:** Flow-based Playwright tests with route mocking (no real database). Expanded fixture set (~40 cards, 12 fixture files) to exercise search, filter, sort, live draft, deck builder, and spectator flows. Tests use `createMockContext(scenario)` to compose fixtures per flow.

**Tech Stack:** Playwright, Next.js (E2E_TEST=1 build), Zustand stores, route mocking via `page.route()`

**Spec:** `docs/superpowers/specs/2026-04-03-e2e-test-suite-design.md` (plan file at `.claude/plans/happy-seeking-fairy.md`)

---

## File Structure

### New Files
- `e2e/fixtures/cards-40.json` — 40-card fixture with color/type/mv distribution
- `e2e/fixtures/drafts-list.json` — Draft metadata (active + completed drafts)
- `e2e/fixtures/live-board.json` — Board state: 10 seats, ~20 picks, seat 3's turn
- `e2e/fixtures/live-me.json` — Auth response for seat 3
- `e2e/fixtures/live-queue.json` — Queue entries fixture
- `e2e/fixtures/live-floats.json` — Floated cards fixture
- `e2e/fixtures/live-available.json` — Available cards for autocomplete
- `e2e/fixtures/deck-state.json` — Saved deck state fixture
- `e2e/helpers/auth.ts` — Seat token authentication helper
- `e2e/helpers/assertions.ts` — Reusable test assertions
- `e2e/flows/browse.spec.ts` — Browse & filter tests
- `e2e/flows/live-draft.spec.ts` — Live draft tests
- `e2e/flows/deck-builder.spec.ts` — Deck builder tests
- `e2e/flows/shared-deck.spec.ts` — Shared deck tests
- `e2e/flows/spectator.spec.ts` — Spectator tests

### Modified Files
- `e2e/fixtures/ssr-fixtures.ts` — Update to import cards-40.json
- `e2e/fixtures/sync-status-active.json` — Update draft ID to match new fixtures
- `e2e/fixtures/shared-deck.json` — Update to match new card names
- `e2e/fixtures/draft-stats.json` — Keep mostly as-is, add more seat data
- `e2e/helpers/mock-api.ts` — Rewrite with `createMockContext(scenario)`
- `e2e/helpers/card-table.ts` — Keep existing helpers, add new ones
- `e2e/playwright.config.ts` — Update testDir to include flows/

### Deleted Files
- `e2e/browse-and-filter.spec.ts`
- `e2e/deck-builder.spec.ts`
- `e2e/queue-panel.spec.ts`
- `e2e/active-draft-sync.spec.ts`
- `e2e/fixtures/cards.json` (replaced by cards-40.json)

---

## Chunk 1: Fixtures and Infrastructure

### Task 1: Create cards-40.json

The core fixture. 40 real MTG cards with full Scryfall data. Each card needs `cardName`, `weightedGeomean`, `timesAvailable`, `draftsPickedIn`, `maxCopiesInDraft`, `colors`, and a `scryfall` object with `name`, `imageUri`, `manaCost`, `manaValue`, `typeLine`, `colors`, `colorIdentity`, `oracleText`.

**Files:**
- Create: `e2e/fixtures/cards-40.json`

- [ ] **Step 1: Create cards-40.json with 40 cards**

Use the Scryfall MCP tool (`mcp__scryfall__search` and `mcp__scryfall__fetch`) to get real card data for each card. The fixture wraps the `CardStatsResponse` type:

```json
{
  "cards": [ /* 40 EnrichedCardStats entries */ ],
  "draftCount": 3,
  "cubeCopies": { /* cardName → copy count for each card */ },
  "draftMetadata": {
    "gamma": { "name": "Gamma Draft", "date": "2026-03-01", "numDrafters": 10 },
    "delta": { "name": "Delta Draft", "date": "2026-02-01", "numDrafters": 10 },
    "epsilon": { "name": "Epsilon Draft", "date": "2026-01-01", "numDrafters": 10 }
  },
  "draftIds": ["gamma", "delta", "epsilon"],
  "completedDraftIds": ["delta", "epsilon"],
  "ingestionHash": "e2e-test-hash-001"
}
```

Each card entry follows this structure (example):
```json
{
  "cardName": "Lightning Bolt",
  "weightedGeomean": 3.2,
  "timesAvailable": 3,
  "draftsPickedIn": 3,
  "maxCopiesInDraft": 2,
  "colors": ["R"],
  "scryfall": {
    "name": "Lightning Bolt",
    "imageUri": "https://cards.scryfall.io/normal/front/f/2/f29ba16f-c8fb-42fe-aabf-87089cb214a7.jpg",
    "manaCost": "{R}",
    "manaValue": 1,
    "typeLine": "Instant",
    "colors": ["R"],
    "colorIdentity": ["R"],
    "oracleText": "Lightning Bolt deals 3 damage to any target."
  }
}
```

**Required distribution (40 cards total):**

| Color | Count | Cards (use real MTG cards) |
|-------|-------|---------------------------|
| W | 6 | Swords to Plowshares, Mother of Runes, Palace Jailer, Wrath of God, Elspeth Knight-Errant, Land Tax |
| U | 6 | Counterspell, Brainstorm, Snapcaster Mage, Cryptic Command, Jace the Mind Sculptor, Mystical Tutor |
| B | 6 | Dark Ritual, Thoughtseize, Liliana of the Veil, Demonic Tutor, Doom Blade, Phyrexian Arena |
| R | 6 | Lightning Bolt, Goblin Guide, Inferno Titan, Chaos Warp, Kiki-Jiki Mirror Breaker, Faithless Looting |
| G | 6 | Llanowar Elves, Birds of Paradise, Tarmogoyf, Natural Order, Craterhoof Behemoth, Sylvan Library |
| Multicolor | 4 | Teferi Time Raveler (WU), Kolaghan's Command (BR), Growth Spiral (UG), Vindicate (WB) |
| Colorless | 4 | Sol Ring, Mana Crypt, Wurmcoil Engine, Batterskull |
| Land | 2 | Scalding Tarn, Misty Rainforest |

**Type distribution across the 40:**
- Creatures: ~12 (Goblin Guide, Snapcaster, Tarmogoyf, Llanowar Elves, Birds of Paradise, Mother of Runes, Inferno Titan, Craterhoof Behemoth, Kiki-Jiki, Palace Jailer, Wurmcoil Engine, Batterskull)
- Instants: ~8 (Lightning Bolt, Counterspell, Brainstorm, Swords to Plowshares, Cryptic Command, Doom Blade, Chaos Warp, Mystical Tutor)
- Sorceries: ~5 (Thoughtseize, Wrath of God, Demonic Tutor, Natural Order, Faithless Looting, Vindicate)
- Planeswalkers: ~3 (Teferi, Liliana, Jace, Elspeth)
- Enchantments: ~2 (Phyrexian Arena, Sylvan Library, Land Tax)
- Artifacts: ~2 (Sol Ring, Mana Crypt)
- Lands: ~2 (Scalding Tarn, Misty Rainforest)

**Multi-copy cards (critical for queue tests):**
- `"Lightning Bolt"`: `maxCopiesInDraft: 2`, `cubeCopies: 2` — neither copy picked in board fixture
- `"Scalding Tarn"`: `maxCopiesInDraft: 2`, `cubeCopies: 2` — one copy picked by seat 5 in board fixture

**Oracle text variety (for `o:` search tests):**
- "draw a card": Brainstorm ("Draw three cards, then put two cards from your hand on top...")
- "flying": Teferi doesn't have it, but other cards should include it in oracle text — check when fetching
- "destroy target": Doom Blade, Vindicate
- "counter target": Counterspell, Cryptic Command

**Mana value spread:**
- MV 0: Mana Crypt
- MV 1: Lightning Bolt, Swords to Plowshares, Brainstorm, Dark Ritual, Llanowar Elves, Birds of Paradise, Goblin Guide, Mother of Runes, Faithless Looting, Mystical Tutor, Land Tax, Sol Ring
- MV 2: Counterspell, Tarmogoyf, Doom Blade, Thoughtseize, Growth Spiral, Sylvan Library
- MV 3: Teferi, Kolaghan's Command, Liliana, Vindicate, Phyrexian Arena
- MV 4: Wrath of God, Jace, Natural Order, Elspeth, Cryptic Command
- MV 5: Kiki-Jiki, Batterskull
- MV 6: Inferno Titan, Wurmcoil Engine, Craterhoof Behemoth, Demonic Tutor? (actually MV 2)
- Lands: MV 0

Assign `weightedGeomean` values spread from 2.0 to 25.0 so sorting tests can verify order changes.

For `cubeCopies`, set all to 1 except Lightning Bolt (2) and Scalding Tarn (2).

- [ ] **Step 2: Verify fixture structure**

Run: `node -e "const f = require('./e2e/fixtures/cards-40.json'); console.log('Cards:', f.cards.length, 'CubeCopies keys:', Object.keys(f.cubeCopies).length)"`

Expected: `Cards: 40 CubeCopies keys: 40`

- [ ] **Step 3: Commit**

```bash
git add e2e/fixtures/cards-40.json
git commit -m "Add 40-card e2e fixture with color/type/mv distribution"
```

---

### Task 2: Create remaining fixture files

**Files:**
- Create: `e2e/fixtures/drafts-list.json`
- Create: `e2e/fixtures/live-board.json`
- Create: `e2e/fixtures/live-me.json`
- Create: `e2e/fixtures/live-queue.json`
- Create: `e2e/fixtures/live-floats.json`
- Create: `e2e/fixtures/live-available.json`
- Create: `e2e/fixtures/deck-state.json`
- Modify: `e2e/fixtures/sync-status-active.json`
- Modify: `e2e/fixtures/shared-deck.json`
- Modify: `e2e/fixtures/draft-stats.json`

- [ ] **Step 1: Create drafts-list.json**

This is used by the sync-status endpoint to provide the active draft list, and by Settings to populate the draft selector. It's not a direct API response — it's consumed by `createMockContext` to build the sync-status and SSR card data responses.

```json
{
  "activeDrafts": [
    { "id": "gamma", "name": "Gamma Draft", "date": "2026-03-01", "numSeats": 10 }
  ],
  "completedDrafts": [
    { "id": "delta", "name": "Delta Draft", "date": "2026-02-01", "numSeats": 10 },
    { "id": "epsilon", "name": "Epsilon Draft", "date": "2026-01-01", "numSeats": 10 }
  ]
}
```

- [ ] **Step 2: Create live-board.json**

Response shape for `GET /api/drafts/gamma/live`. Must include Scalding Tarn picked by seat 5. Board has 10 seats, ~20 picks made, seat 3's turn next. Snake draft order.

```json
{
  "phase": "drafting",
  "numSeats": 10,
  "picksPerPlayer": 45,
  "latestPickN": 20,
  "nextSeat": 3,
  "recentPicks": [
    { "pickN": 22, "seat": 2, "cardName": "Snapcaster Mage" },
    { "pickN": 21, "seat": 1, "cardName": "Mother of Runes" },
    { "pickN": 20, "seat": 1, "cardName": "Elspeth, Knight-Errant" }
  ],
  "seatNames": {
    "1": "Bob", "2": "Carol", "3": "Alice", "4": "Dave",
    "5": "Eve", "6": "Frank", "7": "Grace", "8": "Heidi",
    "9": "Ivan", "10": "Judy"
  },
  "matchCount": 0,
  "totalMatches": 45,
  "picks": [
    { "pickN": 1, "seat": 1, "cardName": "Sol Ring", "oracleId": "sol-ring-id", "colorIdentity": [], "manaCost": "{1}" },
    { "pickN": 2, "seat": 2, "cardName": "Mana Crypt", "oracleId": "mana-crypt-id", "colorIdentity": [], "manaCost": "{0}" },
    { "pickN": 3, "seat": 3, "cardName": "Brainstorm", "oracleId": "brainstorm-id", "colorIdentity": ["U"], "manaCost": "{U}" },
    { "pickN": 4, "seat": 4, "cardName": "Demonic Tutor", "oracleId": "demonic-tutor-id", "colorIdentity": ["B"], "manaCost": "{1}{B}" },
    { "pickN": 5, "seat": 5, "cardName": "Scalding Tarn", "oracleId": "scalding-tarn-id", "colorIdentity": ["U", "R"], "manaCost": "" },
    { "pickN": 6, "seat": 6, "cardName": "Tarmogoyf", "oracleId": "tarmogoyf-id", "colorIdentity": ["G"], "manaCost": "{1}{G}" },
    { "pickN": 7, "seat": 7, "cardName": "Swords to Plowshares", "oracleId": "stplow-id", "colorIdentity": ["W"], "manaCost": "{W}" },
    { "pickN": 8, "seat": 8, "cardName": "Dark Ritual", "oracleId": "dark-ritual-id", "colorIdentity": ["B"], "manaCost": "{B}" },
    { "pickN": 9, "seat": 9, "cardName": "Counterspell", "oracleId": "counterspell-id", "colorIdentity": ["U"], "manaCost": "{U}{U}" },
    { "pickN": 10, "seat": 10, "cardName": "Lightning Bolt", "oracleId": "bolt-id", "colorIdentity": ["R"], "manaCost": "{R}" },
    { "pickN": 11, "seat": 10, "cardName": "Goblin Guide", "oracleId": "goblin-guide-id", "colorIdentity": ["R"], "manaCost": "{R}" },
    { "pickN": 12, "seat": 9, "cardName": "Llanowar Elves", "oracleId": "llanowar-id", "colorIdentity": ["G"], "manaCost": "{G}" },
    { "pickN": 13, "seat": 8, "cardName": "Thoughtseize", "oracleId": "thoughtseize-id", "colorIdentity": ["B"], "manaCost": "{B}" },
    { "pickN": 14, "seat": 7, "cardName": "Jace, the Mind Sculptor", "oracleId": "jace-id", "colorIdentity": ["U"], "manaCost": "{2}{U}{U}" },
    { "pickN": 15, "seat": 6, "cardName": "Birds of Paradise", "oracleId": "birds-id", "colorIdentity": ["G"], "manaCost": "{G}" },
    { "pickN": 16, "seat": 5, "cardName": "Liliana of the Veil", "oracleId": "liliana-id", "colorIdentity": ["B"], "manaCost": "{1}{B}{B}" },
    { "pickN": 17, "seat": 4, "cardName": "Natural Order", "oracleId": "natural-order-id", "colorIdentity": ["G"], "manaCost": "{2}{G}{G}" },
    { "pickN": 18, "seat": 3, "cardName": "Cryptic Command", "oracleId": "cryptic-id", "colorIdentity": ["U"], "manaCost": "{1}{U}{U}{U}" },
    { "pickN": 19, "seat": 2, "cardName": "Wrath of God", "oracleId": "wrath-id", "colorIdentity": ["W"], "manaCost": "{2}{W}{W}" },
    { "pickN": 20, "seat": 1, "cardName": "Elspeth, Knight-Errant", "oracleId": "elspeth-id", "colorIdentity": ["W"], "manaCost": "{2}{W}{W}" }
  ],
  "bannedCards": []
}
```

Note: Seat 5 picked "Scalding Tarn" at pick 5. Seat 3 (Alice, our test user) has picks at positions 3 and 18. Next pick is 21, which in snake order goes to seat 1 (round 3 starts), so `nextSeat` should be 1 for round 3, NOT seat 3. We need seat 3's turn for testing — adjust the pick count so that the next pick falls on seat 3.

**Correction:** For snake draft with 10 seats: Round 1 = picks 1-10 (seats 1→10), Round 2 = picks 11-20 (seats 10→1), Round 3 = picks 21-30 (seats 1→10). So pick 21 goes to seat 1, pick 23 goes to seat 3. We need 22 picks total so the next pick (#23) is seat 3's turn:

Add 2 more picks:
```json
    { "pickN": 21, "seat": 1, "cardName": "Mother of Runes", "oracleId": "mother-runes-id", "colorIdentity": ["W"], "manaCost": "{W}" },
    { "pickN": 22, "seat": 2, "cardName": "Snapcaster Mage", "oracleId": "snapcaster-id", "colorIdentity": ["U"], "manaCost": "{1}{U}" }
```

And set `"latestPickN": 22, "nextSeat": 3`.

Update `recentPicks` accordingly.

Also include `takenCards` and `bannedCardNames` in the cards-40.json response when serving it for the live-draft scenario:
```json
"takenCards": [
  { "name": "Sol Ring", "seat": 1 },
  { "name": "Mana Crypt", "seat": 2 },
  { "name": "Brainstorm", "seat": 3 },
  // ... all 22 picked cards
],
"bannedCardNames": []
```

- [ ] **Step 3: Create live-me.json**

```json
{
  "seat": 3,
  "autoPick": true,
  "displayName": "Alice"
}
```

- [ ] **Step 4: Create live-queue.json**

Response shape for `GET /api/drafts/gamma/queue`. Mix of entry types for testing:

```json
{
  "queue": [
    {
      "mode": "pause",
      "cards": [{ "id": 1, "name": "Doom Blade" }]
    },
    {
      "mode": "flow-through",
      "cards": [
        { "id": 2, "name": "Teferi, Time Raveler" },
        { "id": 3, "name": "Kolaghan's Command" },
        { "id": 4, "name": "Vindicate" }
      ]
    },
    {
      "mode": "pause",
      "cards": [{ "id": 5, "name": "Faithless Looting" }]
    }
  ]
}
```

- [ ] **Step 5: Create live-floats.json**

```json
{
  "cards": ["Phyrexian Arena", "Growth Spiral"]
}
```

- [ ] **Step 6: Create live-available.json**

Response for `GET /api/drafts/gamma/available?before_pick_n=23`. Lists cards not yet picked. Include all 40 cards minus the 22 already picked in the board fixture. The response shape from the route handler:

```json
{
  "cards": [
    { "card_name": "Lightning Bolt", "remaining_qty": 2 },
    { "card_name": "Scalding Tarn", "remaining_qty": 1 },
    { "card_name": "Doom Blade", "remaining_qty": 1 },
    { "card_name": "Teferi, Time Raveler", "remaining_qty": 1 }
  ]
}
```

Include all ~18 unpicked cards. Scalding Tarn has `remaining_qty: 1` (one of two copies taken). Lightning Bolt has `remaining_qty: 2` (neither copy taken).

- [ ] **Step 7: Create deck-state.json**

Response for `GET /api/drafts/gamma/deck-state`. Seat 3's in-progress deck. Include the cards seat 3 has picked (Brainstorm, Cryptic Command) plus some floated cards:

```json
{
  "draftId": "gamma",
  "seat": 3,
  "zones": {
    "deck": {
      "U": ["Brainstorm", "Cryptic Command"]
    },
    "sideboard": {
      "sb": []
    }
  },
  "basicLands": {
    "Plains": 0,
    "Island": 8,
    "Swamp": 0,
    "Mountain": 0,
    "Forest": 0
  }
}
```

Note: Floated cards (Phyrexian Arena, Growth Spiral) also appear in the deck zones because the deck builder shows them. The `floatedCards` state from liveStore determines their visual treatment (dashed border). Add them:

```json
{
  "draftId": "gamma",
  "seat": 3,
  "zones": {
    "deck": {
      "U": ["Brainstorm", "Cryptic Command"],
      "B": ["Phyrexian Arena"],
      "UG": ["Growth Spiral"]
    },
    "sideboard": {
      "sb": []
    }
  },
  "basicLands": {
    "Plains": 0,
    "Island": 8,
    "Swamp": 0,
    "Mountain": 0,
    "Forest": 0
  }
}
```

- [ ] **Step 8: Update sync-status-active.json**

Change draft ID to match our fixtures:

```json
{
  "lastSyncedAt": "1711100000",
  "syncInProgress": false,
  "activeDrafts": [{ "id": "gamma", "numSeats": 10 }]
}
```

- [ ] **Step 9: Update shared-deck.json**

Update to use card names from cards-40.json:

```json
{
  "draftId": "delta",
  "seat": 5,
  "zones": {
    "deck": {
      "W": ["Swords to Plowshares", "Mother of Runes", "Wrath of God"],
      "U": ["Counterspell", "Brainstorm", "Snapcaster Mage"],
      "R": ["Lightning Bolt", "Goblin Guide"],
      "C": ["Sol Ring"]
    },
    "sideboard": {
      "sb": ["Doom Blade", "Chaos Warp"]
    }
  },
  "basicLands": {
    "Plains": 4,
    "Island": 6,
    "Swamp": 0,
    "Mountain": 4,
    "Forest": 0
  }
}
```

- [ ] **Step 10: Update draft-stats.json**

Add entries for 10 seats to match our 10-seat drafts:

```json
{
  "winRateBySeat": [
    { "seat": 1, "wins": 8, "losses": 4, "winRate": 0.667, "ciLower": 0.39, "ciUpper": 0.87 },
    { "seat": 2, "wins": 6, "losses": 6, "winRate": 0.5, "ciLower": 0.25, "ciUpper": 0.75 },
    { "seat": 3, "wins": 7, "losses": 5, "winRate": 0.583, "ciLower": 0.32, "ciUpper": 0.82 },
    { "seat": 4, "wins": 5, "losses": 7, "winRate": 0.417, "ciLower": 0.18, "ciUpper": 0.68 },
    { "seat": 5, "wins": 9, "losses": 3, "winRate": 0.75, "ciLower": 0.47, "ciUpper": 0.93 }
  ],
  "winRateByColor": [
    { "color": "WU", "wins": 5, "losses": 3, "winRate": 0.625, "ciLower": 0.29, "ciUpper": 0.88 },
    { "color": "BR", "wins": 4, "losses": 4, "winRate": 0.5, "ciLower": 0.22, "ciUpper": 0.78 },
    { "color": "UG", "wins": 6, "losses": 2, "winRate": 0.75, "ciLower": 0.41, "ciUpper": 0.95 }
  ],
  "ingestionHash": "e2e-test-hash-001"
}
```

- [ ] **Step 11: Commit all fixtures**

```bash
git add e2e/fixtures/
git commit -m "Add complete e2e fixture set for all test scenarios"
```

---

### Task 3: Create helper modules

**Files:**
- Modify: `e2e/helpers/mock-api.ts`
- Create: `e2e/helpers/auth.ts`
- Create: `e2e/helpers/assertions.ts`
- Modify: `e2e/helpers/card-table.ts`

- [ ] **Step 1: Rewrite mock-api.ts**

Read existing `e2e/helpers/mock-api.ts` first (it has the route-blocking patterns we want to keep). Then rewrite:

```typescript
import { Page } from "@playwright/test";
import cardsFixture from "../fixtures/cards-40.json" with { type: "json" };
import draftStatsFixture from "../fixtures/draft-stats.json" with { type: "json" };
import syncStatusFixture from "../fixtures/sync-status-active.json" with { type: "json" };
import draftsListFixture from "../fixtures/drafts-list.json" with { type: "json" };
import liveBoardFixture from "../fixtures/live-board.json" with { type: "json" };
import liveMeFixture from "../fixtures/live-me.json" with { type: "json" };
import liveQueueFixture from "../fixtures/live-queue.json" with { type: "json" };
import liveFloatsFixture from "../fixtures/live-floats.json" with { type: "json" };
import liveAvailableFixture from "../fixtures/live-available.json" with { type: "json" };
import deckStateFixture from "../fixtures/deck-state.json" with { type: "json" };
import sharedDeckFixture from "../fixtures/shared-deck.json" with { type: "json" };

export type Scenario =
  | "browse"
  | "live-draft"
  | "deck-builder"
  | "spectator"
  | "shared-deck";

export type MockOverrides = {
  cards?: (route: any, request: any) => Promise<void> | void;
  draftStats?: object;
  syncStatus?: object;
  liveBoard?: object;
  liveMe?: object;
  liveQueue?: object;
  liveFloats?: object;
  liveAvailable?: object;
  deckState?: object;
  sharedDeck?: object;
  pickResponse?: object;
  queuePutResponse?: object;
  floatPutResponse?: object;
  floatDeleteResponse?: object;
  deckStatePutResponse?: object;
  deckPostResponse?: object;
};

export async function createMockContext(
  page: Page,
  scenario: Scenario,
  overrides: MockOverrides = {}
) {
  // Block external images and analytics
  await page.route("**/cards.scryfall.io/**", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: Buffer.alloc(0) })
  );
  await page.route("**/_vercel/insights/**", (route) =>
    route.fulfill({ status: 200, body: "" })
  );

  // Base routes (all scenarios)
  if (overrides.cards) {
    await page.route("**/api/cards*", (route) =>
      overrides.cards!(route, route.request())
    );
  } else {
    await page.route("**/api/cards*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(cardsFixture) })
    );
  }

  await page.route("**/api/draft-stats*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.draftStats ?? draftStatsFixture),
    })
  );

  await page.route("**/api/sync-status*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.syncStatus ?? syncStatusFixture),
    })
  );

  await page.route("**/api/sync", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "no_change", picksInserted: 0 }),
    })
  );

  // Live draft routes
  if (["live-draft", "deck-builder", "spectator"].includes(scenario)) {
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveBoard ?? liveBoardFixture),
      })
    );
  }

  // Auth route (only for authenticated scenarios)
  if (["live-draft", "deck-builder"].includes(scenario)) {
    await page.route("**/api/drafts/*/me*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveMe ?? liveMeFixture),
      })
    );

    await page.route("**/api/drafts/*/queue*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.queuePutResponse ?? { queue: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveQueue ?? liveQueueFixture),
      });
    });

    await page.route("**/api/drafts/*/float*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.floatPutResponse ?? { ok: true }),
        });
      }
      if (route.request().method() === "DELETE") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.floatDeleteResponse ?? { ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveFloats ?? liveFloatsFixture),
      });
    });

    await page.route("**/api/drafts/*/pick*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.pickResponse ?? { ok: true }),
      })
    );

    await page.route("**/api/drafts/*/available*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.liveAvailable ?? liveAvailableFixture),
      })
    );

    await page.route("**/api/drafts/*/seat-settings*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      })
    );
  }

  // Deck state routes
  if (scenario === "deck-builder") {
    await page.route("**/api/drafts/*/deck-state*", (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(overrides.deckStatePutResponse ?? { ok: true }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.deckState ?? deckStateFixture),
      });
    });
  }

  // Shared deck routes
  await page.route("**/api/deck/*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(overrides.sharedDeck ?? sharedDeckFixture),
    })
  );

  await page.route("**/api/deck", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(overrides.deckPostResponse ?? { deckId: "test-deck-123" }),
      });
    }
    return route.fulfill({ status: 404 });
  });

  // Standings route
  await page.route("**/api/drafts/*/standings*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ standings: [] }),
    })
  );
}
```

**Important:** Check the actual route patterns in `e2e/helpers/mock-api.ts` before writing — the glob patterns (`**/api/cards*` vs `**/api/cards?*`) matter. The order of route registration also matters: more-specific routes must come before less-specific ones to avoid shadowing. Verify this by reading the Playwright docs on `page.route()` ordering if unsure.

- [ ] **Step 2: Create auth.ts**

```typescript
import { Page } from "@playwright/test";

export async function authenticateAs(
  page: Page,
  opts: { draftId: string; seat: number; displayName: string }
) {
  await page.addInitScript(
    ({ draftId, token }) => {
      localStorage.setItem(`seatToken:${draftId}`, token);
      localStorage.setItem("activeDraft", draftId);
    },
    { draftId: opts.draftId, token: "test-seat-token" }
  );
}
```

Note: The `/me` route is already mocked by `createMockContext` for `live-draft` and `deck-builder` scenarios. This helper just sets the localStorage token so the app reads it on load.

- [ ] **Step 3: Create assertions.ts**

```typescript
import { Page, expect } from "@playwright/test";

export async function expectCardTableToShow(page: Page, expectedCardNames: string[]) {
  for (const name of expectedCardNames) {
    await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  }
}

export async function expectCardTableCount(page: Page, count: number) {
  // Card table rows are in tbody; header is in thead
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(count);
}

export async function expectCardNotInTable(page: Page, cardName: string) {
  await expect(page.getByRole("row").filter({ hasText: cardName })).toHaveCount(0);
}

export async function expectPhase(page: Page, phase: string) {
  // Phase badge in draft board modal header
  await expect(page.getByText(phase, { exact: false })).toBeVisible();
}

export async function expectQueueContains(page: Page, cardName: string) {
  const queuePanel = page.locator("text=Pick Queue").locator("..");
  await expect(queuePanel.getByText(cardName)).toBeVisible();
}

export async function expectQueueDoesNotContain(page: Page, cardName: string) {
  const queuePanel = page.locator("text=Pick Queue").locator("..");
  await expect(queuePanel.getByText(cardName)).toHaveCount(0);
}

export async function openSettings(page: Page) {
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Settings").first()).toBeVisible();
}

export async function selectActiveDraft(page: Page, draftId: string) {
  await openSettings(page);
  await page.locator("select").first().selectOption(draftId);
}

export async function selectSeat(page: Page, seatNumber: number) {
  await page.locator("select").nth(1).selectOption(String(seatNumber));
}

export async function closeSettings(page: Page) {
  await page.getByLabel("Close").click();
}

export async function openDraftBoard(page: Page) {
  // aria-label is "Your Pick!" when isMyTurn, otherwise "Pod View — {draftId}"
  const button = page.getByLabel(/Pod View|Your Pick/);
  await button.click();
}

export async function openDeckBuilder(page: Page) {
  await page.getByLabel("Deck Builder").click();
}

export async function openCardStatsModal(page: Page, cardName: string) {
  // Click the card row in the card table
  await page.getByRole("row").filter({ hasText: cardName }).click();
  // Wait for modal to appear
  await expect(page.getByLabel("Close")).toBeVisible();
}
```

**Important notes on selectors:**
- Settings modal and CardStatsModal both use `aria-label="Close"` — scope close locators to their modal containers to avoid ambiguity.
- `getVisibleCardNames()` may return dirty strings like `"Lightning Bolt×2"` because `CardNameCell` renders badge spans (copy count, draft count) as siblings. The helper should extract only the card name span text, or tests should use `names.some(n => n.startsWith("Lightning Bolt"))` instead of exact equality.
- All JSON imports in TypeScript files must use `with { type: "json" }` — e.g., `import cardsFixture from "../fixtures/cards-40.json" with { type: "json" }`. The existing codebase requires this.
- Playwright `page.route()` callback receives a single `route` argument — access the request via `route.request()`, NOT as a second parameter. Correct: `(route) => { const req = route.request(); }`. Incorrect: `(route, request) => { ... }`.

- [ ] **Step 4: Update card-table.ts**

Read existing `e2e/helpers/card-table.ts`. Keep the existing helpers, ensure they work with the new fixture data:

```typescript
import { Page } from "@playwright/test";

export async function getVisibleCardNames(page: Page): Promise<string[]> {
  // Read card names from the visible table rows
  const rows = page.locator("tbody tr");
  const count = await rows.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await rows.nth(i).locator("td").first().textContent();
    if (text) names.push(text.trim());
  }
  return names;
}

export async function expectCardVisible(page: Page, cardName: string) {
  const rows = page.locator("tbody tr");
  await rows.filter({ hasText: cardName }).first().waitFor({ state: "visible" });
}

export async function expectCardNotVisible(page: Page, cardName: string) {
  const rows = page.locator("tbody tr").filter({ hasText: cardName });
  await rows.waitFor({ state: "hidden" }).catch(() => {
    // Card may not exist at all, which is fine
  });
}

export async function clickColumnHeader(page: Page, headerText: string) {
  await page.locator("thead th").filter({ hasText: headerText }).click();
}
```

**Important:** The existing card-table.ts may have a different selector strategy for extracting card names (e.g., using a specific class or data attribute). Read the actual file and preserve whatever works. The card name might not be in the first `td` — it depends on the column order. Verify by reading `CardTable.tsx` column definitions.

- [ ] **Step 5: Commit helpers**

```bash
git add e2e/helpers/
git commit -m "Rewrite e2e helpers: scenario-based mocking, auth, assertions"
```

---

### Task 4: Update SSR fixtures and config

**Files:**
- Modify: `e2e/fixtures/ssr-fixtures.ts`
- Modify: `e2e/playwright.config.ts`

- [ ] **Step 1: Update ssr-fixtures.ts**

Read existing `e2e/fixtures/ssr-fixtures.ts`. Change the import from `cards.json` to `cards-40.json`:

```typescript
import type { CardStatsResponse } from "@/core/getCards";
import type { DraftStatsResponse } from "@/core/getDraftStats";
import cardsFixture from "./cards-40.json";
import draftStatsFixture from "./draft-stats.json";

export const cards: CardStatsResponse = cardsFixture as CardStatsResponse;
export const draftStats: DraftStatsResponse =
  draftStatsFixture as DraftStatsResponse;
```

- [ ] **Step 2: Update playwright.config.ts**

Read existing `e2e/playwright.config.ts`. The `testDir` needs to find tests in `flows/` subdirectory. Playwright by default looks for `*.spec.ts` recursively in the testDir, so if `testDir` is already set to the `e2e/` directory (or the config is at `e2e/playwright.config.ts` with relative paths), tests in `e2e/flows/` should be found automatically.

Verify: check the current `testDir` setting. If it's `.` (relative to config location in `e2e/`), then `flows/*.spec.ts` will be found. If not, update it.

Also ensure `testMatch` (if set) includes `**/*.spec.ts` to recurse into subdirectories.

- [ ] **Step 3: Verify build works with new fixtures**

Run: `E2E_TEST=1 pnpm build 2>&1 | tail -20`

Expected: Build succeeds. The SSR path in `page.tsx` imports `ssr-fixtures.ts` which now loads `cards-40.json`. If the build fails, check TypeScript errors — the fixture JSON must match `CardStatsResponse` shape.

- [ ] **Step 4: Commit**

```bash
git add e2e/fixtures/ssr-fixtures.ts e2e/playwright.config.ts
git commit -m "Update SSR fixtures to use 40-card set, verify playwright config"
```

---

## Chunk 2: Browse and Spectator Test Flows

### Task 5: Write browse.spec.ts

**Files:**
- Create: `e2e/flows/browse.spec.ts`

**Reference:**
- `e2e/helpers/mock-api.ts` — `createMockContext("browse")`
- `e2e/helpers/card-table.ts` — `getVisibleCardNames()`, `clickColumnHeader()`
- `e2e/helpers/assertions.ts` — `expectCardTableCount()`, `openSettings()`, etc.
- `src/app/components/PageClient.tsx` — search input `#search`, color filter, settings
- `src/app/components/ColorFilter.tsx` — `button[aria-label="Filter by {color}"]`
- `src/app/components/Settings.tsx` — draft selector checkboxes

- [ ] **Step 1: Write browse.spec.ts with all 10 tests**

```typescript
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { getVisibleCardNames, clickColumnHeader } from "../helpers/card-table";
import { expectCardTableCount, openSettings } from "../helpers/assertions";
import cardsFixture from "../fixtures/cards-40.json";

test.describe("Browse and filter", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "browse");
    await page.goto("/");
    // Wait for card table to render
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("page loads with card table showing all cards", async ({ page }) => {
    await expectCardTableCount(page, cardsFixture.cards.length);
  });

  test("name search filters cards", async ({ page }) => {
    await page.fill("#search", "bolt");
    // Name search is synchronous (no debounce)
    const names = await getVisibleCardNames(page);
    expect(names).toContain("Lightning Bolt");
    expect(names.length).toBeLessThan(cardsFixture.cards.length);

    // Clear restores all
    await page.getByLabel("Clear search").click();
    await expectCardTableCount(page, cardsFixture.cards.length);
  });

  test("type search filters to creatures", async ({ page }) => {
    await page.fill("#search", "t:creature");
    // Type search is debounced (500ms)
    await page.waitForTimeout(600);
    const names = await getVisibleCardNames(page);
    // All visible cards should be creatures — verify at least one known creature
    expect(names).toContain("Tarmogoyf");
    // Non-creature should not be visible
    expect(names).not.toContain("Lightning Bolt");
  });

  test("oracle text search filters cards", async ({ page }) => {
    await page.fill("#search", 'o:"draw"');
    await page.waitForTimeout(600);
    const names = await getVisibleCardNames(page);
    // Brainstorm has "Draw three cards" in oracle text
    expect(names).toContain("Brainstorm");
    // Goblin Guide doesn't have "draw" in oracle text
    expect(names).not.toContain("Goblin Guide");
  });

  test("color filter pills filter cards", async ({ page }) => {
    // Click Red filter
    await page.getByLabel("Filter by Red").click();
    const redNames = await getVisibleCardNames(page);
    expect(redNames).toContain("Lightning Bolt");
    expect(redNames).not.toContain("Counterspell");

    // Click Blue filter too — should show Red OR Blue
    await page.getByLabel("Filter by Blue").click();
    const redBlueNames = await getVisibleCardNames(page);
    expect(redBlueNames).toContain("Lightning Bolt");
    expect(redBlueNames).toContain("Counterspell");
  });

  test("mana value search filters correctly", async ({ page }) => {
    await page.fill("#search", "mv<=1");
    await page.waitForTimeout(600);
    const names = await getVisibleCardNames(page);
    // MV 0-1 cards should be visible
    expect(names).toContain("Lightning Bolt");
    expect(names).toContain("Mana Crypt");
    // MV 2+ should not
    expect(names).not.toContain("Counterspell");
    expect(names).not.toContain("Tarmogoyf");
  });

  test("combined query filters correctly", async ({ page }) => {
    await page.fill("#search", "t:instant c:u");
    await page.waitForTimeout(600);
    const names = await getVisibleCardNames(page);
    // Blue instants only
    expect(names).toContain("Counterspell");
    expect(names).toContain("Brainstorm");
    // Red instant should not appear
    expect(names).not.toContain("Lightning Bolt");
    // Blue non-instant should not appear
    expect(names).not.toContain("Snapcaster Mage");
  });

  test("column sorting toggles order", async ({ page }) => {
    const namesBefore = await getVisibleCardNames(page);
    await clickColumnHeader(page, "P#");
    const namesAfter = await getVisibleCardNames(page);
    // At least the first card should differ after sort toggle
    expect(namesBefore[0]).not.toEqual(namesAfter[0]);
  });

  test("draft selection triggers card data refetch", async ({ page }) => {
    // Override cards mock to return different data per draft_ids param
    let lastRequestedDraftIds: string | null = null;
    await page.unroute("**/api/cards*");
    await page.route("**/api/cards*", (route) => {
      const url = new URL(route.request().url());
      lastRequestedDraftIds = url.searchParams.get("draft_ids");
      const subset = {
        ...cardsFixture,
        cards: cardsFixture.cards.slice(0, 20),
      };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(subset),
      });
    });

    // Open Settings and change the active draft.
    // Read Settings.tsx → DraftSelector component to find exact checkbox DOM.
    // DraftSelector renders checkboxes for each draft. Look for:
    // - Checkboxes inside the "Collect pick data from..." section
    // - Each checkbox labeled with draft name or has draft ID as value
    // The exact selectors must be verified by reading Settings.tsx and DraftSelector.tsx.
    await openSettings(page);
    // Example: click a draft checkbox to toggle it
    const draftCheckboxes = page.locator("input[type='checkbox']").filter({
      has: page.locator("..").filter({ hasText: /Delta|Epsilon/ }),
    });
    // Toggle a checkbox to trigger refetch
    await draftCheckboxes.first().click();
    await closeSettings(page);

    // Wait for refetch
    await page.waitForTimeout(1000);
    // Card count should have changed (we returned 20 instead of 40)
    await expectCardTableCount(page, 20);
  });

  test("empty state when no drafts selected", async ({ page }) => {
    // Override cards to return empty set when no drafts selected
    await page.unroute("**/api/cards*");
    await page.route("**/api/cards*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ...cardsFixture, cards: [] }),
      })
    );

    // Open Settings, find the "Collect pick data from..." section,
    // and uncheck all draft checkboxes. Read DraftSelector.tsx for exact DOM.
    await openSettings(page);
    // Look for "Select None" link/button if it exists, or uncheck each individually
    const selectNone = page.getByText(/Select None/i);
    if (await selectNone.isVisible()) {
      await selectNone.click();
    }
    await closeSettings(page);

    // Verify empty state — either no table rows or an empty message
    await page.waitForTimeout(1000);
    await expect(page.locator("tbody tr")).toHaveCount(0);
  });
});
```

**Important:** Tests 9 and 10 ("draft selection" and "empty state") have placeholder comments because the exact DraftSelector checkbox DOM structure needs to be verified during implementation. Read `src/app/components/Settings.tsx` and the `DraftSelector` component to find the correct selectors. The tests above show the intent and mock strategy — fill in the exact selectors after reading the components.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm test:e2e -- --grep "Browse and filter" 2>&1 | tail -30`

Expected: All 10 tests pass. If any fail, debug by adding `await page.pause()` and running with `--headed` to inspect the DOM.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows/browse.spec.ts
git commit -m "Add browse and filter e2e tests (10 tests)"
```

---

### Task 6: Write spectator.spec.ts

**Files:**
- Create: `e2e/flows/spectator.spec.ts`

**Reference:**
- `e2e/helpers/mock-api.ts` — `createMockContext("spectator")`
- `e2e/helpers/assertions.ts` — `openSettings()`, `selectActiveDraft()`, `selectSeat()`, `openDraftBoard()`, `openDeckBuilder()`
- `src/app/components/Settings.tsx` — draft select, seat select
- `src/app/components/draft-board/DraftBoardModal.tsx` — board matrix
- `src/app/components/deck-builder/DeckBuilderPanel.tsx` — deck zones
- `e2e/fixtures/live-board.json` — picks and seat data

- [ ] **Step 1: Write spectator.spec.ts with 4 tests**

```typescript
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { getVisibleCardNames } from "../helpers/card-table";
import {
  openSettings,
  selectSeat,
  closeSettings,
  openDraftBoard,
  openDeckBuilder,
} from "../helpers/assertions";
import liveBoardFixture from "../fixtures/live-board.json";

test.describe("Spectator viewing", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "spectator");
    await page.goto("/");
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("seat picks highlighted in card table", async ({ page }) => {
    await openSettings(page);
    // Select the active draft
    await page.locator("select").first().selectOption("gamma");
    // Select seat 1 (Bob) — who picked Sol Ring and Elspeth
    await selectSeat(page, 1);
    await closeSettings(page);

    // Seat 1's picks should be visually distinct in the card table
    // The card table shows taken cards with reduced opacity for other seats
    // and normal opacity for the selected seat's picks
    // Verify Sol Ring row is visible (it's a seat 1 pick)
    await expect(page.getByRole("row").filter({ hasText: "Sol Ring" })).toBeVisible();
  });

  test("seat deck in deck builder", async ({ page }) => {
    // Mock deck endpoint for seat 1
    await page.route("**/api/drafts/*/deck*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          draftId: "gamma",
          seat: 1,
          zones: { deck: { "W": ["Elspeth, Knight-Errant", "Mother of Runes"], "C": ["Sol Ring"] }, sideboard: { sb: [] } },
          basicLands: { Plains: 8, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
        }),
      })
    );

    await openSettings(page);
    await page.locator("select").first().selectOption("gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    await openDeckBuilder(page);
    // Verify deck builder shows seat 1's cards
    await expect(page.getByText("Sol Ring")).toBeVisible();
    await expect(page.getByText("Elspeth, Knight-Errant")).toBeVisible();
  });

  test("pod view shows full draft snapshot", async ({ page }) => {
    await openSettings(page);
    await page.locator("select").first().selectOption("gamma");
    await closeSettings(page);

    await openDraftBoard(page);
    // Verify board modal opens with pick data
    await expect(page.getByText("Gamma Draft")).toBeVisible();
    // Verify multiple seat names are visible
    await expect(page.getByText("Bob")).toBeVisible();
    await expect(page.getByText("Alice")).toBeVisible();
    // Verify picks are shown
    await expect(page.getByText("Sol Ring")).toBeVisible();
  });

  test("switch seats updates card table and deck builder", async ({ page }) => {
    await openSettings(page);
    await page.locator("select").first().selectOption("gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Note seat 1's state, then switch to seat 5
    await openSettings(page);
    await selectSeat(page, 5);
    await closeSettings(page);

    // Card table should now highlight seat 5's picks
    // Seat 5 picked Scalding Tarn and Liliana of the Veil
    await expect(page.getByRole("row").filter({ hasText: "Scalding Tarn" })).toBeVisible();
  });
});
```

**Important:** The exact mechanism for "highlighting" seat picks in the card table (opacity changes, background color, etc.) needs to be verified by reading `CardTable.tsx` and the card row rendering logic. The tests above assert visibility; you may need to check specific CSS classes or styles for the "selected seat" indicator.

- [ ] **Step 2: Run tests**

Run: `pnpm test:e2e -- --grep "Spectator" 2>&1 | tail -20`

Expected: All 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows/spectator.spec.ts
git commit -m "Add spectator e2e tests (4 tests)"
```

---

## Chunk 3: Live Draft Test Flow

### Task 7: Write live-draft.spec.ts

**Files:**
- Create: `e2e/flows/live-draft.spec.ts`

**Reference:**
- `e2e/helpers/mock-api.ts` — `createMockContext("live-draft")`
- `e2e/helpers/auth.ts` — `authenticateAs()`
- `src/app/components/PageClient.tsx` — Pod View button `aria-label` pattern, `animate-pulse` class
- `src/app/components/Settings.tsx` — auth badge with "Logged in to..."
- `src/app/components/draft-board/DraftBoardModal.tsx` — phase badge, close button
- `src/app/components/draft-board/DraftBoardCell.tsx` — empty cell click, PickAutocomplete
- `src/app/components/PickAutocomplete.tsx` — `input[role="combobox"]`, option items
- `src/app/components/CardStatsModal.tsx` — Queue/Float/Pick buttons, HoldToPickButton
- `src/app/hooks/useHoldToConfirm.ts` — 1500ms hold duration
- `src/app/components/draft-board/QueuePanel.tsx` — queue entries, auto-pick checkbox, mode toggle
- `e2e/fixtures/live-board.json` — board state, seat 3's turn
- `e2e/fixtures/live-queue.json` — queue entries
- `e2e/fixtures/live-floats.json` — floated cards

- [ ] **Step 1: Write live-draft.spec.ts with all 12 tests**

```typescript
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import {
  openSettings,
  selectSeat,
  closeSettings,
  openDraftBoard,
  openCardStatsModal,
  expectQueueContains,
  expectQueueDoesNotContain,
} from "../helpers/assertions";
import liveBoardFixture from "../fixtures/live-board.json";
import cardsFixture from "../fixtures/cards-40.json";

test.describe("Live draft", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "live-draft");
    await authenticateAs(page, { draftId: "gamma", seat: 3, displayName: "Alice" });
    await page.goto("/");
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("auth and turn detection", async ({ page }) => {
    // When isMyTurn, Pod View button aria-label becomes "Your Pick!"
    const podButton = page.getByLabel("Your Pick!");
    await expect(podButton).toBeVisible();
    // Button itself has animate-pulse class (not a child element)
    await expect(podButton).toHaveClass(/animate-pulse/);

    // Settings shows auth status
    await openSettings(page);
    await expect(page.getByText(/Logged in.*Gamma.*Alice/i)).toBeVisible();
    await closeSettings(page);
  });

  test("draft board opens with pick matrix", async ({ page }) => {
    await openDraftBoard(page);
    // Phase badge shows "drafting"
    await expect(page.getByText("drafting")).toBeVisible();
    // Board shows seat names
    await expect(page.getByText("Alice")).toBeVisible();
    await expect(page.getByText("Bob")).toBeVisible();
    // Close button works
    await page.getByLabel("Close draft board").click();
    await expect(page.getByText("drafting")).not.toBeVisible();
  });

  test("pick via autocomplete", async ({ page }) => {
    let pickRequestBody: any = null;
    await page.route("**/api/drafts/*/pick*", async (route) => {
      pickRequestBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await openDraftBoard(page);
    // Find the active cell — it has a dashed blue border (2px dashed #3b82f6)
    // Click it to enter edit mode. The active cell is the empty one in seat 3's column.
    const activeCell = page.locator("td").filter({
      has: page.locator("[style*='dashed']"),
    });
    await activeCell.first().click();

    // Autocomplete input should now be visible
    const autocomplete = page.locator("input[role='combobox']");
    await expect(autocomplete).toBeVisible();
    await autocomplete.fill("Doom");
    // Wait for options to appear
    await expect(page.locator("#pick-autocomplete-list")).toBeVisible();
    // Select "Doom Blade"
    await page.getByRole("option", { name: "Doom Blade" }).click();
    // Verify pick was submitted
    expect(pickRequestBody).toBeTruthy();
    expect(pickRequestBody.card_name).toBe("Doom Blade");
  });

  test("pick via card stats modal hold-to-confirm", async ({ page }) => {
    let pickRequestBody: any = null;
    await page.route("**/api/drafts/*/pick*", async (route) => {
      pickRequestBody = JSON.parse(route.request().postData() || "{}");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    // Click a card in the table to open stats modal
    await openCardStatsModal(page, "Doom Blade");

    // Hold the pick button for 1500ms
    const pickButton = page.getByLabel("Hold to pick this card");
    await pickButton.dispatchEvent("pointerdown");
    await page.waitForTimeout(1600);
    await pickButton.dispatchEvent("pointerup");

    // Verify pick was submitted
    expect(pickRequestBody).toBeTruthy();
    expect(pickRequestBody.card_name).toBe("Doom Blade");
  });

  test("board updates on poll", async ({ page }) => {
    let pollCount = 0;
    await page.unroute("**/api/drafts/*/live*");
    await page.route("**/api/drafts/*/live*", (route) => {
      pollCount++;
      const response =
        pollCount > 1
          ? {
              ...liveBoardFixture,
              latestPickN: 23,
              nextSeat: 4,
              picks: [
                ...liveBoardFixture.picks,
                {
                  pickN: 23,
                  seat: 3,
                  cardName: "Doom Blade",
                  oracleId: "doom-blade-id",
                  colorIdentity: ["B"],
                  manaCost: "{1}{B}",
                },
              ],
            }
          : liveBoardFixture;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    });

    await openDraftBoard(page);
    // Wait for a poll cycle (the app polls every ~10s, but we can wait for the updated data)
    await expect(page.getByText("Doom Blade")).toBeVisible({ timeout: 15000 });
  });

  test("queue from stats modal", async ({ page }) => {
    let queuePutBody: any = null;
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", async (route) => {
      if (route.request().method() === "PUT") {
        queuePutBody = JSON.parse(route.request().postData() || "{}");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: queuePutBody }),
        });
      }
      // GET: return current queue
      const { default: queueFixture } = await import("../fixtures/live-queue.json");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(queueFixture),
      });
    });

    // Open stats modal for an unqueued, unpicked card
    await openCardStatsModal(page, "Inferno Titan");
    // Click Queue button (use ^Queue$ to avoid matching "Unqueue")
    await page.getByRole("button", { name: /^Queue$/i }).click();
    // Verify PUT was called
    expect(queuePutBody).toBeTruthy();
  });

  test("unqueue from stats modal", async ({ page }) => {
    // Open stats modal for a queued card (Doom Blade is in the queue fixture)
    await openCardStatsModal(page, "Doom Blade");
    // Should show Unqueue button
    await expect(page.getByRole("button", { name: /Unqueue/i })).toBeVisible();
    await page.getByRole("button", { name: /Unqueue/i }).click();
  });

  test("float from stats modal", async ({ page }) => {
    let floatPutBody: any = null;
    await page.unroute("**/api/drafts/*/float*");
    await page.route("**/api/drafts/*/float*", async (route) => {
      if (route.request().method() === "PUT") {
        floatPutBody = JSON.parse(route.request().postData() || "{}");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      // GET: return floats
      const { default: floatsFixture } = await import("../fixtures/live-floats.json");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(floatsFixture),
      });
    });

    await openCardStatsModal(page, "Inferno Titan");
    // Use ^Float$ to avoid matching "Unfloat"
    await page.getByRole("button", { name: /^Float$/i }).click();
    expect(floatPutBody).toBeTruthy();
    expect(floatPutBody.card_name).toBe("Inferno Titan");
  });

  test("unfloat from stats modal", async ({ page }) => {
    // Phyrexian Arena is floated in fixture
    await openCardStatsModal(page, "Phyrexian Arena");
    await expect(page.getByRole("button", { name: /Unfloat/i })).toBeVisible();
    await page.getByRole("button", { name: /Unfloat/i }).click();
  });

  test("multi-copy queue: full availability", async ({ page }) => {
    // Lightning Bolt has 2 copies, neither publicly taken
    await openCardStatsModal(page, "Lightning Bolt");

    // Queue first copy
    await page.getByRole("button", { name: /Queue/i }).click();
    await page.getByLabel("Close").click();

    // Queue second copy — reopen modal
    await openCardStatsModal(page, "Lightning Bolt");
    // Should still show Queue button (can queue 2nd copy)
    await expect(page.getByRole("button", { name: /Queue/i })).toBeVisible();
    await page.getByRole("button", { name: /Queue/i }).click();
    await page.getByLabel("Close").click();

    // Attempt third copy — reopen modal
    await openCardStatsModal(page, "Lightning Bolt");
    // Queue button should be gone or disabled (max 2 copies)
    await expect(page.getByRole("button", { name: /^Queue$/i })).not.toBeVisible();
  });

  test("multi-copy queue: one publicly taken", async ({ page }) => {
    // Scalding Tarn has 2 copies, 1 picked by seat 5 (public)
    await openCardStatsModal(page, "Scalding Tarn");

    // Queue first copy (the only one remaining)
    await page.getByRole("button", { name: /Queue/i }).click();
    await page.getByLabel("Close").click();

    // Attempt second copy — should be unavailable
    await openCardStatsModal(page, "Scalding Tarn");
    await expect(page.getByRole("button", { name: /^Queue$/i })).not.toBeVisible();
  });

  test("phase transition hides queue panel", async ({ page }) => {
    await openDraftBoard(page);
    // Queue panel should be visible during drafting
    await expect(page.getByText("Pick Queue")).toBeVisible();

    // Update mock to return "playing" phase
    await page.unroute("**/api/drafts/*/live*");
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...liveBoardFixture,
          phase: "playing",
          nextSeat: null,
        }),
      })
    );

    // Wait for poll to pick up new phase
    await expect(page.getByText("playing")).toBeVisible({ timeout: 15000 });
    // Queue panel should be gone
    await expect(page.getByText("Pick Queue")).not.toBeVisible();
  });
});
```

**Implementation notes:**
- The hold-to-confirm test uses `dispatchEvent("pointerdown")` then waits 1600ms. Verify this triggers the `useHoldToConfirm` hook. If not, try `page.mouse.down()` on the button's bounding box instead.
- The autocomplete test needs to find the correct editable cell. Read `DraftBoardMatrix.tsx` to understand which cell is the active/editable one for seat 3's next pick. The cell may need to be clicked first to enter edit mode.
- Multi-copy queue tests depend on the UI correctly counting queued vs available copies. The queue mock needs to track state across PUT calls within the test. The implementation above is simplified — during implementation, you may need to intercept PUT requests and update the queue state dynamically.
- The `openCardStatsModal` helper clicks a card table row. Verify that this opens the stats modal (some implementations require clicking the card name specifically, not the row).

- [ ] **Step 2: Run tests**

Run: `pnpm test:e2e -- --grep "Live draft" 2>&1 | tail -30`

Expected: All 12 tests pass. Multi-copy and polling tests may need timeout adjustments.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows/live-draft.spec.ts
git commit -m "Add live draft e2e tests (12 tests)"
```

---

## Chunk 4: Deck Builder and Shared Deck Test Flows

### Task 8: Write deck-builder.spec.ts

**Files:**
- Create: `e2e/flows/deck-builder.spec.ts`

**Reference:**
- `e2e/helpers/mock-api.ts` — `createMockContext("deck-builder")`
- `e2e/helpers/auth.ts` — `authenticateAs()`
- `src/app/components/deck-builder/DeckBuilderPanel.tsx` — header, buttons, zones
- `src/app/components/deck-builder/DeckCard.tsx` — queue toggle `aria-label="Add to queue"/"Remove from queue"`, float remove `aria-label="Remove speculative card"`
- `e2e/fixtures/deck-state.json` — seat 3's deck (Brainstorm, Cryptic Command, Phyrexian Arena, Growth Spiral)
- `e2e/fixtures/live-floats.json` — floated cards (Phyrexian Arena, Growth Spiral)

- [ ] **Step 1: Write deck-builder.spec.ts with all 9 tests**

```typescript
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import { authenticateAs } from "../helpers/auth";
import {
  openSettings,
  selectSeat,
  closeSettings,
  openDeckBuilder,
} from "../helpers/assertions";

test.describe("Deck builder", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "deck-builder");
    await authenticateAs(page, { draftId: "gamma", seat: 3, displayName: "Alice" });
    await page.goto("/");
    await expect(page.locator("tbody tr").first()).toBeVisible();
  });

  test("opens on active draft with correct header", async ({ page }) => {
    await openDeckBuilder(page);
    // Draft name and seat displayed
    await expect(page.getByText("Gamma Draft")).toBeVisible();
    await expect(page.getByText(/Seat 3|Alice/)).toBeVisible();
  });

  test("loads saved deck state", async ({ page }) => {
    await openDeckBuilder(page);
    // Cards from deck-state fixture should be visible
    await expect(page.getByText("Brainstorm")).toBeVisible();
    await expect(page.getByText("Cryptic Command")).toBeVisible();
    // Floated cards also appear in deck
    await expect(page.getByText("Phyrexian Arena")).toBeVisible();
    await expect(page.getByText("Growth Spiral")).toBeVisible();
  });

  test("move card between zones", async ({ page }) => {
    await openDeckBuilder(page);
    // dnd-kit drag-and-drop: use Playwright's dragTo() which dispatches pointer events.
    // Read DeckZone.tsx and DeckCard.tsx during implementation to find exact drop targets.
    // The deck zone has droppable columns; sideboard has a droppable "sb" column.
    const card = page.getByText("Brainstorm").first();
    const sideboardZone = page.getByText("Sideboard").locator("..").locator("[data-droppable]").first();
    // If data-droppable doesn't exist, find the sideboard drop target by other means.
    // Fallback: use the sideboard heading's parent container as drop target.
    await card.dragTo(sideboardZone);
    // Verify card moved — Brainstorm should appear under sideboard section.
    // Implementation note: if dragTo doesn't work with dnd-kit (common issue),
    // try keyboard approach: focus card, Space to pick up, Tab to move focus, Space to drop.
    // Or check if there's a programmatic way to move cards (e.g., double-click moves to other zone).
  });

  test("promote floated card to queued from deck builder", async ({ page }) => {
    let queuePutCalled = false;
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", async (route) => {
      if (route.request().method() === "PUT") {
        queuePutCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: [] }),
        });
      }
      const { default: queueFixture } = await import("../fixtures/live-queue.json");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(queueFixture),
      });
    });

    await openDeckBuilder(page);
    // Phyrexian Arena is floated — find its queue toggle button
    // DeckCard has: aria-label="Add to queue" (top-left button, visible on hover)
    const phyrexianCard = page.getByText("Phyrexian Arena").first();
    await phyrexianCard.hover();
    await page.getByLabel("Add to queue").first().click();
    // Verify queue PUT was called
    expect(queuePutCalled).toBe(true);
  });

  test("demote queued card to floated from deck builder", async ({ page }) => {
    // First we need a card that's both queued and floated in the deck builder
    // Modify queue fixture to include Phyrexian Arena (which is also floated)
    await page.unroute("**/api/drafts/*/queue*");
    await page.route("**/api/drafts/*/queue*", async (route) => {
      if (route.request().method() === "PUT") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ queue: [] }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          queue: [
            { mode: "pause", cards: [{ id: 10, name: "Phyrexian Arena" }] },
          ],
        }),
      });
    });

    await openDeckBuilder(page);
    // Phyrexian Arena should show the queued state (amber button visible)
    const phyrexianCard = page.getByText("Phyrexian Arena").first();
    await phyrexianCard.hover();
    // aria-label="Remove from queue" — the button should be visible for queued cards
    await page.getByLabel("Remove from queue").first().click();
    // Card should still be in deck builder (demoted to float, not removed)
    await expect(page.getByText("Phyrexian Arena")).toBeVisible();
  });

  test("add basic lands", async ({ page }) => {
    await openDeckBuilder(page);
    await page.getByText("Add Basic Lands").click();
    // BasicLandsDialog uses +/- buttons per land type, not text inputs
    // Read BasicLandsDialog component for exact DOM structure.
    // Typical pattern: find the row containing "Plains", click its "+" button twice.
    const plainsRow = page.locator("div").filter({ hasText: /Plains/ }).first();
    // Click + button twice to add 2 Plains
    const plusButton = plainsRow.getByText("+");
    await plusButton.click();
    await plusButton.click();
    // Save/confirm the dialog
    await page.getByRole("button", { name: /Save|Done|OK/i }).click();
    // Verify basic land count updated in deck header or zone
  });

  test("clear deck", async ({ page }) => {
    await openDeckBuilder(page);
    await page.getByText("Clear Deck").click();
    // All cards should be removed
    await expect(page.getByText("Brainstorm")).not.toBeVisible();
    await expect(page.getByText("Cryptic Command")).not.toBeVisible();
  });

  test("share deck creates snapshot", async ({ page }) => {
    let deckPostCalled = false;
    await page.unroute("**/api/deck");
    await page.route("**/api/deck", async (route) => {
      if (route.request().method() === "POST") {
        deckPostCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ deckId: "test-deck-123" }),
        });
      }
      return route.fulfill({ status: 404 });
    });

    await openDeckBuilder(page);
    await page.getByText("Share Deck").click();
    // Verify POST was made
    expect(deckPostCalled).toBe(true);
    // Button should change to "Copied!" momentarily
    await expect(page.getByText("Copied!")).toBeVisible();
  });

  test("save persistence fires PUT on change", async ({ page }) => {
    let deckStatePutCalled = false;
    await page.unroute("**/api/drafts/*/deck-state*");
    await page.route("**/api/drafts/*/deck-state*", async (route) => {
      if (route.request().method() === "PUT") {
        deckStatePutCalled = true;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      }
      const { default: deckFixture } = await import("../fixtures/deck-state.json");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(deckFixture),
      });
    });

    await openDeckBuilder(page);
    // Trigger a change — clear deck should trigger a save
    await page.getByText("Clear Deck").click();
    // Wait for debounced save
    await page.waitForTimeout(2000);
    expect(deckStatePutCalled).toBe(true);
  });
});
```

**Implementation notes:**
- The "move card between zones" test uses drag-and-drop which is notoriously tricky in Playwright with dnd-kit. Read the dnd-kit accessibility docs — it may support keyboard interactions (Space to pick up, arrow keys to move, Space to drop) which are more reliable in tests. If drag doesn't work, check if there's a right-click context menu or other mechanism.
- The "add basic lands" test needs to read the `BasicLandsDialog` component (or similar) to find the exact DOM structure. This is a dialog that opens from the button — it may use `<dialog>`, a modal div, or a popover.
- DeckCard hover buttons (`aria-label="Add to queue"`, `aria-label="Remove from queue"`, `aria-label="Remove speculative card"`) only appear on hover (`opacity-0 group-hover/card:opacity-100`). The test needs `hover()` before clicking.

- [ ] **Step 2: Run tests**

Run: `pnpm test:e2e -- --grep "Deck builder" 2>&1 | tail -30`

Expected: All 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows/deck-builder.spec.ts
git commit -m "Add deck builder e2e tests (9 tests)"
```

---

### Task 9: Write shared-deck.spec.ts

**Files:**
- Create: `e2e/flows/shared-deck.spec.ts`

**Reference:**
- `e2e/helpers/mock-api.ts` — `createMockContext("shared-deck")`
- `e2e/fixtures/shared-deck.json` — deck snapshot (delta draft, seat 5)
- `src/app/components/deck-builder/DeckBuilderPanel.tsx` — header with draft name and seat
- `src/app/components/CardStatsModal.tsx` — modal opens on card click

- [ ] **Step 1: Write shared-deck.spec.ts with 3 tests**

```typescript
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";

test.describe("Shared deck", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "shared-deck");
  });

  test("loads shared deck from URL parameter", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    // Deck builder should open automatically
    await expect(page.getByText("Share Deck")).toBeVisible();
    // Cards from shared-deck fixture should appear
    await expect(page.getByText("Swords to Plowshares")).toBeVisible();
    await expect(page.getByText("Sol Ring")).toBeVisible();
  });

  test("shows source draft and seat info", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    // Header should show the sharer's draft and seat
    await expect(page.getByText("Delta Draft")).toBeVisible();
    await expect(page.getByText(/Seat 5/)).toBeVisible();
  });

  test("card stats modal opens from shared deck", async ({ page }) => {
    await page.goto("/?deck=test-deck-123");
    // Click a card in the deck builder
    await page.getByText("Lightning Bolt").first().click();
    // Stats modal should open
    await expect(page.getByLabel("Close")).toBeVisible();
    // Modal should show card data
    await expect(page.getByText("Pick Score")).toBeVisible();
  });
});
```

**Implementation note:** The shared deck URL parameter is `?deck=<id>`. The app reads this, fetches `GET /api/deck/<id>`, and opens the deck builder with the snapshot. The mock for this route is set up by `createMockContext("shared-deck")` which returns `shared-deck.json`. The draft name display depends on the `draftMetadata` in the cards fixture including the `delta` draft.

- [ ] **Step 2: Run tests**

Run: `pnpm test:e2e -- --grep "Shared deck" 2>&1 | tail -20`

Expected: All 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/flows/shared-deck.spec.ts
git commit -m "Add shared deck e2e tests (3 tests)"
```

---

## Chunk 5: Cleanup and Final Verification

### Task 10: Delete old tests and verify full suite

**Files:**
- Delete: `e2e/browse-and-filter.spec.ts`
- Delete: `e2e/deck-builder.spec.ts`
- Delete: `e2e/queue-panel.spec.ts`
- Delete: `e2e/active-draft-sync.spec.ts`
- Delete: `e2e/fixtures/cards.json`

- [ ] **Step 1: Delete old test files**

```bash
rm e2e/browse-and-filter.spec.ts e2e/deck-builder.spec.ts e2e/queue-panel.spec.ts e2e/active-draft-sync.spec.ts
rm e2e/fixtures/cards.json
```

- [ ] **Step 2: Run full e2e suite**

Run: `pnpm test:e2e 2>&1`

Expected: All ~38 tests pass. No old tests remain.

- [ ] **Step 3: Run precommit checks**

Run: `pnpm precommit 2>&1 | tail -20`

Expected: typecheck, lint, knip, unit tests, and e2e all pass. Knip may flag the deleted `cards.json` if something still imports it — fix any remaining references.

- [ ] **Step 4: Commit cleanup**

```bash
git add -A
git commit -m "Remove old e2e tests, complete test suite migration"
```

- [ ] **Step 5: Verify test independence**

Run each spec file in isolation to confirm no cross-file dependencies:

```bash
pnpm test:e2e -- e2e/flows/browse.spec.ts
pnpm test:e2e -- e2e/flows/spectator.spec.ts
pnpm test:e2e -- e2e/flows/live-draft.spec.ts
pnpm test:e2e -- e2e/flows/deck-builder.spec.ts
pnpm test:e2e -- e2e/flows/shared-deck.spec.ts
```

Expected: Each passes independently.

- [ ] **Step 6: Final commit**

If any fixes were needed from steps 2-5:

```bash
git add -A
git commit -m "Fix e2e test issues found during verification"
```
