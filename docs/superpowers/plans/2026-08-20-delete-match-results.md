# Delete Match Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a seat in a live draft delete a match result it participated in, so a result entered against the wrong opponent can be removed rather than only overwritten.

**Architecture:** Mirror the existing report/correct path end-to-end. A new `deleteMatchResult` DB query backs a new `DELETE /api/drafts/[id]/match` handler with the same seat-token auth, phase gate, and seat normalization the `POST` handler uses. On the client, the existing single-slot optimistic overlay (`pendingMatch`) is generalized from "a record to merge in" to "a mutation to apply" — either a report or a deletion — so a deleted row does not flicker back when an in-flight standings fetch returns pre-delete data. The UI adds an explicit clear (✕) control inside the existing inline cell editor.

**Tech Stack:** Next.js App Router route handlers, libsql (Turso) client, Zustand stores, React 19 + Tailwind, Vitest (unit), Playwright (e2e).

**Spec:** Inline — see "Spec" below. (Verbal report: a user could not delete a match entered in the wrong slot; matches are already editable, deletion should be possible too.)

## Spec

1. A seat participating in a match can delete that match's result during the `playing` and `complete` phases — the same phases in which the result can already be reported or corrected.
2. Either participant may delete, matching the existing `POST` behaviour where either participant may overwrite the pair's result (`INSERT OR REPLACE` keyed on `(draft_id, seat1, seat2)`).
3. Deleting removes the `match_events` row entirely, so standings, tiebreakers, and `matchCount` all recompute as if the match was never reported.
4. Deletion is reachable from the match matrix cell the user already clicks to edit, and cannot be triggered by an accidental blur.
5. The deletion is reflected immediately in the matrix and is not resurrected by a standings response that predates it.

## Global Constraints

- **No `cd` in Bash git commands.** Always `git -C /Users/arpanet/code/read-the-bones <cmd>`.
- **Seat normalization is `seat1 = min(mySeat, opponentSeat)`, `seat2 = max(...)`** everywhere a `match_events` row is addressed. Never write a row or a pending mutation with `seat1 > seat2`.
- **Phase gate for match mutations:** `playing` and `complete` only. Any other phase → HTTP 400 with `Cannot delete matches in '<phase>' phase`.
- **Auth:** every mutation goes through `authenticateSeat(client, request, draftId)` from `@/core/tokenAuth`, and every route handler is wrapped in `withApiErrors` from `@/app/api/_lib/withApiErrors` (it maps `AuthError` → 401).
- **Test commands:** unit `pnpm test`, single file `pnpm vitest run <path>`, e2e `pnpm test:e2e`, full gate `pnpm precommit` (typecheck + lint + knip + test + e2e).
- **Do not touch the sheet-sync path** (`src/core/db/sync/**`). Live drafts never take their phase or match rows from the sheet syncer, so deletion has no interaction with it.
- Comments explain non-obvious decisions only, and must make sense to a reader six months from now with no knowledge of this change.

---

### Task 1: `deleteMatchResult` query

**Files:**
- Modify: `src/core/db/queries/matches.ts` (append after `reportMatchResult`, currently the last export in the file)
- Test: `src/core/db/queries/matches.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `deleteMatchResult(client: Client, draftId: string, seat1: number, seat2: number): Promise<boolean>` — resolves `true` when a row was removed, `false` when the pairing had no stored result. Re-exported automatically by `src/core/db/queries/index.ts` (`export * from "./matches"`).

- [ ] **Step 1: Write the failing tests**

Append to `src/core/db/queries/matches.test.ts`. Note the file already has a module-level `createMockClient()` helper — reuse it, do not redefine it. Add `deleteMatchResult` to the existing import list at the top of the file.

```ts
describe("deleteMatchResult", () => {
  let client: ReturnType<typeof createMockClient>;
  beforeEach(() => {
    client = createMockClient();
  });

  it("deletes the row for the normalized seat pairing", async () => {
    client.execute.mockResolvedValueOnce({ rowsAffected: 1 });

    const removed = await deleteMatchResult(client, "draft-1", 1, 3);

    expect(removed).toBe(true);
    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining("DELETE FROM match_events"),
        args: ["draft-1", 1, 3],
      })
    );
  });

  it("returns false when the pairing had no stored result", async () => {
    client.execute.mockResolvedValueOnce({ rowsAffected: 0 });

    const removed = await deleteMatchResult(client, "draft-1", 2, 5);

    expect(removed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/core/db/queries/matches.test.ts`
Expected: FAIL — `deleteMatchResult is not a function` / TypeScript error that `deleteMatchResult` is not exported from `./matches`.

- [ ] **Step 3: Write the implementation**

Append to `src/core/db/queries/matches.ts`:

```ts
/**
 * Delete a reported match result between two seats.
 * seat1 must be less than seat2 (caller normalizes).
 *
 * Returns true when a row was removed, false when the pairing had no result —
 * concurrent deletes from two devices make "already gone" an expected outcome
 * rather than an error.
 */
export async function deleteMatchResult(
  client: Client,
  draftId: string,
  seat1: number,
  seat2: number
): Promise<boolean> {
  const result = await client.execute({
    sql: "DELETE FROM match_events WHERE draft_id = ? AND seat1 = ? AND seat2 = ?",
    args: [draftId, seat1, seat2],
  });
  return result.rowsAffected > 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/core/db/queries/matches.test.ts`
Expected: PASS, including the pre-existing `getMatchCount` / `reportMatchResult` / `aggregateMatchRecords` / `computeTiebreakers` suites.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/core/db/queries/matches.ts src/core/db/queries/matches.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "feat: add deleteMatchResult query

Match corrections can only overwrite a result today, so a result entered
against the wrong opponent has no way to be removed."
```

---

### Task 2: `DELETE /api/drafts/[id]/match` route

**Files:**
- Modify: `src/app/api/drafts/[id]/match/route.ts` (add a `DELETE` export below the existing `POST`)
- Test: `src/app/api/drafts/[id]/match/route.test.ts`

**Interfaces:**
- Consumes: `deleteMatchResult` from Task 1.
- Produces: `DELETE /api/drafts/[id]/match` with request body `{ opponent_seat: number }`, header `X-Seat-Token`. Success → `200 { success: true, seat1, seat2, deleted: boolean }`. This is the endpoint Task 4's store action calls.

**Design note (deliberate):** a delete of a pairing with no stored result returns `200` with `deleted: false`, not `404`. Two people can hold the same draft board open; the second delete to land is a no-op that already produced the state the user asked for, and surfacing it as an error would be noise. The client treats any `2xx` as success and refetches standings.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/drafts/[id]/match/route.test.ts`. The file already mocks `@/core/db/client`, `@/core/tokenAuth`, and `@/core/db/queries/matches`, and defines `mockExecute`, `mockAuthenticateSeat`, `mockReportMatchResult`, `makeRequest(body, token)`, and `mockDraft(phase, numSeats)`. Three edits are needed:

1. Extend the top-level import to `import { POST, DELETE } from "./route";`
2. Add a `deleteMatchResult` mock alongside the existing one. Replace the existing `vi.mock("@/core/db/queries/matches", ...)` block with:

```ts
const mockReportMatchResult = vi.fn();
const mockDeleteMatchResult = vi.fn();
vi.mock("@/core/db/queries/matches", () => ({
  reportMatchResult: (...args: unknown[]) => mockReportMatchResult(...args),
  deleteMatchResult: (...args: unknown[]) => mockDeleteMatchResult(...args),
}));
```

3. Add a request builder for DELETE next to `makeRequest`:

```ts
function makeDeleteRequest(body: Record<string, unknown>, token = "test-token") {
  return new NextRequest(new URL("http://localhost:3000/api/drafts/test/match"), {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Seat-Token": token } : {}),
    },
    body: JSON.stringify(body),
  });
}
```

Then append the suite:

```ts
describe("DELETE /api/drafts/[id]/match", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the match using normalized seats", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockDraft("playing");
    mockDeleteMatchResult.mockResolvedValueOnce(true);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 1 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, seat1: 1, seat2: 3, deleted: true });
    expect(mockDeleteMatchResult).toHaveBeenCalledWith(expect.anything(), "test", 1, 3);
  });

  it("allows deletion in the complete phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 2, autoPick: false });
    mockDraft("complete");
    mockDeleteMatchResult.mockResolvedValueOnce(true);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 5 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(200);
    expect(mockDeleteMatchResult).toHaveBeenCalledWith(expect.anything(), "test", 2, 5);
  });

  it("reports deleted:false when the pairing had no result", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 3, autoPick: false });
    mockDraft("playing");
    mockDeleteMatchResult.mockResolvedValueOnce(false);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 4 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.deleted).toBe(false);
  });

  it("returns 401 without token", async () => {
    mockAuthenticateSeat.mockRejectedValueOnce(new AuthError("Missing seat token"));

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 1 }, ""), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(401);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat is missing", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await DELETE(makeDeleteRequest({}), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat is not an integer", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2.5 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when deleting a match against yourself", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 4, autoPick: false });

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 4 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 404 when the draft does not exist", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft(null);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns 400 in a non-playing phase", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("drafting");

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 2 }), {
      params: Promise.resolve({ id: "test" }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("drafting");
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });

  it("returns 400 when opponent_seat exceeds the pod size", async () => {
    mockAuthenticateSeat.mockResolvedValueOnce({ seat: 1, autoPick: false });
    mockDraft("playing", 8);

    const res = await DELETE(makeDeleteRequest({ opponent_seat: 9 }), {
      params: Promise.resolve({ id: "test" }),
    });

    expect(res.status).toBe(400);
    expect(mockDeleteMatchResult).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run "src/app/api/drafts/[id]/match/route.test.ts"`
Expected: FAIL — `DELETE is not a function` (no `DELETE` export in `./route`).

- [ ] **Step 3: Write the implementation**

In `src/app/api/drafts/[id]/match/route.ts`, extend the `@/core/db/queries/matches` import to include `deleteMatchResult`, then append below the existing `POST` export:

```ts
export const DELETE = withApiErrors(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id: draftId } = await params;
    const client = await getClient();
    const { seat: mySeat } = await authenticateSeat(client, request, draftId);

    const body = await request.json();
    const { opponent_seat } = body;
    if (opponent_seat == null) {
      return NextResponse.json({ error: "opponent_seat required" }, { status: 400 });
    }
    if (!Number.isInteger(opponent_seat)) {
      return NextResponse.json({ error: "opponent_seat must be an integer" }, { status: 400 });
    }
    if (opponent_seat < 1) {
      return NextResponse.json({ error: "opponent_seat must be >= 1" }, { status: 400 });
    }
    if (opponent_seat === mySeat) {
      return NextResponse.json(
        { error: "Cannot delete a match against yourself" },
        { status: 400 }
      );
    }

    const meta = await getDraftMeta(client, draftId);
    if (!meta) {
      return NextResponse.json({ error: "Draft not found" }, { status: 404 });
    }
    const { phase, numSeats } = meta;
    if (phase !== "playing" && phase !== "complete") {
      return NextResponse.json(
        { error: `Cannot delete matches in '${phase}' phase` },
        { status: 400 }
      );
    }
    if (opponent_seat > numSeats) {
      return NextResponse.json({ error: `opponent_seat must be <= ${numSeats}` }, { status: 400 });
    }

    const seat1 = Math.min(mySeat, opponent_seat);
    const seat2 = Math.max(mySeat, opponent_seat);

    // Either participant may delete, mirroring the report path where either
    // participant may overwrite the pair's result.
    const deleted = await deleteMatchResult(client, draftId, seat1, seat2);

    return NextResponse.json({ success: true, seat1, seat2, deleted });
  },
  "[/api/drafts/[id]/match] DELETE Error:"
);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run "src/app/api/drafts/[id]/match/route.test.ts"`
Expected: PASS — both the pre-existing `POST` suite and the new `DELETE` suite.

Then run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add "src/app/api/drafts/[id]/match/route.ts" "src/app/api/drafts/[id]/match/route.test.ts"
git -C /Users/arpanet/code/read-the-bones commit -m "feat: add DELETE handler for match results

Same auth, phase gate, and seat normalization as reporting; a delete of an
already-absent pairing succeeds with deleted:false so concurrent deletes from
two devices don't surface as errors."
```

---

### Task 3: Generalize the optimistic overlay to report-or-delete

**Files:**
- Modify: `src/app/stores/draftStore.ts:18` (`MatchRecord`), `:116-124` (state fields), `:240-276` (helpers), `:546-558` (`fetchStandings`)
- Modify: `src/app/stores/live/picking.ts:183-231` (`makeReportMatch` — construct the new pending shape)
- Test: `src/app/stores/draftStore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure client-side).
- Produces, all from `src/app/stores/draftStore.ts`:
  - `export type PendingMatchMutation = { kind: "report"; record: MatchRecord } | { kind: "delete"; seat1: number; seat2: number }`
  - `export function mergePendingMatch(matches: MatchRecord[], pending: PendingMatchMutation | null): MatchRecord[]`
  - Store field `pendingMatch: PendingMatchMutation | null` (was `MatchRecord | null`)
  - Task 4 builds both variants of `PendingMatchMutation` and calls `mergePendingMatch`.

**Why:** `standingsMatches` is overwritten wholesale by every `fetchStandings`. A 10-second poll fetch can be in flight when the DELETE lands; its response still contains the deleted row and would resurrect it in the matrix until the next poll. `pendingMatch` already exists to hold a reported result visible across such a response — it just needs to be able to express "removed" as well as "set to this".

- [ ] **Step 1: Write the failing tests**

Append to `src/app/stores/draftStore.test.ts`. Add `mergePendingMatch` and `type PendingMatchMutation` to the existing import from `./draftStore`.

```ts
describe("mergePendingMatch", () => {
  const existing = [
    { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 1 },
    { seat1: 2, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
  ];

  it("returns matches unchanged when there is no pending mutation", () => {
    expect(mergePendingMatch(existing, null)).toEqual(existing);
  });

  it("appends a report for a pairing with no existing result", () => {
    const pending: PendingMatchMutation = {
      kind: "report",
      record: { seat1: 3, seat2: 4, seat1Wins: 2, seat2Wins: 0 },
    };

    expect(mergePendingMatch(existing, pending)).toEqual([...existing, pending.record]);
  });

  it("replaces the existing result when a report corrects a pairing", () => {
    const pending: PendingMatchMutation = {
      kind: "report",
      record: { seat1: 1, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
    };

    expect(mergePendingMatch(existing, pending)).toEqual([pending.record, existing[1]]);
  });

  it("removes the pairing for a pending deletion", () => {
    const pending: PendingMatchMutation = { kind: "delete", seat1: 1, seat2: 3 };

    expect(mergePendingMatch(existing, pending)).toEqual([existing[1]]);
  });

  it("removes the pairing for a pending deletion regardless of seat order", () => {
    const pending: PendingMatchMutation = { kind: "delete", seat1: 3, seat2: 1 };

    expect(mergePendingMatch(existing, pending)).toEqual([existing[1]]);
  });

  it("leaves matches unchanged when a pending deletion's pairing is already gone", () => {
    const pending: PendingMatchMutation = { kind: "delete", seat1: 5, seat2: 6 };

    expect(mergePendingMatch(existing, pending)).toEqual(existing);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/stores/draftStore.test.ts`
Expected: FAIL — `PendingMatchMutation` is not exported; the deletion cases fail against the current record-only `mergePendingMatch`.

- [ ] **Step 3: Write the implementation**

3a. In `src/app/stores/draftStore.ts`, add the type next to `MatchRecord` (around line 18):

```ts
/**
 * An optimistic match change awaiting server confirmation. `fetchStandings`
 * replaces `standingsMatches` wholesale, and a response can predate the change
 * (stale CDN body, out-of-order concurrent fetch) — so the change is re-applied
 * to every response until one already reflects it.
 */
export type PendingMatchMutation =
  | { kind: "report"; record: MatchRecord }
  | { kind: "delete"; seat1: number; seat2: number };
```

3b. Change the state field declaration (currently `pendingMatch: MatchRecord | null;` at ~line 124) to:

```ts
  pendingMatch: PendingMatchMutation | null;
```

Update the doc comment above it so it reads:

```ts
  // Optimistic overlay for a match report or deletion awaiting confirmation.
  // Standings responses can predate the change (CDN-cached body, out-of-order
  // concurrent fetch); the change is kept applied to standingsMatches until a
  // response actually reflects it. Set by liveStore's reportMatch/deleteMatch;
  // cleared by fetchStandings on confirmation, by those actions on failure, and
  // on draft switch.
```

3c. Replace the helpers block (`isSamePairing` / `containsMatchRecord` / `mergePendingMatch`, ~lines 243-276) with:

```ts
interface SeatPairing {
  seat1: number;
  seat2: number;
}

function isSamePairing(a: SeatPairing, b: SeatPairing): boolean {
  return (
    (a.seat1 === b.seat1 && a.seat2 === b.seat2) || (a.seat1 === b.seat2 && a.seat2 === b.seat1)
  );
}

/** True when `matches` contains a record equal to `record` (either seat order). */
function containsMatchRecord(matches: MatchRecord[], record: MatchRecord): boolean {
  return matches.some(
    (m) =>
      isSamePairing(m, record) &&
      (m.seat1 === record.seat1
        ? m.seat1Wins === record.seat1Wins && m.seat2Wins === record.seat2Wins
        : m.seat1Wins === record.seat2Wins && m.seat2Wins === record.seat1Wins)
  );
}

/**
 * True when a fetched matches array already reflects the pending mutation —
 * the reported record is present, or the deleted pairing is absent.
 */
export function isPendingMatchApplied(
  matches: MatchRecord[],
  pending: PendingMatchMutation
): boolean {
  return pending.kind === "report"
    ? containsMatchRecord(matches, pending.record)
    : !matches.some((m) => isSamePairing(m, pending));
}

/**
 * Apply the optimistic pending mutation to a fetched matches array: a reported
 * record replaces an existing record for the same seat pairing (correction) or
 * is appended (new report); a deletion drops the pairing. Returns `matches`
 * unchanged when there is no pending mutation.
 */
export function mergePendingMatch(
  matches: MatchRecord[],
  pending: PendingMatchMutation | null
): MatchRecord[] {
  if (!pending) return matches;
  if (pending.kind === "delete") {
    return matches.filter((m) => !isSamePairing(m, pending));
  }
  const index = matches.findIndex((m) => isSamePairing(m, pending.record));
  if (index === -1) return [...matches, pending.record];
  const merged = matches.slice();
  merged[index] = pending.record;
  return merged;
}
```

3d. In `fetchStandings` (~line 549), swap the confirmation check to the new helper. The block becomes:

```ts
          if (Array.isArray(data.matches)) {
            const fetched = data.matches as MatchRecord[];
            const pending = get().pendingMatch;
            if (pending && isPendingMatchApplied(fetched, pending)) {
              // Server data now reflects the optimistic change — drop the
              // overlay and show server truth as-is.
              set({ standingsMatches: fetched, pendingMatch: null });
            } else {
              // Keep the change visible even when this response predates it
              // (stale CDN-cached body or out-of-order fetch).
              set({ standingsMatches: mergePendingMatch(fetched, pending) });
            }
          }
```

3e. In `src/app/stores/live/picking.ts`, `makeReportMatch` currently does `const pending = mySeat !== null ? toMatchRecord(mySeat, params) : null;` and stores it directly. Wrap it in the new shape:

```ts
    const pending: PendingMatchMutation | null =
      mySeat !== null ? { kind: "report", record: toMatchRecord(mySeat, params) } : null;
```

and extend the import at the top of the file to:

```ts
import {
  useDraftStore,
  mergePendingMatch,
  type MatchRecord,
  type PendingMatchMutation,
} from "../draftStore";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/stores/draftStore.test.ts src/app/stores/liveStore.test.ts`
Expected: PASS. The four pre-existing `liveStore.test.ts` assertions on `pendingMatch` all assert `toBeNull()`, so they are unaffected by the shape change.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/stores/draftStore.ts src/app/stores/draftStore.test.ts src/app/stores/live/picking.ts
git -C /Users/arpanet/code/read-the-bones commit -m "refactor: let the pending match overlay express a deletion

A standings fetch in flight when a mutation lands returns pre-mutation data;
the overlay that already keeps a reported result visible across such a response
now needs to keep a deleted result hidden too."
```

---

### Task 4: `deleteMatch` store action

**Files:**
- Modify: `src/app/stores/live/picking.ts:170-231` (extract shared mutation machinery, add `makeDeleteMatch`)
- Modify: `src/app/stores/liveStore.ts:34-50` (imports/exports), `:121` (interface), `:220` (store wiring)
- Test: `src/app/stores/liveStore.test.ts`

**Interfaces:**
- Consumes: `DELETE /api/drafts/[id]/match` (Task 2); `PendingMatchMutation` and `mergePendingMatch` (Task 3).
- Produces: `useLiveStore` action `deleteMatch: (opponentSeat: number) => Promise<string | null>` — resolves `null` on success or an error message string on failure. Task 5's UI calls it.

**Note on the extraction:** `makeReportMatch` and `makeDeleteMatch` differ only in HTTP method, request body, and the pending mutation they build; everything else (auth guard, overlay, revert-on-failure, refetch) is identical. Copying ~35 lines for the second one is the duplication this codebase asks you to notice, so the shared body moves into one private helper.

- [ ] **Step 1: Write the failing tests**

Append to `src/app/stores/liveStore.test.ts`, following the conventions already used by the `reportMatch` suites in that file (around line 3640) for setting up `useDraftStore`/`useLiveStore` state and stubbing `global.fetch`. Match the surrounding suites' existing setup helpers rather than inventing new ones.

```ts
describe("deleteMatch", () => {
  beforeEach(() => {
    useDraftStore.setState({
      activeDraft: "gamma",
      standingsMatches: [
        { seat1: 1, seat2: 3, seat1Wins: 2, seat2Wins: 1 },
        { seat1: 2, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
      ],
      pendingMatch: null,
    });
    useLiveStore.setState({ seatToken: "tok", mySeat: 3 });
  });

  it("sends DELETE with the opponent seat and the seat token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, deleted: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const err = await useLiveStore.getState().deleteMatch(1);

    expect(err).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/drafts/gamma/match");
    expect(init.method).toBe("DELETE");
    expect(init.headers["X-Seat-Token"]).toBe("tok");
    expect(JSON.parse(init.body)).toEqual({ opponent_seat: 1 });
  });

  it("removes the pairing from standingsMatches optimistically", async () => {
    // Never resolves, so the assertion observes state before any refetch.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    void useLiveStore.getState().deleteMatch(1);

    await vi.waitFor(() => {
      expect(useDraftStore.getState().standingsMatches).toEqual([
        { seat1: 2, seat2: 3, seat1Wins: 0, seat2Wins: 2 },
      ]);
    });
    expect(useDraftStore.getState().pendingMatch).toEqual({ kind: "delete", seat1: 1, seat2: 3 });
  });

  it("returns the server error message and clears the overlay on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "Cannot delete matches in 'drafting' phase" }),
      })
    );

    const err = await useLiveStore.getState().deleteMatch(1);

    expect(err).toBe("Cannot delete matches in 'drafting' phase");
    expect(useDraftStore.getState().pendingMatch).toBeNull();
  });

  it("returns an error when not authenticated", async () => {
    useLiveStore.setState({ seatToken: null });

    const err = await useLiveStore.getState().deleteMatch(1);

    expect(err).toBe("Not authenticated");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts`
Expected: FAIL — `useLiveStore.getState().deleteMatch is not a function`.

- [ ] **Step 3: Write the implementation**

4a. In `src/app/stores/live/picking.ts`, replace the body of `makeReportMatch` (lines ~170-231, keeping `MatchReportParams` and `toMatchRecord` as they are) with the shared helper plus both factories:

```ts
/**
 * Shared machinery for the two match mutations. The change is merged into
 * standingsMatches (as pendingMatch) before the request so the matrix shows it
 * continuously; on failure the overlay is reverted via a refetch. Token
 * plumbing follows the same pattern as handlePick and the queueFloat mutations —
 * seatToken from get(), activeDraft from draftStore.
 *
 * Returns an error message string on failure, or null on success.
 */
async function sendMatchMutation(
  get: GetState,
  method: "POST" | "DELETE",
  body: Record<string, unknown>,
  buildPending: (mySeat: number) => PendingMatchMutation
): Promise<string | null> {
  const { seatToken, mySeat } = get();
  const activeDraft = useDraftStore.getState().activeDraft;
  if (!seatToken || !activeDraft) return "Not authenticated";

  const pending = mySeat !== null ? buildPending(mySeat) : null;
  if (pending) {
    useDraftStore.setState((s) => ({
      pendingMatch: pending,
      standingsMatches: mergePendingMatch(s.standingsMatches, pending),
    }));
  }

  const revertOptimistic = async (): Promise<void> => {
    if (!pending) return;
    useDraftStore.setState({ pendingMatch: null });
    await useDraftStore.getState().fetchStandings();
  };

  try {
    const res = await fetch(`/api/drafts/${activeDraft}/match`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Seat-Token": seatToken,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Request failed" }));
      await revertOptimistic();
      return (data.error as string | undefined) ?? `HTTP ${res.status}`;
    }

    await useDraftStore.getState().fetchStandings();
    return null;
  } catch (err) {
    await revertOptimistic();
    return err instanceof Error ? err.message : "Unknown error";
  }
}

/** Reports (or corrects) a match result via POST /api/drafts/[id]/match. */
export function makeReportMatch(get: GetState) {
  return (params: MatchReportParams): Promise<string | null> =>
    sendMatchMutation(
      get,
      "POST",
      {
        opponent_seat: params.opponentSeat,
        wins: params.wins,
        losses: params.losses,
      },
      (mySeat) => ({ kind: "report", record: toMatchRecord(mySeat, params) })
    );
}

/** Deletes a reported match result via DELETE /api/drafts/[id]/match. */
export function makeDeleteMatch(get: GetState) {
  return (opponentSeat: number): Promise<string | null> =>
    sendMatchMutation(get, "DELETE", { opponent_seat: opponentSeat }, (mySeat) => ({
      kind: "delete",
      seat1: Math.min(mySeat, opponentSeat),
      seat2: Math.max(mySeat, opponentSeat),
    }));
}
```

4b. In `src/app/stores/liveStore.ts`:
- Extend the import from `./live/picking` (line ~34) to include `makeDeleteMatch` alongside `makeReportMatch`.
- Add to the store interface, next to `reportMatch` (line ~121):

```ts
  deleteMatch: (opponentSeat: number) => Promise<string | null>;
```

- Add to the store body, next to `reportMatch: makeReportMatch(get),` (line ~220):

```ts
      deleteMatch: makeDeleteMatch(get),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/stores/liveStore.test.ts src/app/stores/draftStore.test.ts`
Expected: PASS — including all pre-existing `reportMatch` suites, which must still pass unchanged after the extraction.

Run: `pnpm typecheck && pnpm lint`
Expected: no errors, no warnings.

- [ ] **Step 5: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/stores/live/picking.ts src/app/stores/liveStore.ts src/app/stores/liveStore.test.ts
git -C /Users/arpanet/code/read-the-bones commit -m "feat: add deleteMatch store action

Report and delete differ only in method, body, and pending shape, so the
optimistic-overlay-and-revert machinery is shared rather than copied."
```

---

### Task 5: Clear control in the match matrix cell editor

**Files:**
- Modify: `src/app/components/draft-board/MatchMatrix.tsx` (props, delete handler, editor markup, key handling)
- Modify: `src/app/components/draft-board/StandingsSection.tsx:213-222` (pass the new prop)
- Test: `e2e/flows/match-matrix.spec.ts`

**Interfaces:**
- Consumes: `useLiveStore` action `deleteMatch(opponentSeat: number): Promise<string | null>` (Task 4).
- Produces: `MatchMatrixProps.onDeleteMatch: (opponentSeat: number) => Promise<string | null>`; a delete button with `data-testid="match-delete"`.

**Interaction design:**
- The clear control appears **only** while editing a cell that already has a stored result — it is never a standalone always-visible button, so reaching it requires two deliberate acts (click the cell, click ✕).
- Blur with an empty input keeps its current meaning: **cancel**, not delete. An accidental click-away must never destroy data.
- Pressing Enter on an emptied input for a cell that has a stored result also deletes, so the keyboard path doesn't require reaching for the mouse.
- No confirmation dialog: the user's complaint is friction removing a mis-entered result, and re-entering a deleted result is a two-keystroke undo.
- **The ✕ button must call `preventDefault()` on `mousedown`.** Without it, clicking the button blurs the input first, `handleBlur` fires with the non-empty pre-filled value (e.g. `"2-1"`), and the component re-saves the very match the click was meant to delete.

- [ ] **Step 1: Write the failing e2e tests**

Append to the `test.describe("Match matrix and standings", ...)` block in `e2e/flows/match-matrix.spec.ts`. The fixture's own seat is 3 (Alice); the seeded matches include `{ seat1: 2, seat2: 3, seat1Wins: 1, seat2Wins: 2 }`, so cell `3-2` is an own-row cell with a stored result.

```ts
  test("clear button deletes a reported match", async ({ page }) => {
    let deleteBody: unknown = null;
    await page.unroute("**/api/drafts/*/match*");
    await page.route("**/api/drafts/*/match*", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, seat1: 2, seat2: 3, deleted: true }),
        });
      } else {
        await route.fulfill({ status: 404 });
      }
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Alice (seat 3) beat Carol (seat 2) 2-1 — her own row's cell has a result
    const cell = page.locator('[data-testid="match-cell-3-2"]');
    await expect(cell).toContainText("2-1");
    await cell.click();

    const clearButton = page.locator('[data-testid="match-delete"]');
    await expect(clearButton).toBeVisible();
    await clearButton.click();

    await expect(async () => {
      expect(deleteBody).toEqual({ opponent_seat: 2 });
    }).toPass({ timeout: 3000 });

    // The pending-deletion overlay keeps the cell empty even though the mocked
    // standings response still contains the match.
    await expect(cell).not.toContainText("2-1");
  });

  test("clear button is absent for a cell with no result", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    // Alice (seat 3) vs Dave (seat 4) — unplayed
    await page.locator('[data-testid="match-cell-3-4"]').click();
    await expect(page.locator('[data-testid="match-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="match-delete"]')).toHaveCount(0);
  });

  test("clearing the input and pressing Enter deletes the match", async ({ page }) => {
    let deleteBody: unknown = null;
    await page.unroute("**/api/drafts/*/match*");
    await page.route("**/api/drafts/*/match*", async (route) => {
      if (route.request().method() === "DELETE") {
        deleteBody = JSON.parse(route.request().postData() ?? "{}");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, seat1: 2, seat2: 3, deleted: true }),
        });
      } else {
        await route.fulfill({ status: 404 });
      }
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    await page.locator('[data-testid="match-cell-3-2"]').click();
    const input = page.locator('[data-testid="match-input"]');
    await input.fill("");
    await input.press("Enter");

    await expect(async () => {
      expect(deleteBody).toEqual({ opponent_seat: 2 });
    }).toPass({ timeout: 3000 });
  });

  test("blurring an emptied cell cancels without deleting", async ({ page }) => {
    let sawDelete = false;
    await page.unroute("**/api/drafts/*/match*");
    await page.route("**/api/drafts/*/match*", async (route) => {
      if (route.request().method() === "DELETE") sawDelete = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();
    await openDraftBoard(page);

    const cell = page.locator('[data-testid="match-cell-3-2"]');
    await cell.click();
    const input = page.locator('[data-testid="match-input"]');
    await input.fill("");
    await input.blur();

    await expect(input).not.toBeVisible();
    await expect(cell).toContainText("2-1");
    expect(sawDelete).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:e2e e2e/flows/match-matrix.spec.ts`
Expected: FAIL — no element with `data-testid="match-delete"`; the Enter-on-empty test never issues a DELETE.

- [ ] **Step 3: Write the implementation**

5a. In `src/app/components/draft-board/MatchMatrix.tsx`, add to `MatchMatrixProps` right after `onReportMatch`:

```ts
  /**
   * Store action that DELETEs the match result and refreshes standings.
   * Returns an error message string on failure, or null on success.
   */
  onDeleteMatch: (opponentSeat: number) => Promise<string | null>;
```

and add `onDeleteMatch` to the destructured parameter list of `MatchMatrix`.

5b. Add a delete handler below `saveResult`:

```ts
  const deleteResult = useCallback(
    async (state: EditingState) => {
      setEditing((prev) => (prev ? { ...prev, saving: true, error: null } : null));

      // The store action applies its own optimistic removal and reverts on
      // failure, so there is nothing to undo here beyond reopening the editor.
      const errorMsg = await onDeleteMatch(state.col);

      if (errorMsg === null) {
        setEditing(null);
      } else {
        setEditing((prev) => (prev ? { ...prev, saving: false, error: errorMsg } : null));
      }
    },
    [onDeleteMatch]
  );
```

5c. Replace `handleKeyDown` so Enter on an emptied cell that has a stored result deletes instead of failing validation:

```ts
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        cancelEditing();
        return;
      }
      if (e.key !== "Enter" || !editing || editing.saving) return;

      const hasStoredResult = findMatch(matches, editing.row, editing.col) !== null;
      if (editing.value.trim() === "" && hasStoredResult) {
        deleteResult(editing);
      } else {
        saveResult(editing);
      }
    },
    [editing, matches, cancelEditing, saveResult, deleteResult]
  );
```

`handleBlur` is unchanged: an empty value still cancels, so clicking away never deletes.

5d. In the `isEditing` cell branch, wrap the input and add the button. Replace the `<div className="flex flex-col items-center">` block's contents with:

```tsx
                        <div className="flex flex-col items-center">
                          <div className="flex items-center gap-0.5">
                            <input
                              ref={inputRef}
                              data-testid="match-input"
                              type="text"
                              value={editing.value}
                              onChange={(e) =>
                                setEditing((prev) =>
                                  prev ? { ...prev, value: e.target.value, error: null } : null
                                )
                              }
                              onKeyDown={handleKeyDown}
                              onBlur={handleBlur}
                              disabled={editing.saving}
                              className="w-10 rounded border border-zinc-500 bg-zinc-800 px-0.5 py-0.5 text-center text-[11px] text-zinc-200 focus:border-blue-500 focus:outline-none"
                              placeholder="W-L"
                            />
                            {findMatch(matches, editing.row, editing.col) && (
                              <button
                                type="button"
                                data-testid="match-delete"
                                title="Delete this result"
                                aria-label="Delete this result"
                                disabled={editing.saving}
                                // Keep focus in the input: a blur here would fire
                                // handleBlur with the pre-filled value and re-save
                                // the result this click is meant to remove.
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => deleteResult(editing)}
                                className="rounded px-1 text-[11px] leading-none text-zinc-500 hover:bg-red-500/20 hover:text-red-400 disabled:opacity-50"
                              >
                                &times;
                              </button>
                            )}
                          </div>
                          {editing.error && (
                            <span className="mt-0.5 text-[9px] whitespace-nowrap text-red-500">
                              {editing.error}
                            </span>
                          )}
                        </div>
```

5e. In `src/app/components/draft-board/StandingsSection.tsx`, subscribe to the new action next to the existing `reportMatch` subscription:

```ts
  const deleteMatch = useLiveStore((s) => s.deleteMatch);
```

and pass it to the component in the `<MatchMatrix ... />` element (line ~213):

```tsx
            onDeleteMatch={deleteMatch}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:e2e e2e/flows/match-matrix.spec.ts`
Expected: PASS — the four new tests plus every pre-existing test in the file (matrix renders, colors, own-row highlight, editable affordance, inline editing flow, invalid input, escape cancels, OMW%/OGW%).

- [ ] **Step 5: Run the full gate**

Run: `pnpm precommit`
Expected: typecheck, lint (`--max-warnings 0`), knip, all unit tests, and all e2e tests pass. If knip flags `isPendingMatchApplied` as unused, confirm `fetchStandings` in `draftStore.ts` actually calls it (step 3d of Task 3).

- [ ] **Step 6: Commit**

```bash
git -C /Users/arpanet/code/read-the-bones add src/app/components/draft-board/MatchMatrix.tsx src/app/components/draft-board/StandingsSection.tsx e2e/flows/match-matrix.spec.ts
git -C /Users/arpanet/code/read-the-bones commit -m "feat: let a player delete their own match result

A result entered in the wrong slot could only be overwritten, never removed.
The clear control lives inside the cell editor rather than on the cell so it
takes two deliberate actions, and blur still means cancel."
```
