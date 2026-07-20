# Sheet-Draft Pick Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When sheet-sync picks arrive, reconcile locally-added deck-builder cards ("floats"): a pick by the viewed seat upgrades the card from floated to real; another seat taking the last copy removes it from the deck builder.

**Architecture:** One new liveStore action, `reconcileLocalFloats` (in `src/app/stores/live/queueFloat.ts`), filters `floatedCards` against cardStore's derived pick data — `seatCardNames` (the viewed seat's picks) and `takenCardNamesSet` (cards whose copies are ALL taken; already multi-copy aware) — and persists the result via `saveLocalFloats`. It is triggered from (a) the existing `seatCardList` cardStore subscription in `liveStore.ts`, which fires on every pick-driven recompute, and (b) the end of the local-mode branch of `fetchFloatedCards`, so floats that went stale while the tab was closed are cleaned on load. No new UI: removing a float entry makes the existing `floatedCards → debouncedSyncDeckWithPicks → REBUILD` chain prune the card from deck zones (removal case) or simply stop dimming it (upgrade case, since the card remains canonical via picks). This mirrors live-draft server behavior, where `processPick` calls `removeFloatedCardByCardId` only when the last copy is picked.

**Tech Stack:** TypeScript, Next.js, Zustand (`subscribeWithSelector`), Vitest (jsdom), Playwright.

## Global Constraints

- Always use `git -C /Users/arpanet/dev/read-the-bones ...` for git commands — never `cd`.
- `pnpm lint` runs with `--max-warnings 0`; keep code warning-free.
- Comments sparingly — only for unintuitive behavior; never PR-context comments.
- Commit messages: why-focused, 1–2 sentences, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Don't add features beyond this spec (no queue changes, no stale-key cleanup, no server writes for sheet drafts).

## Background for implementers

**Local deck mode** = active draft is a sheet draft (`board.isSheetDraft`) AND a seat is selected. Sheet drafts have no seat tokens; "Add to Deck Builder" cards live in the `floatedCards` liveStore slice, persisted to `localStorage` key `localFloats:<draftId>:<seat>` (see `src/app/stores/live/localDeck.ts`).

**How picks arrive:** the client polls `/api/drafts/[id]/live` every 10s. New picks bump `draftStore.pickVersion`, which makes `cardStore` recompute derived state — including `seatCardNames: Set<string> | undefined` (names picked by the selected seat) and `takenCardNamesSet: Set<string> | undefined` (names where picked count ≥ cube copies). Every recompute creates fresh references, so the existing `useCardStore.subscribe((s) => s.seatCardList, ...)` subscription in `liveStore.ts` fires after each recompute.

**Why removal needs no zone surgery:** `deckReducer`'s `REBUILD` (in `src/core/deckBuilder.ts`) keeps only canonical cards (picks + floats via `computeMyDeckCardNames`) and preserves the arrangement of kept cards. Dropping a name from `floatedCards` removes it from the canonical set (removal case) — REBUILD prunes it. If the viewed seat picked the card, it stays canonical through picks — REBUILD keeps it in place, and `DeckZone`'s float styling (dimming + "Remove speculative card" ✕ button) disappears because the name is no longer in `floatedCards`.

---

### Task 1: `reconcileLocalFloats` action

**Files:**
- Modify: `src/app/stores/live/queueFloat.ts` (new factory at end of file; extend imports)
- Modify: `src/app/stores/liveStore.ts:110` (interface), `:207` (action registration), and its `./live/queueFloat` import list
- Test: `src/app/stores/liveStore.test.ts` (new describe block after "local deck mode — floats", ~line 1393)

**Interfaces:**
- Consumes: `getLocalDeckMode()`, `saveLocalFloats(draftId, seat, floats)` from `./localDeck`; `useCardStore.getState().seatCardNames` / `.takenCardNamesSet`; liveStore state `floatedCards`, `viewingSharedDeck`.
- Produces: `reconcileLocalFloats: () => void` on `LiveStoreState` — Tasks 2 and 3 call exactly this action. Factory export: `makeReconcileLocalFloats(set: SetState, get: GetState)`.

- [ ] **Step 1: Write the failing tests**

In `src/app/stores/liveStore.test.ts`, after the `"local deck mode — floats"` describe block (ends ~line 1393), add:

```ts
// ---------------------------------------------------------------------------
// local deck mode — pick reconciliation
// ---------------------------------------------------------------------------
describe("local deck mode — reconcileLocalFloats", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    useCardStore.setState({ seatCardNames: undefined, takenCardNamesSet: undefined });
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops a float when the viewed seat has picked the card", async () => {
    await useLiveStore.getState().addFloat("Sylvan Library");
    await useLiveStore.getState().addFloat("Land Tax");
    useCardStore.setState({
      seatCardNames: new Set(["Sylvan Library"]),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(useLiveStore.getState().floatedCardsSet.has("Sylvan Library")).toBe(false);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });

  it("drops a float when another seat takes the last copy", async () => {
    await useLiveStore.getState().addFloat("Land Tax");
    useCardStore.setState({
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Land Tax"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
  });

  it("keeps a float while copies of the card remain available", async () => {
    await useLiveStore.getState().addFloat("Doom Blade");
    // Another seat picked one of two copies — takenCardNamesSet only lists
    // fully-taken cards, so the float must survive.
    useCardStore.setState({
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Some Other Card"]),
    });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Doom Blade"]);
  });

  it("is a no-op outside local deck mode", () => {
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    useLiveStore.setState({ floatedCards: ["Land Tax"], floatedCardsSet: new Set(["Land Tax"]) });
    useCardStore.setState({ takenCardNamesSet: new Set(["Land Tax"]) });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });

  it("is a no-op while viewing a shared deck", () => {
    useLiveStore.setState({
      viewingSharedDeck: true,
      floatedCards: ["Land Tax"],
      floatedCardsSet: new Set(["Land Tax"]),
    });
    useCardStore.setState({ takenCardNamesSet: new Set(["Land Tax"]) });

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });

  it("is a no-op before card data is derived", async () => {
    await useLiveStore.getState().addFloat("Land Tax");

    useLiveStore.getState().reconcileLocalFloats();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: FAIL — `reconcileLocalFloats is not a function` (the action does not exist yet). Pre-existing tests must still pass.

- [ ] **Step 3: Implement the action**

In `src/app/stores/live/queueFloat.ts`, add to the imports at the top:

```ts
import { useCardStore } from "../cardStore";
```

(`useDraftStore` and the `localDeck` helpers are already imported.) Then add at the end of the file:

```ts
// ---------------------------------------------------------------------------
// reconcileLocalFloats — drop floats superseded by synced picks (local mode)
// ---------------------------------------------------------------------------

/**
 * Local-mode analog of the server's pick-time float cleanup (processPick →
 * removeFloatedCardByCardId): once a floated card is picked by the viewed seat
 * it is a real pick (the float entry only kept it dimmed), and once every copy
 * is taken by other seats it can never be picked. Both cases remove the float;
 * takenCardNamesSet only contains fully-taken names, so a card with copies
 * still available keeps its float.
 */
export function makeReconcileLocalFloats(set: SetState, get: GetState) {
  return (): void => {
    if (get().viewingSharedDeck) return;
    if (!getLocalDeckMode()) return;
    const { activeDraft, selectedSeat } = useDraftStore.getState();
    if (!activeDraft || selectedSeat === null) return;
    const { seatCardNames, takenCardNamesSet } = useCardStore.getState();
    if (!seatCardNames && !takenCardNamesSet) return;

    const previous = get().floatedCards;
    const next = previous.filter(
      (name) => !seatCardNames?.has(name) && !takenCardNamesSet?.has(name),
    );
    if (next.length === previous.length) return;

    set({ floatedCards: next, floatedCardsSet: new Set(next) });
    saveLocalFloats(activeDraft, selectedSeat, next);
  };
}
```

In `src/app/stores/liveStore.ts`:

1. Add `makeReconcileLocalFloats` to the existing `./live/queueFloat` import list.
2. In `interface LiveStoreState`, after `removeFloat: (cardName: string) => Promise<void>;` (line 110), add:

```ts
  reconcileLocalFloats: () => void;
```

3. In the store creator's "Float actions" section, after `removeFloat: makeRemoveFloat(boundSet, get, getLiveStoreRef),` (line 207), add:

```ts
      reconcileLocalFloats: makeReconcileLocalFloats(boundSet, get),
```

4. In the test-reset block of `liveStore.test.ts`'s `resetStores` there is nothing to add — the action is stateless.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: PASS (all, including the 6 new tests).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — expected: no errors.

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/live/queueFloat.ts src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Add reconcileLocalFloats: local-mode analog of server pick-time float cleanup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Trigger reconciliation when picks arrive

**Files:**
- Modify: `src/app/stores/liveStore.ts:376-380` (the `seatCardList` subscription)
- Test: `src/app/stores/liveStore.test.ts` (extend the describe added in Task 1)

**Interfaces:**
- Consumes: `useLiveStore.getState().reconcileLocalFloats()` from Task 1; existing `debouncedSyncDeckWithPicks`.
- Produces: no new API — behavior only (pick arrival → floats reconciled → deck rebuilt).

- [ ] **Step 1: Write the failing tests**

Append inside the `"local deck mode — reconcileLocalFloats"` describe block from Task 1 (fake timers are needed here to flush the 50ms deck-sync debounce and are enabled per-test, matching the file's local-mode precedent):

```ts
  it("upgrades a floated card to a real pick when the viewed seat picks it", async () => {
    vi.useFakeTimers();
    useCardStore.setState({ seatCardList: [], scryfallDataMap: new Map() });
    await useLiveStore.getState().fetchDeckState();
    useLiveStore.getState().setDeckBuilderActive(true);
    await useLiveStore.getState().addFloat("Sylvan Library");
    await vi.advanceTimersByTimeAsync(100);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");

    // A synced pick lands: the viewed seat took the card (cardStore recompute
    // fires the seatCardList subscription with fresh references).
    useCardStore.setState({
      seatCardList: ["Sylvan Library"],
      seatCardNames: new Set(["Sylvan Library"]),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
    vi.useRealTimers();
  });

  it("removes a floated card from the deck when another seat takes the last copy", async () => {
    vi.useFakeTimers();
    useCardStore.setState({ seatCardList: [], scryfallDataMap: new Map() });
    await useLiveStore.getState().fetchDeckState();
    useLiveStore.getState().setDeckBuilderActive(true);
    await useLiveStore.getState().addFloat("Sylvan Library");
    await vi.advanceTimersByTimeAsync(100);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toContain("Sylvan Library");

    useCardStore.setState({
      seatCardList: [],
      seatCardNames: new Set(),
      takenCardNamesSet: new Set(["Sylvan Library"]),
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"] ?? []).not.toContain("Sylvan Library");
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual([]);
    vi.useRealTimers();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: the two new tests FAIL — `floatedCards` still contains `"Sylvan Library"` after the pick lands (nothing calls `reconcileLocalFloats` yet). If instead the first assertion (`toContain` after addFloat) fails, the test setup is wrong — fix that before touching the implementation.

- [ ] **Step 3: Wire the subscription**

In `src/app/stores/liveStore.ts`, replace the existing subscription (lines 376–380):

```ts
// Sync deck with picks when card data changes
useCardStore.subscribe(
  (state) => state.seatCardList,
  () => debouncedSyncDeckWithPicks(),
);
```

with:

```ts
// Sync deck with picks when card data changes. In local deck mode a synced
// pick can supersede a locally-added float (viewed seat picked it, or another
// seat took the last copy) — reconcile before the deck rebuild.
useCardStore.subscribe(
  (state) => state.seatCardList,
  () => {
    useLiveStore.getState().reconcileLocalFloats();
    debouncedSyncDeckWithPicks();
  },
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: PASS. Also run the full suite: `pnpm test` — expected: PASS (the wiring change fires for live drafts too, where `getLocalDeckMode()` is false and the action is a guarded no-op).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Reconcile local floats on every synced pick so picked cards upgrade or leave the deck

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Reconcile stale floats on load

Floats picked while the tab was closed must not resurface: the local branch of `fetchFloatedCards` loads straight from localStorage, so reconcile right after loading.

**Files:**
- Modify: `src/app/stores/live/queueFloat.ts` (local-mode branch of `makeFetchFloatedCards`, ~lines 284–297)
- Test: `src/app/stores/liveStore.test.ts` (extend the describe added in Task 1)

**Interfaces:**
- Consumes: `get().reconcileLocalFloats()` (Task 1 put it on `LiveStoreState`, so it is reachable through the factory's existing `get`).
- Produces: no new API — behavior only.

- [ ] **Step 1: Write the failing test**

Append inside the `"local deck mode — reconcileLocalFloats"` describe block:

```ts
  it("fetchFloatedCards reconciles floats that were picked while the tab was closed", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade", "Land Tax"]));
    useCardStore.setState({
      seatCardNames: new Set(["Doom Blade"]),
      takenCardNamesSet: new Set(["Doom Blade"]),
    });

    await useLiveStore.getState().fetchFloatedCards();

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: the new test FAILS — `floatedCards` is `["Doom Blade", "Land Tax"]` (loaded verbatim, never reconciled).

- [ ] **Step 3: Implement**

In `src/app/stores/live/queueFloat.ts`, inside `makeFetchFloatedCards`, the local-mode branch currently ends:

```ts
      if (floatsChanged) {
        set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
      }
      return;
```

Change it to:

```ts
      if (floatsChanged) {
        set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
      }
      // Stored floats may have been superseded by picks synced while this
      // tab was closed — reconcile immediately after loading.
      get().reconcileLocalFloats();
      return;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: PASS, including all pre-existing `fetchFloatedCards` and wiring tests (the reconcile is a guarded no-op when card data isn't derived yet, which the Task 1 "no-op before card data is derived" test pins).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/live/queueFloat.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Reconcile stored local floats at load time so picks made while away are honored

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end coverage and docs

**Files:**
- Modify: `e2e/flows/sheet-draft-deck-builder.spec.ts` (two new tests)
- Modify: `docs/superpowers/specs/2026-07-19-sheet-draft-deck-builder-design.md` (§3 note)
- Modify: `CLAUDE.md` (Superpowers Plans index)

**Interfaces:**
- Consumes: the mock context `createMockContext(page, "sheet-draft")` routes `**/api/drafts/*/live*` with `live-board.json` + `isSheetDraft: true`. Re-registering `page.route` for the same pattern inside a test takes precedence (Playwright uses last-registered-wins), so the next 10s poll delivers the updated board. Floated deck cards carry an ✕ button with `aria-label="Remove speculative card"` (`DeckCard.tsx`), which is the styling signal to assert on.
- Produces: nothing downstream.

- [ ] **Step 1: Write the e2e tests**

In `e2e/flows/sheet-draft-deck-builder.spec.ts`, add the fixture import at the top (matching `mock-api.ts` style):

```ts
import liveBoardFixture from "../fixtures/live-board.json" with { type: "json" };
```

Then add inside the existing `test.describe`:

```ts
  test("a pick by the viewed seat upgrades the added card to a real pick", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    await expect(async () => {
      await page.locator("tbody tr").filter({ hasText: "Sylvan Library" }).first().click();
      await expect(page.getByRole("button", { name: "Add to Deck Builder" })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await page.getByRole("button", { name: "Add to Deck Builder" }).click();
    await expect(page.getByRole("button", { name: "Remove from Deck Builder" })).toBeVisible();
    await page.keyboard.press("Escape");

    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible({ timeout: 10000 });
    // While floated, the card carries the speculative ✕ control.
    await expect(page.getByRole("button", { name: "Remove speculative card" })).toHaveCount(1);

    // Subsequent polls report that seat 1 — the viewed seat — picked the card.
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...liveBoardFixture,
          isSheetDraft: true,
          latestPickN: 23,
          picks: [
            ...liveBoardFixture.picks,
            { pickN: 23, seat: 1, cardName: "Sylvan Library", oracleId: "sylvan-library-id", colorIdentity: ["G"], manaCost: "{1}{G}" },
          ],
        }),
      }),
    );

    // Poll interval is 10s: after the next poll the card must remain in the
    // deck as a real pick — no speculative ✕ — and the stored float clears.
    await expect(page.getByRole("button", { name: "Remove speculative card" })).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible();
    const floats = await page.evaluate(() => localStorage.getItem("localFloats:gamma:1"));
    expect(floats).toBe("[]");
  });

  test("a pick by another seat removes the added card from the deck builder", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    await expect(async () => {
      await page.locator("tbody tr").filter({ hasText: "Sylvan Library" }).first().click();
      await expect(page.getByRole("button", { name: "Add to Deck Builder" })).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 10000 });
    await page.getByRole("button", { name: "Add to Deck Builder" }).click();
    await expect(page.getByRole("button", { name: "Remove from Deck Builder" })).toBeVisible();
    await page.keyboard.press("Escape");

    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible({ timeout: 10000 });

    // Subsequent polls report that seat 2 took the (only) copy.
    await page.route("**/api/drafts/*/live*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...liveBoardFixture,
          isSheetDraft: true,
          latestPickN: 23,
          picks: [
            ...liveBoardFixture.picks,
            { pickN: 23, seat: 2, cardName: "Sylvan Library", oracleId: "sylvan-library-id", colorIdentity: ["G"], manaCost: "{1}{G}" },
          ],
        }),
      }),
    );

    await expect(page.getByRole("button", { name: "Sylvan Library" })).toHaveCount(0, { timeout: 15000 });
    const floats = await page.evaluate(() => localStorage.getItem("localFloats:gamma:1"));
    expect(floats).toBe("[]");
  });
```

- [ ] **Step 2: Run the e2e spec**

Run: `pnpm test:e2e e2e/flows/sheet-draft-deck-builder.spec.ts`
(Requires chromium: `npx playwright install chromium` if missing.)
Expected: PASS — all four tests in the file (two pre-existing, two new). If `Sylvan Library` turns out to be already picked in `e2e/fixtures/live-board.json` or absent from `e2e/fixtures/cards-40.json`, pick a different card that the existing "add a card" test proves is addable — but do not change the fixtures.

- [ ] **Step 3: Update docs**

In `docs/superpowers/specs/2026-07-19-sheet-draft-deck-builder-design.md`, §3 ends with the sentence about dedup ("Existing dedup against picks means a locally-added card that the seat later actually picks (via sheet sync) simply becomes a real pick — no duplicate."). Append after that sentence:

```markdown
Synced picks additionally reconcile the float list itself
(`reconcileLocalFloats`, triggered on every pick-driven recompute and at
float load): a card picked by the viewed seat loses its float entry (it is
now a real pick — undimmed, no ✕), and a card whose last copy was taken by
another seat is removed entirely, mirroring the live-draft server's
pick-time float cleanup.
```

In `CLAUDE.md`, add to the end of the "Superpowers Plans" list:

```markdown
- `docs/superpowers/plans/2026-07-20-sheet-draft-pick-reconciliation.md` - Sheet-draft pick reconciliation (float upgrade/removal on synced picks)
```

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`
Expected: all pass with zero warnings.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add e2e/flows/sheet-draft-deck-builder.spec.ts docs/superpowers/specs/2026-07-19-sheet-draft-deck-builder-design.md CLAUDE.md docs/superpowers/plans/2026-07-20-sheet-draft-pick-reconciliation.md
git -C /Users/arpanet/dev/read-the-bones commit -m "Cover sheet-draft pick reconciliation end to end; document the reconcile pass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
