# Sheet-Draft Deck Builder (Local Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the deck builder for synced sheet drafts: an "Add to Deck Builder" button (float analog) plus full localStorage persistence of the WIP deck, keyed by draft + seat, with no DB writes and no auth.

**Architecture:** A derived "local deck mode" (active draft is sheet-based AND a seat is selected) reuses the existing `floatedCards` slice and deck-save machinery, branching to localStorage instead of the token-authed API. The server exposes one new read-only field (`isSheetDraft`) on `/api/drafts/[id]/live`. Spec: `docs/superpowers/specs/2026-07-19-sheet-draft-deck-builder-design.md`.

**Tech Stack:** Next.js (App Router), Zustand (`subscribeWithSelector`, no persist middleware), Vitest (jsdom for store tests), Playwright e2e.

## Global Constraints

- Repo root: `/Users/arpanet/dev/read-the-bones`. **All git commands use `git -C /Users/arpanet/dev/read-the-bones …` — never `cd … && git …`.**
- Commit co-author line (exact): `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- Zero ESLint warnings (`pnpm lint`), typecheck clean (`pnpm typecheck`), knip clean (`pnpm knip`).
- No DB writes for sheet drafts anywhere in this feature. The only server change is the read-only `isSheetDraft` response field.
- localStorage keys (exact): `localFloats:<draftId>:<seat>` and `localDeckState:<draftId>:<seat>`.
- Button copy (exact): `Add to Deck Builder` / `Remove from Deck Builder`.
- Queue mechanics remain live-draft-only (gated on `isAuthed`); only floats widen to local mode.
- All localStorage access wrapped in try/catch, silently degrading to in-memory-only.
- Store test files need the `// @vitest-environment jsdom` pragma on line 1 (see `src/app/stores/liveStore.test.ts`).

---

### Task 1: Server — expose `isSheetDraft` on `/api/drafts/[id]/live`

**Files:**
- Modify: `src/core/db/queries/drafts.ts` (DraftMeta interface ~line 113, getDraftMeta ~line 127)
- Modify: `src/app/api/drafts/[id]/live/route.ts` (response JSON ~line 106)
- Test: `src/core/db/queries/drafts.liveDraft.test.ts`

**Interfaces:**
- Consumes: existing `getDraftMeta(client, draftId)`.
- Produces: `DraftMeta.sheetId: string | null`; `/live` response field `isSheetDraft: boolean`. Task 2 consumes `isSheetDraft` client-side.

- [ ] **Step 1: Write the failing tests**

In `src/core/db/queries/drafts.liveDraft.test.ts`, extend the import from `./drafts` to include `getDraftMeta`, then add:

```ts
describe("getDraftMeta — sheetId", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => { client = createMockClient(); });

  it("returns sheetId for a sheet-based draft", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 10, picks_per_player: 45, banned_cards: null, sheet_id: "abc123" }],
    });

    const meta = await getDraftMeta(client, "draft-1");

    expect(meta?.sheetId).toBe("abc123");
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({ sql: expect.stringContaining("sheet_id") }),
    );
  });

  it("returns null sheetId for a live draft", async () => {
    client.execute.mockResolvedValueOnce({
      rows: [{ phase: "drafting", num_seats: 10, picks_per_player: 45, banned_cards: null, sheet_id: null }],
    });

    const meta = await getDraftMeta(client, "draft-1");

    expect(meta?.sheetId).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/core/db/queries/drafts.liveDraft.test.ts`
Expected: FAIL — `sheetId` is undefined / SQL does not contain `sheet_id`.

- [ ] **Step 3: Implement**

In `src/core/db/queries/drafts.ts`:

Add to the `DraftMeta` interface (after `picksPerPlayer`):

```ts
  /** Google Sheet id for sheet-synced drafts; null for live (in-app) drafts. */
  sheetId: string | null;
```

In `getDraftMeta`, change the SQL to:

```ts
    sql: "SELECT phase, num_seats, picks_per_player, banned_cards, sheet_id FROM drafts WHERE draft_id = ?",
```

and add to the returned object:

```ts
    sheetId: (row.sheet_id as string | null) ?? null,
```

In `src/app/api/drafts/[id]/live/route.ts`, add to the response JSON directly after `phase,` (~line 107):

```ts
      isSheetDraft: meta.sheetId !== null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/core/db/queries/drafts.liveDraft.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck` — expected clean. (If other `DraftMeta` consumers break, they only destructure existing fields; adding a field is additive.)

```bash
git -C /Users/arpanet/dev/read-the-bones add src/core/db/queries/drafts.ts src/app/api/drafts/[id]/live/route.ts src/core/db/queries/drafts.liveDraft.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Expose isSheetDraft on /live so the client can detect sheet drafts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Client — `BoardData.isSheetDraft` + `localDeck` module

**Files:**
- Modify: `src/app/stores/draftStore.ts` (`BoardData` interface ~line 34; `applyPollResults` board construction ~line 349 and compare-before-set ~line 396)
- Create: `src/app/stores/live/localDeck.ts`
- Test: `src/app/stores/live/localDeck.test.ts` (new)
- Test: `src/app/stores/draftStore.test.ts` (extend polling describe, ~line 256)

**Interfaces:**
- Consumes: `/live` response field `isSheetDraft` (Task 1); `useDraftStore` state (`board`, `selectedSeat`); `migrateDeckState(state): DeckState` and `DeckState` from `@/core/deckBuilder` / `@/core/types`.
- Produces (all consumed by Tasks 3–6):
  - `BoardData.isSheetDraft: boolean`
  - `getLocalDeckMode(): boolean`
  - `loadLocalFloats(draftId: string, seat: number): string[]`
  - `saveLocalFloats(draftId: string, seat: number, floats: string[]): void`
  - `loadLocalDeckState(draftId: string, seat: number): DeckState | null`
  - `saveLocalDeckState(state: DeckState): void`

- [ ] **Step 1: Write the failing tests**

Create `src/app/stores/live/localDeck.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  getLocalDeckMode,
  loadLocalFloats,
  saveLocalFloats,
  loadLocalDeckState,
  saveLocalDeckState,
} from "./localDeck";
import { useDraftStore, type BoardData } from "../draftStore";
import { createEmptyDeckState } from "@/core/deckBuilder";

function makeBoard(overrides: Partial<BoardData> = {}): BoardData {
  return {
    picks: [],
    numSeats: 10,
    picksPerPlayer: 45,
    phase: "drafting",
    seatNames: {},
    bannedCards: [],
    isSheetDraft: true,
    ...overrides,
  };
}

describe("getLocalDeckMode", () => {
  beforeEach(() => {
    localStorage.clear();
    useDraftStore.setState({ activeDraft: null, selectedSeat: null, board: null });
  });

  it("is true for a sheet draft with a selected seat", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeBoard() });
    expect(getLocalDeckMode()).toBe(true);
  });

  it("is false for live drafts", () => {
    useDraftStore.setState({ activeDraft: "live-1", selectedSeat: 3, board: makeBoard({ isSheetDraft: false }) });
    expect(getLocalDeckMode()).toBe(false);
  });

  it("is false with no seat selected", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: null, board: makeBoard() });
    expect(getLocalDeckMode()).toBe(false);
  });

  it("is false before board data arrives", () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: null });
    expect(getLocalDeckMode()).toBe(false);
  });
});

describe("local floats persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips floats per draft and seat", () => {
    saveLocalFloats("sheet-1", 3, ["Card A", "Card B"]);
    saveLocalFloats("sheet-1", 5, ["Card C"]);
    expect(loadLocalFloats("sheet-1", 3)).toEqual(["Card A", "Card B"]);
    expect(loadLocalFloats("sheet-1", 5)).toEqual(["Card C"]);
    expect(loadLocalFloats("sheet-2", 3)).toEqual([]);
  });

  it("returns [] for corrupt JSON", () => {
    localStorage.setItem("localFloats:sheet-1:3", "{not json");
    expect(loadLocalFloats("sheet-1", 3)).toEqual([]);
  });

  it("filters non-string entries", () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Card A", 42, null]));
    expect(loadLocalFloats("sheet-1", 3)).toEqual(["Card A"]);
  });
});

describe("local deck state persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a deck state keyed by its own identity", () => {
    const state = createEmptyDeckState("sheet-1", 3);
    state.zones.deck["mv-0-1"] = ["Sol Ring"];
    saveLocalDeckState(state);
    const loaded = loadLocalDeckState("sheet-1", 3);
    expect(loaded?.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
    expect(loaded?.draftId).toBe("sheet-1");
    expect(loaded?.seat).toBe(3);
  });

  it("refuses to save a deck with empty draftId", () => {
    saveLocalDeckState(createEmptyDeckState("", 0));
    expect(localStorage.length).toBe(0);
  });

  it("forces identity from the key on load", () => {
    const state = createEmptyDeckState("other-draft", 9);
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(state));
    const loaded = loadLocalDeckState("sheet-1", 3);
    expect(loaded?.draftId).toBe("sheet-1");
    expect(loaded?.seat).toBe(3);
  });

  it("returns null for corrupt or shapeless JSON", () => {
    localStorage.setItem("localDeckState:sheet-1:3", "{not json");
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify({ foo: 1 }));
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(loadLocalDeckState("sheet-1", 3)).toBeNull();
  });
});
```

Add to `src/app/stores/draftStore.test.ts`, inside `describe("draftStore — polling", …)`:

```ts
  it("board.isSheetDraft maps from the /live response", async () => {
    mockFetchResponses({ ...baseLiveData, isSheetDraft: true }, baseSyncData);
    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().board?.isSheetDraft).toBe(true);
  });

  it("board.isSheetDraft defaults to false when absent from the response", async () => {
    mockFetchResponses(baseLiveData, baseSyncData);
    useDraftStore.setState({ activeDraft: "draft-1" });
    await useDraftStore.getState().refreshNow();
    expect(useDraftStore.getState().board?.isSheetDraft).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/live/localDeck.test.ts src/app/stores/draftStore.test.ts`
Expected: localDeck tests FAIL (module doesn't exist); the two new draftStore tests FAIL (`isSheetDraft` undefined — note TS may fail compile first on the missing `BoardData` field; that counts as the failing state).

- [ ] **Step 3: Implement**

In `src/app/stores/draftStore.ts`, add to the `BoardData` interface (after `bannedCards`):

```ts
  /** True when this draft syncs from a Google Sheet (no seat tokens exist). */
  isSheetDraft: boolean;
```

In `applyPollResults`, add to the `board` construction (after `bannedCards: …`):

```ts
      isSheetDraft: liveData.isSheetDraft === true,
```

In the `nextBoard` compare-before-set, add alongside the other scalar comparisons:

```ts
      board.isSheetDraft === prev.board.isSheetDraft &&
```

Create `src/app/stores/live/localDeck.ts`:

```ts
/**
 * Local deck mode — deck-builder persistence for synced sheet drafts.
 *
 * Sheet drafts have no seat tokens, so speculative cards ("Add to Deck
 * Builder", the float analog) and the WIP deck arrangement are persisted in
 * localStorage instead of the token-authed API. Keys are scoped by draftId
 * AND seat so prospective decks never leak between seats.
 */
import { useDraftStore } from "../draftStore";
import { migrateDeckState } from "@/core/deckBuilder";
import type { DeckState } from "@/core/types";

/** True when the active draft is sheet-synced and a seat is selected. */
export function getLocalDeckMode(): boolean {
  const { board, selectedSeat } = useDraftStore.getState();
  return board?.isSheetDraft === true && selectedSeat !== null;
}

function floatsKey(draftId: string, seat: number): string {
  return `localFloats:${draftId}:${seat}`;
}

function deckStateKey(draftId: string, seat: number): string {
  return `localDeckState:${draftId}:${seat}`;
}

export function loadLocalFloats(draftId: string, seat: number): string[] {
  try {
    const raw = localStorage.getItem(floatsKey(draftId, seat));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

export function saveLocalFloats(draftId: string, seat: number, floats: string[]): void {
  try {
    localStorage.setItem(floatsKey(draftId, seat), JSON.stringify(floats));
  } catch {
    // localStorage unavailable or full — degrade to in-memory only
  }
}

export function loadLocalDeckState(draftId: string, seat: number): DeckState | null {
  try {
    const raw = localStorage.getItem(deckStateKey(draftId, seat));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const candidate = parsed as DeckState;
    if (typeof candidate.zones !== "object" || candidate.zones === null) return null;
    // Force identity from the storage key so a mis-keyed blob can't leak a
    // different draft/seat identity into the store.
    return migrateDeckState({ ...candidate, draftId, seat });
  } catch {
    return null;
  }
}

export function saveLocalDeckState(state: DeckState): void {
  // The key derives from the state's own identity — never from current
  // selection — so a mid-debounce seat switch can't write to the wrong key.
  if (!state.draftId) return;
  try {
    localStorage.setItem(deckStateKey(state.draftId, state.seat), JSON.stringify(state));
  } catch {
    // localStorage unavailable or full — degrade to in-memory only
  }
}
```

- [ ] **Step 4: Fix `BoardData` literals that now fail typecheck**

Run: `pnpm typecheck`
Expected failures: object literals building `BoardData` without `isSheetDraft` — at minimum `src/app/stores/draftStore.test.ts` ~line 229 (the `updateSeatName` test board). Add `isSheetDraft: false,` to each. Re-run `pnpm typecheck` until clean.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/app/stores/live/localDeck.test.ts src/app/stores/draftStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/draftStore.ts src/app/stores/draftStore.test.ts src/app/stores/live/localDeck.ts src/app/stores/live/localDeck.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Add BoardData.isSheetDraft and localDeck storage module for local deck mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Float actions — localStorage branch in `queueFloat.ts`

**Files:**
- Modify: `src/app/stores/live/queueFloat.ts` (`mutateFloat` ~line 113, `makeFetchFloatedCards` ~line 266)
- Test: `src/app/stores/liveStore.test.ts` (new describe block)

**Interfaces:**
- Consumes: `getLocalDeckMode`, `loadLocalFloats`, `saveLocalFloats` from `./localDeck` (Task 2).
- Produces: existing actions `addFloat(cardName)`, `removeFloat(cardName)`, `fetchFloatedCards()` now work without a seat token when local deck mode is active, persisting to `localFloats:<draftId>:<seat>`. No signature changes.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/stores/liveStore.test.ts` (reuse the file's existing `resetStores()` helper and imports; add `import type { BoardData } from "./draftStore";`):

```ts
function makeSheetBoard(): BoardData {
  return {
    picks: [],
    numSeats: 10,
    picksPerPlayer: 45,
    phase: "complete",
    seatNames: {},
    bannedCards: [],
    isSheetDraft: true,
  };
}

describe("local deck mode — floats", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  it("addFloat persists to localStorage without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().addFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual(["Sylvan Library"]);
    expect(useLiveStore.getState().floatedCardsSet.has("Sylvan Library")).toBe(true);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Sylvan Library"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("removeFloat updates state and localStorage", async () => {
    await useLiveStore.getState().addFloat("Sylvan Library");
    await useLiveStore.getState().addFloat("Land Tax");
    await useLiveStore.getState().removeFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual(["Land Tax"]);
    expect(JSON.parse(localStorage.getItem("localFloats:sheet-1:3")!)).toEqual(["Land Tax"]);
  });

  it("fetchFloatedCards loads from localStorage in local mode", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade"]));
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await useLiveStore.getState().fetchFloatedCards();

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("float actions are no-ops without a token outside local mode", async () => {
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    await useLiveStore.getState().addFloat("Sylvan Library");

    expect(useLiveStore.getState().floatedCards).toEqual([]);
    expect(localStorage.getItem("localFloats:sheet-1:3")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: the four new tests FAIL (`floatedCards` stays empty — `mutateFloat` early-returns without a token).

- [ ] **Step 3: Implement**

In `src/app/stores/live/queueFloat.ts`, add the import:

```ts
import { getLocalDeckMode, loadLocalFloats, saveLocalFloats } from "./localDeck";
```

In `mutateFloat`, replace the guard and split the no-token path (current lines ~120-128):

```ts
  const { seatToken, floatedCards: previous } = get();
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!activeDraft) return;

  const next =
    method === "PUT"
      ? [...previous, cardName]
      : previous.filter((c) => c !== cardName);

  if (!seatToken) {
    // Local deck mode (sheet drafts): persist floats to localStorage, no API.
    if (!getLocalDeckMode()) return;
    const { selectedSeat } = useDraftStore.getState();
    if (selectedSeat === null) return;
    set({ floatedCards: next, floatedCardsSet: new Set(next) });
    saveLocalFloats(activeDraft, selectedSeat, next);
    return;
  }

  set({ floatedCards: next, floatedCardsSet: new Set(next) });
```

(the `try { fetch(…) }` server block below stays unchanged).

In `makeFetchFloatedCards`, replace the guard (current lines ~268-270):

```ts
    const { seatToken } = get();
    const activeDraft = useDraftStore.getState().activeDraft;
    if (!activeDraft) return;

    if (!seatToken) {
      // Local deck mode (sheet drafts): floats live in localStorage.
      if (!getLocalDeckMode()) return;
      const { selectedSeat } = useDraftStore.getState();
      if (selectedSeat === null) return;
      const incoming = loadLocalFloats(activeDraft, selectedSeat);
      const prevFloats = get().floatedCards;
      const floatsChanged =
        incoming.length !== prevFloats.length ||
        incoming.some((c, i) => c !== prevFloats[i]);
      if (floatsChanged) {
        set({ floatedCards: incoming, floatedCardsSet: new Set(incoming) });
      }
      return;
    }
```

(the existing `try { fetch(…) }` token path stays unchanged below it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS (all tests in file — existing token-path tests must stay green).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/live/queueFloat.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Persist floats to localStorage in local deck mode (sheet drafts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Deck save/load — localStorage branch + identity in `deckSave.ts`

**Files:**
- Modify: `src/app/stores/live/deckSave.ts` (`flushDeckSave` ~line 73, `makeFetchDeckState` ~line 258)
- Test: `src/app/stores/liveStore.test.ts` (new describe block)

**Interfaces:**
- Consumes: `getLocalDeckMode`, `loadLocalDeckState`, `saveLocalDeckState` from `./localDeck` (Task 2); existing `createEmptyDeckState`, `dispatchDeck`, `DECK_SAVE_STATUS_RESET_MS`.
- Produces: `fetchDeckState()` now initializes/restores `deckState` with correct identity (`draftId = activeDraft`, `seat = selectedSeat`) in local mode; deck edits auto-save to `localDeckState:<draftId>:<seat>` after the existing 1000ms debounce. Task 5 relies on `flushDeckSave`'s local branch being synchronous through the localStorage write.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/stores/liveStore.test.ts` (same `makeSheetBoard` helper from Task 3):

```ts
describe("local deck mode — deck state persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    vi.useFakeTimers();
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3, board: makeSheetBoard() });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fetchDeckState initializes empty state with draft/seat identity, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().fetchDeckState();

    const { deckState, deckReady } = useLiveStore.getState();
    expect(deckReady).toBe(true);
    expect(deckState.draftId).toBe("sheet-1");
    expect(deckState.seat).toBe(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetchDeckState restores a stored local deck", async () => {
    const stored = createEmptyDeckState("sheet-1", 3);
    stored.zones.deck["mv-0-1"] = ["Sol Ring"];
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(stored));

    await useLiveStore.getState().fetchDeckState();

    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
  });

  it("deck edits save to localStorage after the debounce, without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await useLiveStore.getState().fetchDeckState();

    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 8, Swamp: 0, Mountain: 0, Forest: 9 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    const saved = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(saved.basicLands.Island).toBe(8);
    expect(useLiveStore.getState().deckSaveStatus).toBe("saved");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not save while deck identity is still empty", async () => {
    // No fetchDeckState — deckState still carries draftId "" from the reset.
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 1, Island: 0, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });
    await vi.advanceTimersByTimeAsync(1100);

    expect(localStorage.getItem("localDeckState:sheet-1:3")).toBeNull();
  });
});
```

Note: if `SET_BASICS`'s action shape differs, check `DeckAction` in `src/core/deckBuilder.ts` and match it (the existing panel dispatches `{ type: "SET_BASICS", basics, scryfallData }`). `BasicLandCounts` keys are the five basic land names — verify in `src/core/types.ts` and adjust the literals if the shape differs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: new tests FAIL — identity stays `""`/`0`, nothing lands in localStorage.

- [ ] **Step 3: Implement**

In `src/app/stores/live/deckSave.ts`, add the import:

```ts
import { getLocalDeckMode, loadLocalDeckState, saveLocalDeckState } from "./localDeck";
```

In `flushDeckSave`, replace the single guard line (`if (!seatToken || !activeDraft || !deckDirty || deckInFlight) return;`) with:

```ts
  if (!activeDraft || !deckDirty || deckInFlight) return;

  if (!seatToken) {
    // Local deck mode (sheet drafts): persist to localStorage instead of the
    // API. deckState identity gates the write — before the local snapshot is
    // initialized the state still carries draftId "" and must not be saved.
    if (!getLocalDeckMode() || deckState.draftId !== activeDraft) return;
    saveLocalDeckState(deckState);
    deckDirty = false;
    getLiveStore().setState({ deckSaveStatus: "saved" });
    setTimeout(() => {
      if (getLiveStore().getState().deckSaveStatus === "saved") {
        getLiveStore().setState({ deckSaveStatus: "idle" });
      }
    }, DECK_SAVE_STATUS_RESET_MS);
    return;
  }
```

In `makeFetchDeckState`, add an `else if` branch after the `if (seatToken) { … }` block (before `deckDirty = false; set({ deckReady: true });`):

```ts
    } else if (getLocalDeckMode()) {
      // Local deck mode (sheet drafts): restore from localStorage, or start
      // empty with correct identity so saves/share/header work.
      const selectedSeat = useDraftStore.getState().selectedSeat;
      if (selectedSeat !== null) {
        const snapshot =
          loadLocalDeckState(activeDraft, selectedSeat) ??
          createEmptyDeckState(activeDraft, selectedSeat);
        get().dispatchDeck({ type: "INIT_FROM_SNAPSHOT", snapshot });
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/live/deckSave.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Persist WIP deck state to localStorage in local deck mode

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wiring — load local deck on board arrival and seat switch

**Files:**
- Modify: `src/app/stores/live/deckSave.ts` (new `makeSyncLocalDeck` + `loadedLocalKey` flag; `resetDeckSaveState` ~line 54)
- Modify: `src/app/stores/liveStore.ts` (new subscription after the existing deck-builder sync subscriptions, ~line 408)
- Modify: `src/app/stores/wiring.ts` (doc comment: add the new subscription to the liveStore list)
- Test: `src/app/stores/liveStore.test.ts` (new describe block)

**Interfaces:**
- Consumes: `getLocalDeckMode` (Task 2); `flushDeckSave`, `deckSaveTimer`, `fetchDeckState`, `fetchFloatedCards` (Tasks 3–4); `GetState`/`SetState` types from `../liveStore`.
- Produces: `makeSyncLocalDeck(get, getLiveStore): () => void` exported from `deckSave.ts`; a `useDraftStore.subscribe` registration in `liveStore.ts` that fires it when `(activeDraft, board.isSheetDraft, selectedSeat)` changes. Loads happen automatically — later tasks and e2e rely on this, no new API.

- [ ] **Step 1: Write the failing tests**

Add to `src/app/stores/liveStore.test.ts`:

```ts
describe("local deck mode — wiring (board arrival, seat switch)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetStores();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads local floats and deck when board arrives with isSheetDraft", async () => {
    localStorage.setItem("localFloats:sheet-1:3", JSON.stringify(["Doom Blade"]));
    const stored = createEmptyDeckState("sheet-1", 3);
    stored.zones.deck["mv-0-1"] = ["Sol Ring"];
    localStorage.setItem("localDeckState:sheet-1:3", JSON.stringify(stored));

    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3 });
    // Board arrives via first /live poll — after activeDraft is set.
    useDraftStore.setState({ board: makeSheetBoard() });
    await vi.advanceTimersByTimeAsync(0);

    expect(useLiveStore.getState().floatedCards).toEqual(["Doom Blade"]);
    expect(useLiveStore.getState().deckState.zones.deck["mv-0-1"]).toEqual(["Sol Ring"]);
    expect(useLiveStore.getState().deckState.seat).toBe(3);
  });

  it("switching seats flushes the old seat's pending save and loads the new seat", async () => {
    useDraftStore.setState({ activeDraft: "sheet-1", selectedSeat: 3 });
    useDraftStore.setState({ board: makeSheetBoard() });
    await vi.advanceTimersByTimeAsync(0);

    // Edit seat 3's deck; do NOT wait out the 1000ms save debounce.
    useLiveStore.getState().dispatchDeck({
      type: "SET_BASICS",
      basics: { Plains: 0, Island: 4, Swamp: 0, Mountain: 0, Forest: 0 },
      scryfallData: new Map(),
    });

    useDraftStore.getState().setSelectedSeat(5);
    await vi.advanceTimersByTimeAsync(0);

    // Old seat's pending edit was flushed to its own key…
    const seat3 = JSON.parse(localStorage.getItem("localDeckState:sheet-1:3")!);
    expect(seat3.basicLands.Island).toBe(4);
    // …and the store now holds seat 5's (fresh, empty) deck.
    expect(useLiveStore.getState().deckState.seat).toBe(5);
    expect(useLiveStore.getState().deckState.basicLands.Island).toBe(0);
    // Seat isolation: seat 5's key was not polluted by seat 3's edit.
    const seat5Raw = localStorage.getItem("localDeckState:sheet-1:5");
    if (seat5Raw) expect(JSON.parse(seat5Raw).basicLands.Island).toBe(0);
  });

  it("does nothing for live drafts", async () => {
    localStorage.setItem("localFloats:live-1:3", JSON.stringify(["Doom Blade"]));
    useDraftStore.setState({ activeDraft: "live-1", selectedSeat: 3 });
    useDraftStore.setState({ board: { ...makeSheetBoard(), isSheetDraft: false } });
    await vi.advanceTimersByTimeAsync(0);

    expect(useLiveStore.getState().floatedCards).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: new tests FAIL (nothing loads — no subscription exists yet).

- [ ] **Step 3: Implement**

In `src/app/stores/live/deckSave.ts`:

Add a module-scoped flag next to the other flags (~line 32):

```ts
// Tracks which "<draftId>:<seat>" local deck is currently loaded, so the
// local-mode subscription only reloads when the identity actually changes.
let loadedLocalKey: string | null = null;
```

Reset it in `resetDeckSaveState` (add one line):

```ts
  loadedLocalKey = null;
```

Add the factory (after `makeFetchDeckState`):

```ts
// ---------------------------------------------------------------------------
// makeSyncLocalDeck — local-mode load trigger (board arrival / seat switch)
// ---------------------------------------------------------------------------

/**
 * Loads local floats + deck state whenever local deck mode becomes available
 * or the selected seat changes. Board data arrives on the first /live poll —
 * after the activeDraft reset — so this subscription (not the activeDraft
 * handler) is what actually initializes local-mode deck state.
 */
export function makeSyncLocalDeck(
  get: GetState,
  getLiveStore: () => { getState: GetState; setState: SetState },
) {
  return (): void => {
    if (get().viewingSharedDeck) return;
    const { activeDraft, selectedSeat } = useDraftStore.getState();
    if (!getLocalDeckMode() || !activeDraft || selectedSeat === null) {
      loadedLocalKey = null;
      return;
    }
    const key = `${activeDraft}:${selectedSeat}`;
    if (key === loadedLocalKey) return;

    // Flush any pending debounced save before switching — the save key derives
    // from deckState's own identity, so it lands on the seat being left.
    if (deckSaveTimer) {
      clearTimeout(deckSaveTimer);
      deckSaveTimer = null;
      void flushDeckSave(activeDraft, getLiveStore);
    }

    loadedLocalKey = key;
    void get().fetchFloatedCards();
    void get().fetchDeckState();
  };
}
```

In `src/app/stores/liveStore.ts`:

Add `makeSyncLocalDeck` to the `./live/deckSave` import list. Then add after the existing `mySeat` subscription (~line 408):

```ts
// Local deck mode (sheet drafts): load per-seat local floats + deck state when
// the board identifies the draft as sheet-based, and reload on seat switch.
const syncLocalDeck = makeSyncLocalDeck(useLiveStore.getState, getLiveStoreRef);

useDraftStore.subscribe(
  (state) => `${state.activeDraft ?? ""}|${state.board?.isSheetDraft === true}|${state.selectedSeat ?? ""}`,
  () => syncLocalDeck(),
);
```

(The selector returns a string so `subscribeWithSelector`'s default `Object.is` equality suffices — no tuple equality function needed.)

In `src/app/stores/wiring.ts`, extend the liveStore subscription list in the doc comment with:

```
 *       8. activeDraft/board.isSheetDraft/selectedSeat → syncLocalDeck() (local deck mode load)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/stores/liveStore.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/live/deckSave.ts src/app/stores/liveStore.ts src/app/stores/wiring.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/dev/read-the-bones commit -m "Wire local deck loading on sheet-board arrival and seat switch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Widen speculative-card gates to local deck mode

**Files:**
- Modify: `src/app/stores/computeMyDeckCardNames.ts`
- Modify: `src/app/stores/selectors.ts` (new `useLocalDeckMode` hook; `getCardStatus`, `useCardStatuses`, `useCardStatus`, `getMyDeckCardNames`, `useMyDeckCardNames`)
- Modify: `src/app/stores/live/deckSave.ts` (`makeSyncDeckWithPicks` ~line 141)
- Modify: `src/app/components/deck-builder/DeckBuilderPanel.tsx` (~lines 66-68, 229, 298, 309)
- Test: `src/app/stores/computeMyDeckCardNames.test.ts` (new)
- Test: `src/app/stores/selectors.test.ts` (extend)

**Interfaces:**
- Consumes: `getLocalDeckMode` from `./live/localDeck` (Task 2).
- Produces:
  - `computeMyDeckCardNames({ picks, isAuthed, localDeckMode, floatedCards, queue }): string[]` — new required `localDeckMode: boolean` field; floats included when `isAuthed || localDeckMode`, queue still requires `isAuthed`.
  - `useLocalDeckMode(): boolean` exported from `selectors.ts` (Task 7 consumes it).
  - Card-status selectors report `"floated"` in local mode; deck-builder REBUILD includes local floats.

- [ ] **Step 1: Write the failing tests**

Create `src/app/stores/computeMyDeckCardNames.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeMyDeckCardNames } from "./computeMyDeckCardNames";

const base = { picks: ["Sol Ring"], floatedCards: ["Sylvan Library"], queue: [] };

describe("computeMyDeckCardNames — local deck mode", () => {
  it("includes floats in local deck mode without auth", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: false, localDeckMode: true });
    expect(result).toEqual(["Sol Ring", "Sylvan Library"]);
  });

  it("excludes floats when neither authed nor local mode", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: false, localDeckMode: false });
    expect(result).toEqual(["Sol Ring"]);
  });

  it("still includes floats when authed (live path unchanged)", () => {
    const result = computeMyDeckCardNames({ ...base, isAuthed: true, localDeckMode: false });
    expect(result).toEqual(["Sol Ring", "Sylvan Library"]);
  });

  it("never includes queued cards in local mode alone", () => {
    const result = computeMyDeckCardNames({
      picks: [],
      isAuthed: false,
      localDeckMode: true,
      floatedCards: [],
      queue: [{ mode: "pause", cards: [{ cardId: 1, cardName: "Land Tax" }] }],
    });
    expect(result).toEqual([]);
  });

  it("dedupes floats against picks", () => {
    const result = computeMyDeckCardNames({
      picks: ["Sylvan Library"],
      isAuthed: false,
      localDeckMode: true,
      floatedCards: ["Sylvan Library"],
      queue: [],
    });
    expect(result).toEqual(["Sylvan Library"]);
  });
});
```

Add to `src/app/stores/selectors.test.ts` (adapt to the file's existing setup/reset helpers; the board factory mirrors Task 3's `makeSheetBoard`):

```ts
describe("getCardStatus — local deck mode", () => {
  it("reports floated without auth when local deck mode is active", () => {
    useDraftStore.setState({
      activeDraft: "sheet-1",
      selectedSeat: 3,
      board: {
        picks: [], numSeats: 10, picksPerPlayer: 45, phase: "complete",
        seatNames: {}, bannedCards: [], isSheetDraft: true,
      },
    });
    useLiveStore.setState({
      floatedCards: ["Sylvan Library"],
      floatedCardsSet: new Set(["Sylvan Library"]),
    });

    expect(getCardStatus("Sylvan Library").status).toBe("floated");
  });

  it("does not report floated for live-draft spectators", () => {
    useDraftStore.setState({
      activeDraft: "live-1",
      selectedSeat: 3,
      board: {
        picks: [], numSeats: 10, picksPerPlayer: 45, phase: "drafting",
        seatNames: {}, bannedCards: [], isSheetDraft: false,
      },
    });
    useLiveStore.setState({
      floatedCards: ["Sylvan Library"],
      floatedCardsSet: new Set(["Sylvan Library"]),
    });

    expect(getCardStatus("Sylvan Library").status).toBe("none");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/stores/computeMyDeckCardNames.test.ts src/app/stores/selectors.test.ts`
Expected: FAIL — TS error on the new `localDeckMode` field, and/or `"none"` where `"floated"` is expected.

- [ ] **Step 3: Implement**

`src/app/stores/computeMyDeckCardNames.ts` — add the field and widen the float gate (queue unchanged):

```ts
export function computeMyDeckCardNames({
  picks,
  isAuthed,
  localDeckMode,
  floatedCards,
  queue,
}: {
  picks: string[];
  isAuthed: boolean;
  /** Sheet-draft local mode: floats (local adds) are visible, queue is not. */
  localDeckMode: boolean;
  floatedCards: string[];
  queue: QueueGroupEntry[];
}): string[] {
  const authFloated = isAuthed || localDeckMode ? floatedCards : [];
  const authQueued = isAuthed
    ? queue.flatMap((entry) => entry.cards.map((c) => c.cardName))
    : [];
  // …rest of the function unchanged
```

Also update its doc comment's "Auth-gated" rule line to: `- Floats are included when authed OR in local deck mode (sheet drafts); queued cards require auth.`

`src/app/stores/selectors.ts`:

Add the import and hook:

```ts
import { getLocalDeckMode } from "./live/localDeck";

/**
 * Reactive: true when the active draft is sheet-synced and a seat is selected
 * — the deck builder then persists locally (no tokens exist for sheet drafts).
 */
export function useLocalDeckMode(): boolean {
  const isSheetDraft = useDraftStore((s) => s.board?.isSheetDraft === true);
  const selectedSeat = useDraftStore((s) => s.selectedSeat);
  return isSheetDraft && selectedSeat !== null;
}
```

In `getCardStatus`, restructure the top so the float check sits outside the auth block:

```ts
  const isAuthed = getIsAuthed();
  if (isAuthed) {
    const count = queuedCardCounts.get(cardName);
    if (count != null && count > 0) {
      // … existing queued branch unchanged …
    }
  }
  if ((isAuthed || getLocalDeckMode()) && floatedCardsSet.has(cardName)) {
    return { status: "floated" };
  }
```

In `useCardStatuses` and `useCardStatus`, add below the existing `isAuthed` derivation:

```ts
  const isSheetDraft = useDraftStore((s) => s.board?.isSheetDraft === true);
  const localDeckMode = isSheetDraft && selectedSeat !== null;
```

move the `floatedCardsSet.has(cardName)` check out of the `if (isAuthed)` block into its own `if ((isAuthed || localDeckMode) && floatedCardsSet.has(cardName))` check (same restructure as `getCardStatus`), and add `localDeckMode` to both `useMemo` dependency arrays.

In `getMyDeckCardNames` and `useMyDeckCardNames`, pass the new field:

```ts
  // getMyDeckCardNames:
  return new Set(computeMyDeckCardNames({ picks: seatCardList ?? [], isAuthed, localDeckMode: getLocalDeckMode(), floatedCards, queue }));
```

```ts
  // useMyDeckCardNames — add subscriptions:
  const isSheetDraft = useDraftStore((s) => s.board?.isSheetDraft === true);
  // inside the useMemo (add isSheetDraft to the dep array):
    const localDeckMode = isSheetDraft && selectedSeat !== null;
    return new Set(computeMyDeckCardNames({ picks: seatCardList ?? [], isAuthed, localDeckMode, floatedCards, queue }));
```

`src/app/stores/live/deckSave.ts` — in `makeSyncDeckWithPicks`, pass the mode:

```ts
    const canonicalCards = computeMyDeckCardNames({
      picks: seatCardList ?? [],
      isAuthed,
      localDeckMode: getLocalDeckMode(),
      floatedCards,
      queue,
    });
```

`src/app/components/deck-builder/DeckBuilderPanel.tsx`:

- Import `useLocalDeckMode` alongside `useIsAuthed` from `@/app/stores/selectors`.
- Replace lines 66-68:

```ts
  const isAuthed = useIsAuthed();
  const localDeckMode = useLocalDeckMode();
  const effectiveFloatedCards = isAuthed || localDeckMode ? floatedCards : [];
  const effectiveQueuedCardNames = isAuthed ? queue.flatMap((e) => e.cards.map((c) => c.cardName)) : [];
```

- Suppress the queue toggle outside live-authed mode — in BOTH `<DeckZone>` usages change:

```ts
            onToggleQueue={isAuthed ? handleToggleQueue : undefined}
```

- Fix the header seat label (~line 229) so local mode shows the selected seat's name:

```tsx
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-xs font-medium text-zinc-400">
            {seatNames?.[String(mySeat ?? state.seat)] || `Seat ${mySeat ?? state.seat}`}
          </span>
```

- [ ] **Step 4: Run tests, typecheck**

Run: `pnpm test src/app/stores/ && pnpm typecheck`
Expected: PASS / clean. Typecheck will surface every remaining `computeMyDeckCardNames` call site missing `localDeckMode` — fix any stragglers by passing `localDeckMode: getLocalDeckMode()` (module code) or the reactive derivation (hooks).

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/stores/computeMyDeckCardNames.ts src/app/stores/computeMyDeckCardNames.test.ts src/app/stores/selectors.ts src/app/stores/selectors.test.ts src/app/stores/live/deckSave.ts src/app/components/deck-builder/DeckBuilderPanel.tsx
git -C /Users/arpanet/dev/read-the-bones commit -m "Widen speculative-card gates to local deck mode (floats only, queue stays live)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CardStatsModal — "Add to Deck Builder" button

**Files:**
- Modify: `src/app/components/CardStatsModal.tsx` (~lines 45-48, 141-145, 179-195, 344-448)

**Interfaces:**
- Consumes: `useLocalDeckMode` from `@/app/stores/selectors` (Task 6); existing `addFloat`/`removeFloat` (local-mode-aware since Task 3).
- Produces: UI only — in local deck mode the modal shows `Add to Deck Builder` / `Remove from Deck Builder` where live drafts show `Float` / `Unfloat`. No new exports.

- [ ] **Step 1: Implement**

In `src/app/components/CardStatsModal.tsx`:

Extend the selectors import to include `useLocalDeckMode`, and add below `const isAuthed = useIsAuthed();` (~line 45):

```ts
  const localDeckMode = useLocalDeckMode();
```

Widen `showActions` (~line 141):

```ts
  const showActions =
    (isLiveDraft || localDeckMode) &&
    cardStatus !== "taken" &&
    (cardStatus !== "picked" || pickedButCopiesRemain);
```

Widen the float handler gates and pass the mode to `ActionButtons` (~lines 181-193):

```tsx
                <ActionButtons
                  cardStatus={cardStatus}
                  isMyTurn={isAuthed && isMyTurn}
                  queuePosition={queuePosition}
                  queuedCount={queuedCount}
                  remainingCopies={remainingCopies}
                  disabled={actionPending}
                  localDeckMode={localDeckMode}
                  onPick={isAuthed ? handlePick : undefined}
                  onQueue={canQueue ? handleQueue : undefined}
                  onUnqueue={isAuthed ? handleUnqueue : undefined}
                  onFloat={isAuthed || localDeckMode ? handleFloat : undefined}
                  onUnfloat={isAuthed || localDeckMode ? handleUnfloat : undefined}
                />
```

In `ActionButtonsProps`, add:

```ts
  localDeckMode?: boolean;
```

In `ActionButtons`, add label derivations after the button class constants (~line 362):

```ts
  const floatLabel = props.localDeckMode ? "Add to Deck Builder" : "Float";
  const unfloatLabel = props.localDeckMode ? "Remove from Deck Builder" : "Unfloat";
```

Replace the three button texts: both `Float` occurrences (cases `"none"` and `"picked"`-with-copies) become `{floatLabel}`, and the `Unfloat` occurrence (case `"floated"`) becomes `{unfloatLabel}`.

- [ ] **Step 2: Verify typecheck, lint, and existing tests**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean/green. (Behavioral coverage lands in Task 8's e2e spec; live-draft e2e specs asserting the "Float" button text must stay green since `localDeckMode` is false there.)

- [ ] **Step 3: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add src/app/components/CardStatsModal.tsx
git -C /Users/arpanet/dev/read-the-bones commit -m "Show Add to Deck Builder button in card modal for sheet drafts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: E2e spec + docs + full verification

**Files:**
- Modify: `e2e/helpers/mock-api.ts` (add `"sheet-draft"` scenario)
- Create: `e2e/flows/sheet-draft-deck-builder.spec.ts`
- Modify: `CLAUDE.md` (Key Features → Deck builder bullet)
- Modify: `docs/superpowers/plans/…` — nothing; plan checkboxes are updated as you go.

**Interfaces:**
- Consumes: everything from Tasks 1-7; e2e helpers `createMockContext`, `selectActiveDraft`, `selectSeat`, `closeSettings`, `openDeckBuilder` (see `e2e/flows/spectator.spec.ts` for the unauthenticated flow pattern — note: NO `authenticateAs` call).
- Produces: `"sheet-draft"` added to the `Scenario` union in `mock-api.ts`.

**Fixture facts** (from `e2e/fixtures/live-board.json` + `cards-40.json`): draft id `gamma`, seat 1 picked Sol Ring / Elspeth, Knight-Errant / Mother of Runes. `Sylvan Library` and `Land Tax` are in the card pool but picked by nobody (status `none` — the add button appears). Avoid Growth Spiral / Phyrexian Arena (used as float fixtures in authed tests).

- [ ] **Step 1: Add the `"sheet-draft"` scenario to mock-api.ts**

In `e2e/helpers/mock-api.ts`:

- Add `| "sheet-draft"` to the `Scenario` union.
- Add `"sheet-draft"` to the `hasLiveBoard` scenario list (~line 57) and to the `/live` route registration list (~line 118).
- Where the `/live` route body is built from `liveBoardFixture` (+ overrides), inject the flag for this scenario, e.g.:

```ts
  const liveBoardBody = {
    ...liveBoardFixture,
    ...(scenario === "sheet-draft" ? { isSheetDraft: true } : {}),
    ...(overrides.liveBoard ?? {}),
  };
```

and use `liveBoardBody` in the route fulfillment. Adapt to the file's actual structure — the requirement is: for scenario `"sheet-draft"`, `/api/drafts/*/live*` responds with the board fixture plus `isSheetDraft: true`, and NO token-authed routes (`/me`, `/queue`, `/float`, `/deck-state`) are registered for it (same as `"spectator"`).

- [ ] **Step 2: Write the e2e spec**

Create `e2e/flows/sheet-draft-deck-builder.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import {
  selectActiveDraft,
  selectSeat,
  closeSettings,
  openDeckBuilder,
} from "../helpers/assertions";

test.describe("Sheet-draft deck builder (local mode)", () => {
  test.beforeEach(async ({ page }) => {
    // No authenticateAs — sheet drafts have no seat tokens.
    await page.addInitScript(() => {
      localStorage.setItem("hideTaken", "false");
    });
    await createMockContext(page, "sheet-draft");

    await page.route("**/api/cards/stats*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          pick: { drafts_in_pool: 1, times_picked: 1, avg_pick: 5, median_pick: 5, geomean_pick: 5 },
          pick_history: [],
          pick_distribution: [],
          times_banned: 0,
          color_pair_breakdown: [],
        }),
      }),
    );
  });

  test("add a card, persist across reload, isolate per seat", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    // Open the card modal for an unpicked card and add it.
    await page.locator("tbody tr").filter({ hasText: "Sylvan Library" }).first().click();
    const addButton = page.getByRole("button", { name: "Add to Deck Builder" });
    await expect(addButton).toBeVisible();
    await addButton.click();
    // Button flips to the remove label once the local float lands.
    await expect(page.getByRole("button", { name: "Remove from Deck Builder" })).toBeVisible();
    await page.keyboard.press("Escape");

    // Deck builder shows picks + the added card.
    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sol Ring" }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible();

    // Wait for the local float to land in storage before reloading. (The full
    // deckState key is only written once an arrangement edit dirties the deck —
    // unit tests cover that path; this flow persists via localFloats.)
    await page.waitForFunction(() => localStorage.getItem("localFloats:gamma:1") !== null);

    // Reload — the added card must survive (localStorage persistence).
    await page.reload();
    await expect(page.locator("table")).toBeVisible();
    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sylvan Library" }).first()).toBeVisible({ timeout: 10000 });

    // Switch to seat 2 — its deck must NOT contain seat 1's added card.
    await selectSeat(page, 2);
    await closeSettings(page);
    await openDeckBuilder(page);
    await expect(page.getByRole("button", { name: "Sylvan Library" })).toHaveCount(0);
  });

  test("queue and pick buttons never appear in local mode", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await selectActiveDraft(page, "gamma");
    await selectSeat(page, 1);
    await closeSettings(page);

    await page.locator("tbody tr").filter({ hasText: "Land Tax" }).first().click();
    await expect(page.getByRole("button", { name: "Add to Deck Builder" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveCount(0);
  });
});
```

Adapt selectors to the helpers' actual behavior if a step fails (e.g. how `openDeckBuilder`/`selectSeat` locate their targets — see `e2e/flows/spectator.spec.ts` and `e2e/helpers/assertions.ts`). If seat switching while the deck builder is open behaves differently (the modal may close on seat change), close and reopen the builder around `selectSeat(page, 2)`.

- [ ] **Step 3: Run the new e2e spec**

Run: `pnpm test:e2e -- sheet-draft-deck-builder` (or `npx playwright test e2e/flows/sheet-draft-deck-builder.spec.ts`)
Expected: PASS. Debug with `--headed` / trace output if selectors need adjusting.

- [ ] **Step 4: Update CLAUDE.md**

In `CLAUDE.md` → Key Features, replace the Deck builder bullet with:

```markdown
- **Deck builder:** Per-seat deck building panel with drag-and-drop, maindeck/sideboard zones, save status indicator, and shareable deck snapshots via `/api/deck`. Live drafts persist WIP decks server-side (seat token auth); sheet drafts persist locally in the browser (localStorage, keyed by draft + seat) with an "Add to Deck Builder" button replacing Float.
```

- [ ] **Step 5: Full verification**

Run: `pnpm precommit`
Expected: typecheck, lint, knip, unit tests, and e2e all green. Fix anything that fails before committing (knip may flag unused exports if a helper ended up unreferenced — remove it rather than suppressing).

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/dev/read-the-bones add e2e/helpers/mock-api.ts e2e/flows/sheet-draft-deck-builder.spec.ts CLAUDE.md
git -C /Users/arpanet/dev/read-the-bones commit -m "Add sheet-draft deck builder e2e coverage and docs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
